import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { splitIdentifier, SymbolGraph } from '../src/symbol-graph.js'

describe('splitIdentifier', () => {
  it('should split camelCase identifiers', () => {
    expect(splitIdentifier('getUserData')).toEqual(['get', 'user', 'data'])
  })

  it('should split snake_case identifiers', () => {
    expect(splitIdentifier('get_user_data')).toEqual(['get', 'user', 'data'])
  })

  it('should handle acronyms correctly', () => {
    expect(splitIdentifier('parseHTTPResponse')).toEqual(['parse', 'http', 'response'])
  })

  it('should handle mixed snake_case and camelCase', () => {
    expect(splitIdentifier('parseJSON_response')).toEqual(['parse', 'json', 'response'])
  })

  it('should handle single word identifiers', () => {
    expect(splitIdentifier('store')).toEqual(['store'])
  })

  it('should handle PascalCase with leading acronym', () => {
    expect(splitIdentifier('XMLParser')).toEqual(['xml', 'parser'])
  })

  it('should handle multiple consecutive acronyms', () => {
    expect(splitIdentifier('getHTTPSUrl')).toEqual(['get', 'https', 'url'])
  })

  it('should handle empty string', () => {
    expect(splitIdentifier('')).toEqual([])
  })
})

describe('SymbolGraph.searchByName', () => {
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
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name, kind);
    `)
    graph = new SymbolGraph(db)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM code_symbols')
  })

  it('should find exact name match with highest score', () => {
    graph.insertSymbol({
      name: 'getUserData',
      kind: 'function',
      filePath: '/test/a.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'abc123',
      projectHash,
    })
    graph.insertSymbol({
      name: 'getUserDataAsync',
      kind: 'function',
      filePath: '/test/b.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'def456',
      projectHash,
    })

    const results = graph.searchByName('getUserData', projectHash)
    expect(results.length).toBe(2)
    expect(results[0].name).toBe('getUserData')
  })

  it('should find partial camelCase matches', () => {
    graph.insertSymbol({
      name: 'getUserData',
      kind: 'function',
      filePath: '/test/a.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'abc123',
      projectHash,
    })
    graph.insertSymbol({
      name: 'setUserProfile',
      kind: 'function',
      filePath: '/test/b.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'def456',
      projectHash,
    })

    const results = graph.searchByName('userData', projectHash)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.name === 'getUserData')).toBe(true)
  })

  it('should be case-insensitive', () => {
    graph.insertSymbol({
      name: 'GetUserData',
      kind: 'function',
      filePath: '/test/a.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'abc123',
      projectHash,
    })

    const results = graph.searchByName('getuserdata', projectHash)
    expect(results.length).toBe(1)
    expect(results[0].name).toBe('GetUserData')
  })

  it('should return empty array when no matches', () => {
    graph.insertSymbol({
      name: 'getUserData',
      kind: 'function',
      filePath: '/test/a.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
      contentHash: 'abc123',
      projectHash,
    })

    const results = graph.searchByName('nonexistent', projectHash)
    expect(results).toEqual([])
  })

  it('should respect limit parameter', () => {
    for (let i = 0; i < 30; i++) {
      graph.insertSymbol({
        name: `getUser${i}`,
        kind: 'function',
        filePath: `/test/file${i}.ts`,
        startLine: 1,
        endLine: 5,
        exported: true,
        contentHash: `hash${i}`,
        projectHash,
      })
    }

    const results = graph.searchByName('user', projectHash, 10)
    expect(results.length).toBe(10)
  })
})
