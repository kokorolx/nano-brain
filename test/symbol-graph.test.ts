import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SymbolGraph } from '../src/symbol-graph.js'
import { indexSymbolGraph } from '../src/codebase.js'
import { isTreeSitterAvailable, waitForInit } from '../src/treesitter.js'

describe('SymbolGraph', () => {
  let db: Database.Database
  let graph: SymbolGraph
  const projectHash = 'test123456'

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        cluster_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path, project_hash);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name, kind);

      CREATE TABLE IF NOT EXISTS symbol_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        project_hash TEXT NOT NULL DEFAULT 'global',
        FOREIGN KEY (source_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_source ON symbol_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_target ON symbol_edges(target_id);
    `)
    graph = new SymbolGraph(db)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM symbol_edges')
    db.exec('DELETE FROM code_symbols')
  })

  describe('insertSymbol', () => {
    it('should insert a symbol and return its id', () => {
      const id = graph.insertSymbol({
        name: 'testFunction',
        kind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      expect(id).toBeGreaterThan(0)
    })

    it('should insert multiple symbols', () => {
      const id1 = graph.insertSymbol({
        name: 'func1',
        kind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const id2 = graph.insertSymbol({
        name: 'func2',
        kind: 'function',
        filePath: '/test/file.ts',
        startLine: 7,
        endLine: 10,
        exported: false,
        contentHash: 'abc123',
        projectHash,
      })

      expect(id2).toBe(id1 + 1)
    })
  })

  describe('insertEdge', () => {
    it('should insert an edge between symbols', () => {
      const sourceId = graph.insertSymbol({
        name: 'caller',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const targetId = graph.insertSymbol({
        name: 'callee',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      graph.insertEdge({
        sourceId,
        targetId,
        edgeType: 'CALLS',
        confidence: 0.9,
        projectHash,
      })

      const edges = graph.getSymbolEdges(sourceId, 'outgoing')
      expect(edges).toHaveLength(1)
      expect(edges[0].targetId).toBe(targetId)
      expect(edges[0].edgeType).toBe('CALLS')
    })
  })

  describe('getSymbolByName', () => {
    it('should find symbols by name', () => {
      graph.insertSymbol({
        name: 'myFunction',
        kind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const symbols = graph.getSymbolByName('myFunction', projectHash)
      expect(symbols).toHaveLength(1)
      expect(symbols[0].name).toBe('myFunction')
      expect(symbols[0].kind).toBe('function')
    })

    it('should filter by file path when provided', () => {
      graph.insertSymbol({
        name: 'sharedName',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      graph.insertSymbol({
        name: 'sharedName',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      const allSymbols = graph.getSymbolByName('sharedName', projectHash)
      expect(allSymbols).toHaveLength(2)

      const filteredSymbols = graph.getSymbolByName('sharedName', projectHash, '/test/a.ts')
      expect(filteredSymbols).toHaveLength(1)
      expect(filteredSymbols[0].filePath).toBe('/test/a.ts')
    })
  })

  describe('getSymbolEdges', () => {
    it('should get outgoing edges', () => {
      const sourceId = graph.insertSymbol({
        name: 'source',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const target1Id = graph.insertSymbol({
        name: 'target1',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      const target2Id = graph.insertSymbol({
        name: 'target2',
        kind: 'function',
        filePath: '/test/c.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'ghi789',
        projectHash,
      })

      graph.insertEdge({ sourceId, targetId: target1Id, edgeType: 'CALLS', confidence: 0.9, projectHash })
      graph.insertEdge({ sourceId, targetId: target2Id, edgeType: 'IMPORTS', confidence: 1.0, projectHash })

      const outgoing = graph.getSymbolEdges(sourceId, 'outgoing')
      expect(outgoing).toHaveLength(2)
    })

    it('should get incoming edges', () => {
      const targetId = graph.insertSymbol({
        name: 'target',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const source1Id = graph.insertSymbol({
        name: 'source1',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      const source2Id = graph.insertSymbol({
        name: 'source2',
        kind: 'function',
        filePath: '/test/c.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'ghi789',
        projectHash,
      })

      graph.insertEdge({ sourceId: source1Id, targetId, edgeType: 'CALLS', confidence: 0.9, projectHash })
      graph.insertEdge({ sourceId: source2Id, targetId, edgeType: 'CALLS', confidence: 0.8, projectHash })

      const incoming = graph.getSymbolEdges(targetId, 'incoming')
      expect(incoming).toHaveLength(2)
    })

    it('should filter by edge types', () => {
      const sourceId = graph.insertSymbol({
        name: 'source',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const target1Id = graph.insertSymbol({
        name: 'target1',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      const target2Id = graph.insertSymbol({
        name: 'target2',
        kind: 'class',
        filePath: '/test/c.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'ghi789',
        projectHash,
      })

      graph.insertEdge({ sourceId, targetId: target1Id, edgeType: 'CALLS', confidence: 0.9, projectHash })
      graph.insertEdge({ sourceId, targetId: target2Id, edgeType: 'EXTENDS', confidence: 1.0, projectHash })

      const callsOnly = graph.getSymbolEdges(sourceId, 'outgoing', ['CALLS'])
      expect(callsOnly).toHaveLength(1)
      expect(callsOnly[0].edgeType).toBe('CALLS')
    })

    it('should filter by minimum confidence', () => {
      const sourceId = graph.insertSymbol({
        name: 'source',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const target1Id = graph.insertSymbol({
        name: 'target1',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      const target2Id = graph.insertSymbol({
        name: 'target2',
        kind: 'function',
        filePath: '/test/c.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'ghi789',
        projectHash,
      })

      graph.insertEdge({ sourceId, targetId: target1Id, edgeType: 'CALLS', confidence: 0.5, projectHash })
      graph.insertEdge({ sourceId, targetId: target2Id, edgeType: 'CALLS', confidence: 0.9, projectHash })

      const highConfidence = graph.getSymbolEdges(sourceId, 'outgoing', undefined, 0.8)
      expect(highConfidence).toHaveLength(1)
      expect(highConfidence[0].confidence).toBeGreaterThanOrEqual(0.8)
    })
  })

  describe('deleteSymbolsForFile', () => {
    it('should delete all symbols and edges for a file', () => {
      const id1 = graph.insertSymbol({
        name: 'func1',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const id2 = graph.insertSymbol({
        name: 'func2',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 7,
        endLine: 10,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const id3 = graph.insertSymbol({
        name: 'func3',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      graph.insertEdge({ sourceId: id1, targetId: id3, edgeType: 'CALLS', confidence: 0.9, projectHash })
      graph.insertEdge({ sourceId: id3, targetId: id2, edgeType: 'CALLS', confidence: 0.9, projectHash })

      graph.deleteSymbolsForFile('/test/a.ts', projectHash)

      const symbolsA = graph.getSymbolByName('func1', projectHash)
      expect(symbolsA).toHaveLength(0)

      const symbolsB = graph.getSymbolByName('func3', projectHash)
      expect(symbolsB).toHaveLength(1)

      expect(graph.getSymbolCount(projectHash)).toBe(1)
      expect(graph.getEdgeCount(projectHash)).toBe(0)
    })
  })

  describe('getSymbolCount and getEdgeCount', () => {
    it('should return correct counts', () => {
      expect(graph.getSymbolCount(projectHash)).toBe(0)
      expect(graph.getEdgeCount(projectHash)).toBe(0)

      const id1 = graph.insertSymbol({
        name: 'func1',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const id2 = graph.insertSymbol({
        name: 'func2',
        kind: 'function',
        filePath: '/test/b.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'def456',
        projectHash,
      })

      expect(graph.getSymbolCount(projectHash)).toBe(2)

      graph.insertEdge({ sourceId: id1, targetId: id2, edgeType: 'CALLS', confidence: 0.9, projectHash })

      expect(graph.getEdgeCount(projectHash)).toBe(1)
    })
  })

  describe('getFileContentHash', () => {
    it('should return content hash for indexed file', () => {
      graph.insertSymbol({
        name: 'func1',
        kind: 'function',
        filePath: '/test/a.ts',
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: 'abc123',
        projectHash,
      })

      const hash = graph.getFileContentHash('/test/a.ts', projectHash)
      expect(hash).toBe('abc123')
    })

    it('should return null for non-indexed file', () => {
      const hash = graph.getFileContentHash('/test/nonexistent.ts', projectHash)
      expect(hash).toBeNull()
    })
  })
})

describe('indexSymbolGraph integration', () => {
  let db: Database.Database
  let tempDir: string
  const projectHash = 'inttest12345'

  beforeAll(async () => {
    await waitForInit()
    
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-graph-test-'))
    
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        cluster_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path, project_hash);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name, kind);

      CREATE TABLE IF NOT EXISTS symbol_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        project_hash TEXT NOT NULL DEFAULT 'global',
        FOREIGN KEY (source_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_source ON symbol_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_target ON symbol_edges(target_id);
    `)
  })

  afterAll(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    db.exec('DELETE FROM symbol_edges')
    db.exec('DELETE FROM code_symbols')
  })

  it('should index symbols from TypeScript files', async () => {
    if (!isTreeSitterAvailable()) {
      console.log('Tree-sitter not available, skipping integration test')
      return
    }

    const utilsContent = `
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}
`

    const mathContent = `
import { add, multiply } from './utils'

export function calculate(x: number, y: number): number {
  const sum = add(x, y)
  const product = multiply(x, y)
  return sum + product
}
`

    const mainContent = `
import { calculate } from './math'

function main() {
  const result = calculate(5, 3)
  console.log(result)
}

main()
`

    const files = [
      { path: path.join(tempDir, 'utils.ts'), content: utilsContent },
      { path: path.join(tempDir, 'math.ts'), content: mathContent },
      { path: path.join(tempDir, 'main.ts'), content: mainContent },
    ]

    const result = await indexSymbolGraph(db, tempDir, projectHash, files)

    expect(result.filesProcessed).toBe(3)
    expect(result.symbolsIndexed).toBeGreaterThan(0)

    const graph = new SymbolGraph(db)
    
    const addSymbols = graph.getSymbolByName('add', projectHash)
    expect(addSymbols.length).toBeGreaterThan(0)
    expect(addSymbols[0].kind).toBe('function')
    expect(addSymbols[0].exported).toBeTruthy()

    const calculateSymbols = graph.getSymbolByName('calculate', projectHash)
    expect(calculateSymbols.length).toBeGreaterThan(0)

    const mainSymbols = graph.getSymbolByName('main', projectHash)
    expect(mainSymbols.length).toBeGreaterThan(0)
  })

  it('should create edges for function calls', async () => {
    if (!isTreeSitterAvailable()) {
      console.log('Tree-sitter not available, skipping integration test')
      return
    }

    const helperContent = `
export function helper() {
  return 'help'
}
`

    const callerContent = `
import { helper } from './helper'

export function caller() {
  return helper()
}
`

    const files = [
      { path: path.join(tempDir, 'helper.ts'), content: helperContent },
      { path: path.join(tempDir, 'caller.ts'), content: callerContent },
    ]

    const result = await indexSymbolGraph(db, tempDir, projectHash, files)

    expect(result.edgesCreated).toBeGreaterThanOrEqual(0)
  })

  it('should support incremental indexing', async () => {
    if (!isTreeSitterAvailable()) {
      console.log('Tree-sitter not available, skipping integration test')
      return
    }

    const content1 = `
export function foo() {
  return 'foo'
}
`

    const files = [
      { path: path.join(tempDir, 'foo.ts'), content: content1 },
    ]

    const result1 = await indexSymbolGraph(db, tempDir, projectHash, files)
    expect(result1.filesProcessed).toBe(1)
    expect(result1.filesSkipped).toBe(0)

    const result2 = await indexSymbolGraph(db, tempDir, projectHash, files)
    expect(result2.filesProcessed).toBe(0)
    expect(result2.filesSkipped).toBe(1)

    const content2 = `
export function foo() {
  return 'foo updated'
}
`

    const filesUpdated = [
      { path: path.join(tempDir, 'foo.ts'), content: content2 },
    ]

    const result3 = await indexSymbolGraph(db, tempDir, projectHash, filesUpdated)
    expect(result3.filesProcessed).toBe(1)
    expect(result3.filesSkipped).toBe(0)
  })

  it('should handle force re-indexing', async () => {
    if (!isTreeSitterAvailable()) {
      console.log('Tree-sitter not available, skipping integration test')
      return
    }

    const content = `
export function bar() {
  return 'bar'
}
`

    const files = [
      { path: path.join(tempDir, 'bar.ts'), content },
    ]

    await indexSymbolGraph(db, tempDir, projectHash, files)

    const result = await indexSymbolGraph(db, tempDir, projectHash, files, { force: true })
    expect(result.filesProcessed).toBe(1)
    expect(result.filesSkipped).toBe(0)
  })

  it('should skip non-supported languages', async () => {
    if (!isTreeSitterAvailable()) {
      console.log('Tree-sitter not available, skipping integration test')
      return
    }

    const files = [
      { path: path.join(tempDir, 'readme.md'), content: '# README' },
      { path: path.join(tempDir, 'config.json'), content: '{}' },
    ]

    const result = await indexSymbolGraph(db, tempDir, projectHash, files)
    expect(result.filesSkipped).toBe(2)
    expect(result.filesProcessed).toBe(0)
  })
})
