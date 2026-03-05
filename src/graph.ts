import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'

export type SupportedLanguage = 'js' | 'ts' | 'python' | 'ruby'

export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'ts'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'js'
    case '.py':
    case '.pyi':
      return 'python'
    case '.rb':
    case '.erb':
      return 'ruby'
    default:
      return null
  }
}

const JS_TS_IMPORT_PATTERNS = [
  /import\s+(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/g,
  /export\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

const PYTHON_IMPORT_PATTERNS = [
  /^from\s+(\.+[\w.]*)\s+import\s+/gm,
  /^from\s+(\.+)\s+import\s+/gm,
]

const RUBY_REQUIRE_RELATIVE_PATTERN = /require_relative\s+['"]([^'"]+)['"]/g
const RUBY_REQUIRE_PATTERN = /require\s+['"]([^'"]+)['"]/g
const RUBY_LOAD_PATTERN = /load\s+['"]([^'"]+)['"]/g

const RAILS_ASSOCIATION_PATTERNS = [
  /(?:belongs_to|has_many|has_one)\s+:(\w+)/g,
]

function resolveJsTsImport(
  importPath: string,
  sourceFilePath: string,
  workspaceRoot: string
): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return null
  }

  const sourceDir = path.dirname(sourceFilePath)
  let basePath: string

  if (importPath.startsWith('/')) {
    basePath = path.join(workspaceRoot, importPath)
  } else {
    basePath = path.resolve(sourceDir, importPath)
  }

  if (!basePath.startsWith(workspaceRoot)) {
    return null
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']
  const indexFiles = extensions.map(ext => `index${ext}`)

  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath
  }

  for (const ext of extensions) {
    const withExt = basePath + ext
    if (fs.existsSync(withExt)) {
      return withExt
    }
  }

  for (const indexFile of indexFiles) {
    const indexPath = path.join(basePath, indexFile)
    if (fs.existsSync(indexPath)) {
      return indexPath
    }
  }

  return null
}

function resolvePythonImport(
  importPath: string,
  sourceFilePath: string,
  workspaceRoot: string
): string | null {
  if (!importPath.startsWith('.')) {
    return null
  }

  const sourceDir = path.dirname(sourceFilePath)
  
  let dotCount = 0
  for (const char of importPath) {
    if (char === '.') dotCount++
    else break
  }

  const modulePart = importPath.slice(dotCount)
  
  let baseDir = sourceDir
  for (let i = 1; i < dotCount; i++) {
    baseDir = path.dirname(baseDir)
  }

  if (!baseDir.startsWith(workspaceRoot)) {
    return null
  }

  const modulePath = modulePart.replace(/\./g, path.sep)
  const basePath = modulePath ? path.join(baseDir, modulePath) : baseDir

  const pyFile = basePath + '.py'
  if (fs.existsSync(pyFile)) {
    return pyFile
  }

  const initFile = path.join(basePath, '__init__.py')
  if (fs.existsSync(initFile)) {
    return initFile
  }

  return null
}

function resolveRubyRequire(
  requirePath: string,
  sourceFilePath: string,
  workspaceRoot: string,
  isRequireRelative: boolean
): string | null {
  if (isRequireRelative) {
    const sourceDir = path.dirname(sourceFilePath)
    let basePath = path.resolve(sourceDir, requirePath)
    
    if (!basePath.endsWith('.rb')) {
      basePath += '.rb'
    }

    if (!basePath.startsWith(workspaceRoot)) {
      return null
    }

    if (fs.existsSync(basePath)) {
      return basePath
    }
    return null
  }

  if (!requirePath.includes('/') && !requirePath.includes('.')) {
    return null
  }

  if (requirePath.startsWith('./') || requirePath.startsWith('../')) {
    const sourceDir = path.dirname(sourceFilePath)
    let basePath = path.resolve(sourceDir, requirePath)
    
    if (!basePath.endsWith('.rb')) {
      basePath += '.rb'
    }

    if (!basePath.startsWith(workspaceRoot)) {
      return null
    }

    if (fs.existsSync(basePath)) {
      return basePath
    }
  }

  return null
}

function resolveRailsAssociation(
  associationName: string,
  sourceFilePath: string,
  workspaceRoot: string
): string | null {
  const normalizedSource = sourceFilePath.replace(/\\/g, '/')
  if (!normalizedSource.includes('/app/')) {
    return null
  }

  const singularName = associationName.replace(/s$/, '')
  const modelPath = path.join(workspaceRoot, 'app', 'models', `${singularName}.rb`)

  if (fs.existsSync(modelPath)) {
    return modelPath
  }

  return null
}

