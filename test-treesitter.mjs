// Direct tree-sitter diagnostic - bypass daemon entirely
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const testCode = `
import { Injectable } from '@nestjs/common'

export class SellService {
  async sellItem(itemId: string): Promise<void> {
    console.log(itemId)
  }
}

export function calculatePrice(base: number): number {
  return base * 1.1
}

const helper = (x: number) => x + 1
`

try {
  const Parser = require('tree-sitter')
  const TypeScript = require('tree-sitter-typescript').typescript
  
  const parser = new Parser()
  parser.setLanguage(TypeScript)
  const tree = parser.parse(testCode)
  const root = tree.rootNode
  
  console.log('=== ROOT NODE ===')
  console.log('type:', root.type)
  console.log('childCount:', root.childCount)
  console.log('children type:', typeof root.children)
  console.log('children is array:', Array.isArray(root.children))
  console.log('children length:', root.children?.length ?? 'UNDEFINED')
  console.log('namedChildren length:', root.namedChildren?.length ?? 'UNDEFINED')
  console.log('hasChildForFieldName:', typeof root.childForFieldName)
  
  console.log('\n=== CHILD TYPES ===')
  if (root.children) {
    for (const child of root.children) {
      console.log(`  ${child.type} [${child.startPosition.row}:${child.startPosition.column}]`)
      if (child.children) {
        for (const gc of child.children) {
          console.log(`    ${gc.type} [${gc.startPosition.row}:${gc.startPosition.column}]`)
        }
      }
    }
  } else {
    console.log('  NO CHILDREN - trying child(i) instead...')
    for (let i = 0; i < root.childCount; i++) {
      const child = root.child(i)
      console.log(`  child(${i}): ${child?.type}`)
    }
  }
  
  // Now test walkTree exactly as nano-brain does it
  console.log('\n=== WALK TREE TEST ===')
  let nodeCount = 0
  let symbolNodes = []
  function walkTree(node, callback) {
    callback(node)
    if (node.children) {
      for (const child of node.children) {
        walkTree(child, callback)
      }
    }
  }
  walkTree(root, (node) => {
    nodeCount++
    if (['function_declaration', 'class_declaration', 'variable_declarator', 'method_definition', 'interface_declaration'].includes(node.type)) {
      const nameNode = node.childForFieldName?.('name')
      symbolNodes.push({ type: node.type, name: nameNode?.text ?? 'NO_NAME' })
    }
  })
  console.log('Total nodes walked:', nodeCount)
  console.log('Symbol nodes found:', symbolNodes.length)
  for (const s of symbolNodes) {
    console.log(`  ${s.type}: ${s.name}`)
  }
  
  // Check if .text works (getNodeText uses this)
  console.log('\n=== TEXT ACCESS ===')
  const firstChild = root.children?.[0]
  if (firstChild) {
    console.log('firstChild.text:', typeof firstChild.text, firstChild.text?.substring(0, 50))
  }
  
} catch (e) {
  console.error('ERROR:', e.message)
  console.error(e.stack)
}
