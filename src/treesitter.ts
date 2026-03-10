import type { SupportedLanguage } from './graph.js'

export interface CodeSymbol {
  name: string
  kind: 'function' | 'class' | 'method' | 'interface'
  filePath: string
  startLine: number
  endLine: number
  exported: boolean
}

export interface SymbolEdge {
  sourceName: string
  sourceFilePath: string
  targetName: string
  targetFilePath?: string
  edgeType: 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS'
  confidence: number
}

export type SymbolTable = Map<string, { filePath: string; kind: string }[]>

let treeSitterAvailable = false
let Parser: typeof import('tree-sitter').default | null = null
let TypeScriptLang: unknown = null
let JavaScriptLang: unknown = null
let PythonLang: unknown = null

async function initTreeSitter(): Promise<void> {
  try {
    // Skip build/Release/ (may contain wrong-platform binaries from npm rebuild in Docker)
    // and use prebuilds/{platform}-{arch}/ which ships correct binaries for all platforms
    process.env.PREBUILDS_ONLY = '1'
    const ts = await import('tree-sitter')
    Parser = ts.default
    
    const tsLang = await import('tree-sitter-typescript')
    const tsModule = (tsLang as { default: { typescript: unknown; tsx: unknown } }).default
    TypeScriptLang = tsModule.typescript
    JavaScriptLang = tsModule.tsx
    
    const pyLang = await import('tree-sitter-python')
    PythonLang = (pyLang as { default: unknown }).default
    
    treeSitterAvailable = true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[treesitter] Native bindings not available, symbol graph disabled: ${msg}`)
    treeSitterAvailable = false
  }
}

const initPromise = initTreeSitter()

export function isTreeSitterAvailable(): boolean {
  return treeSitterAvailable
}

export async function waitForInit(): Promise<void> {
  await initPromise
}

export async function parseToAST(code: string, language: 'ts' | 'js' | 'python'): Promise<TreeSitterNode | null> {
  await initPromise
  if (!treeSitterAvailable || !Parser) return null
  const lang = getLanguageParser(language)
  if (!lang) return null
  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(code)
    return tree.rootNode as unknown as TreeSitterNode
  } catch {
    return null
  }
}

function getLanguageParser(language: SupportedLanguage): unknown | null {
  switch (language) {
    case 'ts':
      return TypeScriptLang
    case 'js':
      return JavaScriptLang
    case 'python':
      return PythonLang
    default:
      return null
  }
}

function getNodeText(node: { text: string }): string {
  return node.text
}

function hasExportModifier(node: { parent?: { type: string; children?: Array<{ type: string }> } }): boolean {
  const parent = node.parent
  if (!parent) return false
  
  if (parent.type === 'export_statement') return true
  
  if (parent.type === 'lexical_declaration' || parent.type === 'variable_declaration') {
    const grandparent = parent.parent
    if (grandparent?.type === 'export_statement') return true
  }
  
  if (parent.children) {
    for (const child of parent.children) {
      if (child.type === 'export') return true
    }
  }
  
  return false
}

export interface TreeSitterNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  parent?: TreeSitterNode
  children?: TreeSitterNode[]
  childForFieldName?(name: string): TreeSitterNode | null
  namedChildren?: TreeSitterNode[]
}

function walkTree(node: TreeSitterNode, callback: (node: TreeSitterNode) => void): void {
  callback(node)
  if (node.children) {
    for (const child of node.children) {
      walkTree(child, callback)
    }
  }
}

function isInsideClass(node: TreeSitterNode): boolean {
  let current = node.parent
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class_definition' || current.type === 'class') {
      return true
    }
    current = current.parent
  }
  return false
}

function getEnclosingClassName(node: TreeSitterNode): string | null {
  let current = node.parent
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class_definition') {
      const nameNode = current.childForFieldName?.('name')
      if (nameNode) {
        return getNodeText(nameNode)
      }
    }
    current = current.parent
  }
  return null
}

function extractTsJsSymbols(rootNode: TreeSitterNode, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  
  walkTree(rootNode, (node) => {
    if (node.type === 'function_declaration') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        symbols.push({
          name: getNodeText(nameNode),
          kind: 'function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: hasExportModifier(node),
        })
      }
    }
    
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName?.('name')
      const valueNode = node.childForFieldName?.('value')
      if (nameNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function')) {
        const parent = node.parent
        const grandparent = parent?.parent
        const isExported = grandparent?.type === 'export_statement' || 
                          (parent?.parent?.type === 'export_statement')
        
        symbols.push({
          name: getNodeText(nameNode),
          kind: 'function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: isExported,
        })
      }
    }
    
    if (node.type === 'class_declaration') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        symbols.push({
          name: getNodeText(nameNode),
          kind: 'class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: hasExportModifier(node),
        })
      }
    }
    
    if (node.type === 'method_definition') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        const methodName = getNodeText(nameNode)
        const className = getEnclosingClassName(node)
        const qualifiedName = className ? `${className}.${methodName}` : methodName
        symbols.push({
          name: qualifiedName,
          kind: 'method',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: false,
        })
      }
    }
    
    if (node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        symbols.push({
          name: getNodeText(nameNode),
          kind: 'interface',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: hasExportModifier(node),
        })
      }
    }
  })
  
  return symbols
}

function extractPythonSymbols(rootNode: TreeSitterNode, filePath: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = []
  
  walkTree(rootNode, (node) => {
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        const baseName = getNodeText(nameNode)
        const insideClass = isInsideClass(node)
        const className = insideClass ? getEnclosingClassName(node) : null
        const name = className ? `${className}.${baseName}` : baseName
        
        symbols.push({
          name,
          kind: insideClass ? 'method' : 'function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: !baseName.startsWith('_'),
        })
      }
    }
    
    if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName?.('name')
      if (nameNode) {
        const name = getNodeText(nameNode)
        symbols.push({
          name,
          kind: 'class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          exported: !name.startsWith('_'),
        })
      }
    }
  })
  
  return symbols
}

export async function parseSymbols(
  filePath: string,
  content: string,
  language: SupportedLanguage
): Promise<CodeSymbol[]> {
  await initPromise
  
  if (!treeSitterAvailable || !Parser) {
    return []
  }
  
  const lang = getLanguageParser(language)
  if (!lang) {
    return []
  }
  
  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(content)
    const rootNode = tree.rootNode
    
    if ((parseSymbols as any)._dbgCount === undefined) (parseSymbols as any)._dbgCount = 0;
    if ((parseSymbols as any)._dbgCount++ < 3) {
      console.error(`[TS-DBG] file=${filePath.split('/').pop()} type=${rootNode.type} childCount=${rootNode.childCount} children=${rootNode.children?.length ?? 'NO'} hasChildForField=${typeof rootNode.childForFieldName}`)
    }
    
    const tsNode = rootNode as unknown as TreeSitterNode
    
    if (language === 'python') {
      return extractPythonSymbols(tsNode, filePath)
    } else {
      return extractTsJsSymbols(tsNode, filePath)
    }
  } catch (e) {
    console.warn(`[treesitter] Failed to parse ${filePath}:`, e)
    return []
  }
}

interface CallInfo {
  name: string
  line: number
  enclosingSymbol: string | null
  isMemberExpression: boolean
}

function findEnclosingSymbol(node: TreeSitterNode, language: SupportedLanguage): string | null {
  let current = node.parent
  while (current) {
    if (language === 'ts' || language === 'js') {
      if (current.type === 'function_declaration') {
        const nameNode = current.childForFieldName?.('name')
        if (nameNode) {
          return getNodeText(nameNode)
        }
      }
      if (current.type === 'method_definition') {
        const nameNode = current.childForFieldName?.('name')
        if (nameNode) {
          const methodName = getNodeText(nameNode)
          const className = getEnclosingClassName(current)
          return className ? `${className}.${methodName}` : methodName
        }
      }
      if (current.type === 'variable_declarator') {
        const nameNode = current.childForFieldName?.('name')
        const valueNode = current.childForFieldName?.('value')
        if (nameNode && valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function')) {
          return getNodeText(nameNode)
        }
      }
    }
    if (language === 'python') {
      if (current.type === 'function_definition') {
        const nameNode = current.childForFieldName?.('name')
        if (nameNode) {
          const funcName = getNodeText(nameNode)
          const className = getEnclosingClassName(current)
          return className ? `${className}.${funcName}` : funcName
        }
      }
    }
    current = current.parent
  }
  return null
}

function extractCallExpressions(rootNode: TreeSitterNode, language: SupportedLanguage): CallInfo[] {
  const calls: CallInfo[] = []
  
  walkTree(rootNode, (node) => {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName?.('function')
      if (funcNode) {
        let name: string | null = null
        let isMemberExpression = false
        
        if (funcNode.type === 'identifier') {
          name = getNodeText(funcNode)
        } else if (funcNode.type === 'member_expression') {
          const propNode = funcNode.childForFieldName?.('property')
          if (propNode) {
            name = getNodeText(propNode)
            isMemberExpression = true
          }
        } else if (funcNode.type === 'new_expression') {
          const constructorNode = funcNode.childForFieldName?.('constructor')
          if (constructorNode && constructorNode.type === 'identifier') {
            name = getNodeText(constructorNode)
          }
        }
        
        if (name) {
          const enclosingSymbol = findEnclosingSymbol(node, language)
          calls.push({ name, line: node.startPosition.row + 1, enclosingSymbol, isMemberExpression })
        }
      }
    }
    
    if ((language === 'ts' || language === 'js') && node.type === 'new_expression') {
      const constructorNode = node.childForFieldName?.('constructor')
      if (constructorNode && constructorNode.type === 'identifier') {
        const name = getNodeText(constructorNode)
        const enclosingSymbol = findEnclosingSymbol(node, language)
        calls.push({ name, line: node.startPosition.row + 1, enclosingSymbol, isMemberExpression: false })
      }
    }
    
    if (language === 'python' && node.type === 'call') {
      const funcNode = node.childForFieldName?.('function')
      if (funcNode) {
        let name: string | null = null
        let isMemberExpression = false
        
        if (funcNode.type === 'identifier') {
          name = getNodeText(funcNode)
        } else if (funcNode.type === 'attribute') {
          const attrNode = funcNode.childForFieldName?.('attribute')
          if (attrNode) {
            name = getNodeText(attrNode)
            isMemberExpression = true
          }
        }
        
        if (name) {
          const enclosingSymbol = findEnclosingSymbol(node, language)
          calls.push({ name, line: node.startPosition.row + 1, enclosingSymbol, isMemberExpression })
        }
      }
    }
  })
  
  return calls
}

function findQualifiedTarget(callName: string, isMemberExpression: boolean, symbolTable: SymbolTable, sourceFilePath: string): { name: string; filePath: string; confidence: number } | null {
  const directMatch = symbolTable.get(callName)
  if (directMatch && directMatch.length > 0) {
    const sameFileTarget = directMatch.find(t => t.filePath === sourceFilePath)
    if (sameFileTarget) {
      return { name: callName, filePath: sameFileTarget.filePath, confidence: 0.8 }
    }
    return { name: callName, filePath: directMatch[0].filePath, confidence: 1.0 }
  }
  
  if (isMemberExpression) {
    for (const [symbolName, entries] of symbolTable.entries()) {
      if (symbolName.endsWith(`.${callName}`)) {
        const sameFileTarget = entries.find(t => t.filePath === sourceFilePath)
        if (sameFileTarget) {
          return { name: symbolName, filePath: sameFileTarget.filePath, confidence: 0.8 }
        }
        return { name: symbolName, filePath: entries[0].filePath, confidence: 0.8 }
      }
    }
  }
  
  return null
}

export async function resolveCallEdges(
  filePath: string,
  content: string,
  language: SupportedLanguage,
  symbolTable: SymbolTable
): Promise<SymbolEdge[]> {
  await initPromise
  
  if (!treeSitterAvailable || !Parser) {
    return []
  }
  
  const lang = getLanguageParser(language)
  if (!lang) {
    return []
  }
  
  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(content)
    const rootNode = tree.rootNode as unknown as TreeSitterNode
    
    const calls = extractCallExpressions(rootNode, language)
    const edges: SymbolEdge[] = []
    const seenEdges = new Set<string>()
    
    for (const call of calls) {
      if (!call.enclosingSymbol) continue
      
      const edgeKey = `${call.enclosingSymbol}:${call.name}`
      if (seenEdges.has(edgeKey)) continue
      seenEdges.add(edgeKey)
      
      const target = findQualifiedTarget(call.name, call.isMemberExpression, symbolTable, filePath)
      
      if (target) {
        edges.push({
          sourceName: call.enclosingSymbol,
          sourceFilePath: filePath,
          targetName: target.name,
          targetFilePath: target.filePath,
          edgeType: 'CALLS',
          confidence: target.confidence,
        })
      } else {
        edges.push({
          sourceName: call.enclosingSymbol,
          sourceFilePath: filePath,
          targetName: call.name,
          targetFilePath: undefined,
          edgeType: 'CALLS',
          confidence: 0.6,
        })
      }
    }
    
    return edges
  } catch (e) {
    console.warn(`[treesitter] Failed to resolve call edges for ${filePath}:`, e)
    return []
  }
}

function extractHeritageInfo(rootNode: TreeSitterNode, language: SupportedLanguage): Array<{ className: string; baseName: string; type: 'EXTENDS' | 'IMPLEMENTS'; line: number }> {
  const heritage: Array<{ className: string; baseName: string; type: 'EXTENDS' | 'IMPLEMENTS'; line: number }> = []
  
  walkTree(rootNode, (node) => {
    if (language === 'ts' || language === 'js') {
      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName?.('name')
        const className = nameNode ? getNodeText(nameNode) : ''
        
        if (node.children) {
          for (const child of node.children) {
            if (child.type === 'class_heritage') {
              if (child.children) {
                for (const heritageChild of child.children) {
                  if (heritageChild.type === 'extends_clause') {
                    const typeNode = heritageChild.namedChildren?.[0]
                    if (typeNode) {
                      let baseName = ''
                      if (typeNode.type === 'identifier') {
                        baseName = getNodeText(typeNode)
                      } else if (typeNode.type === 'generic_type') {
                        const nameNode = typeNode.childForFieldName?.('name')
                        if (nameNode) {
                          baseName = getNodeText(nameNode)
                        }
                      }
                      if (baseName) {
                        heritage.push({
                          className,
                          baseName,
                          type: 'EXTENDS',
                          line: node.startPosition.row + 1,
                        })
                      }
                    }
                  }
                  
                  if (heritageChild.type === 'implements_clause') {
                    if (heritageChild.namedChildren) {
                      for (const implType of heritageChild.namedChildren) {
                        let baseName = ''
                        if (implType.type === 'identifier' || implType.type === 'type_identifier') {
                          baseName = getNodeText(implType)
                        } else if (implType.type === 'generic_type') {
                          const nameNode = implType.childForFieldName?.('name')
                          if (nameNode) {
                            baseName = getNodeText(nameNode)
                          }
                        }
                        if (baseName) {
                          heritage.push({
                            className,
                            baseName,
                            type: 'IMPLEMENTS',
                            line: node.startPosition.row + 1,
                          })
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    
    if (language === 'python' && node.type === 'class_definition') {
      const nameNode = node.childForFieldName?.('name')
      const className = nameNode ? getNodeText(nameNode) : ''
      
      const superclassNode = node.childForFieldName?.('superclasses')
      if (superclassNode && superclassNode.type === 'argument_list') {
        if (superclassNode.namedChildren) {
          for (const arg of superclassNode.namedChildren) {
            let baseName = ''
            if (arg.type === 'identifier') {
              baseName = getNodeText(arg)
            } else if (arg.type === 'attribute') {
              baseName = getNodeText(arg)
            }
            if (baseName && baseName !== 'object') {
              heritage.push({
                className,
                baseName,
                type: 'EXTENDS',
                line: node.startPosition.row + 1,
              })
            }
          }
        }
      }
    }
  })
  
  return heritage
}

export async function resolveHeritageEdges(
  filePath: string,
  content: string,
  language: SupportedLanguage,
  symbolTable: SymbolTable
): Promise<SymbolEdge[]> {
  await initPromise
  
  if (!treeSitterAvailable || !Parser) {
    return []
  }
  
  const lang = getLanguageParser(language)
  if (!lang) {
    return []
  }
  
  try {
    const parser = new Parser()
    parser.setLanguage(lang)
    const tree = parser.parse(content)
    const rootNode = tree.rootNode as unknown as TreeSitterNode
    
    const heritageInfo = extractHeritageInfo(rootNode, language)
    const edges: SymbolEdge[] = []
    
    for (const info of heritageInfo) {
      const targets = symbolTable.get(info.baseName)
      
      edges.push({
        sourceName: info.className,
        sourceFilePath: filePath,
        targetName: info.baseName,
        targetFilePath: targets?.[0]?.filePath,
        edgeType: info.type,
        confidence: 1.0,
      })
    }
    
    return edges
  } catch (e) {
    console.warn(`[treesitter] Failed to resolve heritage edges for ${filePath}:`, e)
    return []
  }
}