export function parseImports(
  filePath: string,
  content: string,
  language: SupportedLanguage,
  workspaceRoot: string
): string[] {
  const imports = new Set<string>()

  if (language === 'js' || language === 'ts') {
    for (const pattern of JS_TS_IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1]
        const resolved = resolveJsTsImport(importPath, filePath, workspaceRoot)
        if (resolved) {
          imports.add(resolved)
        }
      }
    }
  } else if (language === 'python') {
    for (const pattern of PYTHON_IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1]
        const resolved = resolvePythonImport(importPath, filePath, workspaceRoot)
        if (resolved) {
          imports.add(resolved)
        }
      }
    }
  } else if (language === 'ruby') {
    RUBY_REQUIRE_RELATIVE_PATTERN.lastIndex = 0
    let match
    while ((match = RUBY_REQUIRE_RELATIVE_PATTERN.exec(content)) !== null) {
      const requirePath = match[1]
      const resolved = resolveRubyRequire(requirePath, filePath, workspaceRoot, true)
      if (resolved) {
        imports.add(resolved)
      }
    }

    RUBY_REQUIRE_PATTERN.lastIndex = 0
    while ((match = RUBY_REQUIRE_PATTERN.exec(content)) !== null) {
      const requirePath = match[1]
      const resolved = resolveRubyRequire(requirePath, filePath, workspaceRoot, false)
      if (resolved) {
        imports.add(resolved)
      }
    }

    RUBY_LOAD_PATTERN.lastIndex = 0
    while ((match = RUBY_LOAD_PATTERN.exec(content)) !== null) {
      const requirePath = match[1]
      const resolved = resolveRubyRequire(requirePath, filePath, workspaceRoot, false)
      if (resolved) {
        imports.add(resolved)
      }
    }

    for (const pattern of RAILS_ASSOCIATION_PATTERNS) {
      pattern.lastIndex = 0
      while ((match = pattern.exec(content)) !== null) {
        const associationName = match[1]
        const resolved = resolveRailsAssociation(associationName, filePath, workspaceRoot)
        if (resolved) {
          imports.add(resolved)
        }
      }
    }
  }

  return Array.from(imports)
}

export function computePageRank(
  edges: Array<{ source: string; target: string }>,
  damping: number = 0.85,
  iterations: number = 100
): Map<string, number> {
  if (edges.length === 0) return new Map()

  const nodes = new Set<string>()
  const outLinks = new Map<string, Set<string>>()
  const inLinks = new Map<string, Set<string>>()

  for (const { source, target } of edges) {
    nodes.add(source)
    nodes.add(target)
    if (!outLinks.has(source)) outLinks.set(source, new Set())
    outLinks.get(source)!.add(target)
    if (!inLinks.has(target)) inLinks.set(target, new Set())
    inLinks.get(target)!.add(source)
  }

  const n = nodes.size
  const nodeList = Array.from(nodes)
  let ranks = new Map<string, number>()
  for (const node of nodeList) {
    ranks.set(node, 1 / n)
  }

  for (let i = 0; i < iterations; i++) {
    const newRanks = new Map<string, number>()
    let danglingSum = 0
    for (const node of nodeList) {
      if (!outLinks.has(node) || outLinks.get(node)!.size === 0) {
        danglingSum += ranks.get(node)!
      }
    }
    for (const node of nodeList) {
      let sum = 0
      const incoming = inLinks.get(node)
      if (incoming) {
        for (const src of incoming) {
          const outCount = outLinks.get(src)?.size ?? 0
          if (outCount > 0) {
            sum += ranks.get(src)! / outCount
          }
        }
      }
      const rank = (1 - damping) / n + damping * (sum + danglingSum / n)
      newRanks.set(node, rank)
    }
    ranks = newRanks
  }

  return ranks
}

export function louvainClustering(
  edges: Array<{ source: string; target: string }>
): Map<string, number> {
  const nodes = new Set<string>()
  for (const { source, target } of edges) {
    nodes.add(source)
    nodes.add(target)
  }

  if (nodes.size < 20) return new Map()

  const nodeList = Array.from(nodes)
  const nodeIndex = new Map<string, number>()
  for (let i = 0; i < nodeList.length; i++) {
    nodeIndex.set(nodeList[i], i)
  }

  const adj = new Map<number, Map<number, number>>()
  const degree = new Array(nodeList.length).fill(0)
  let totalWeight = 0

  for (const { source, target } of edges) {
    const i = nodeIndex.get(source)!
    const j = nodeIndex.get(target)!
    if (!adj.has(i)) adj.set(i, new Map())
    if (!adj.has(j)) adj.set(j, new Map())
    adj.get(i)!.set(j, (adj.get(i)!.get(j) ?? 0) + 1)
    adj.get(j)!.set(i, (adj.get(j)!.get(i) ?? 0) + 1)
    degree[i]++
    degree[j]++
    totalWeight++
  }

  const m2 = 2 * totalWeight
  const community = new Array(nodeList.length).fill(0).map((_, i) => i)
  const communitySum = [...degree]

  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < nodeList.length; i++) {
      const currentComm = community[i]
      const neighbors = adj.get(i) ?? new Map()
      const commWeights = new Map<number, number>()

      for (const [j, w] of neighbors) {
        const c = community[j]
        commWeights.set(c, (commWeights.get(c) ?? 0) + w)
      }

      let bestComm = currentComm
      let bestDelta = 0

      const ki = degree[i]
      const currentCommWeight = commWeights.get(currentComm) ?? 0
      const currentSigma = communitySum[currentComm] - ki

      for (const [c, kic] of commWeights) {
        if (c === currentComm) continue
        const sigma = communitySum[c]
        const delta = (kic - currentCommWeight) / m2 - ki * (sigma - currentSigma) / (m2 * m2)
        if (delta > bestDelta) {
          bestDelta = delta
          bestComm = c
        }
      }

      if (bestComm !== currentComm) {
        communitySum[currentComm] -= ki
        communitySum[bestComm] += ki
        community[i] = bestComm
        improved = true
      }
    }
  }

  const uniqueComms = [...new Set(community)]
  const commRemap = new Map<number, number>()
  uniqueComms.forEach((c, idx) => commRemap.set(c, idx))

  const result = new Map<string, number>()
  for (let i = 0; i < nodeList.length; i++) {
    result.set(nodeList[i], commRemap.get(community[i])!)
  }

  return result
}

export function computeEdgeSetHash(
  edges: Array<{ source: string; target: string }>
): string {
  const sorted = edges
    .map(e => `${e.source}\0${e.target}`)
    .sort()
  const serialized = sorted.join('\n')
  return crypto.createHash('sha256').update(serialized).digest('hex')
}

export function findCycles(
  edges: Array<{ source: string; target: string }>,
  maxLength: number = 5
): string[][] {
  if (edges.length === 0) return []
  
  const adjacency = new Map<string, Set<string>>()
  const nodes = new Set<string>()
  
  for (const { source, target } of edges) {
    nodes.add(source)
    nodes.add(target)
    if (!adjacency.has(source)) adjacency.set(source, new Set())
    adjacency.get(source)!.add(target)
  }
  
  const cycles: string[][] = []
  const cycleSet = new Set<string>()
  
  function dfs(start: string, current: string, path: string[], visited: Set<string>): void {
    if (path.length > maxLength) return
    
    const neighbors = adjacency.get(current)
    if (!neighbors) return
    
    for (const neighbor of neighbors) {
      if (neighbor === start && path.length >= 2) {
        const cycle = [...path]
        const normalized = normalizeCycle(cycle)
        const key = normalized.join('\0')
        if (!cycleSet.has(key)) {
          cycleSet.add(key)
          cycles.push(normalized)
        }
      } else if (!visited.has(neighbor) && path.length < maxLength) {
        visited.add(neighbor)
        path.push(neighbor)
        dfs(start, neighbor, path, visited)
        path.pop()
        visited.delete(neighbor)
      }
    }
  }
  
  function normalizeCycle(cycle: string[]): string[] {
    if (cycle.length === 0) return cycle
    let minIdx = 0
    for (let i = 1; i < cycle.length; i++) {
      if (cycle[i] < cycle[minIdx]) {
        minIdx = i
      }
    }
    return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)]
  }
  
  for (const node of nodes) {
    const visited = new Set<string>([node])
    dfs(node, node, [node], visited)
  }
  
  return cycles.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length
    return a.join('\0').localeCompare(b.join('\0'))
  })
}
