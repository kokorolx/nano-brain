import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { hybridSearch } from '../src/search.js';
import type { SearchResult, Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createMockResult(id: string, filePath: string, score: number, snippet: string = 'test snippet'): SearchResult {
  return {
    id,
    path: filePath,
    collection: 'test',
    title: `Title ${id}`,
    snippet,
    score,
    startLine: 1,
    endLine: 10,
    docid: id.substring(0, 6),
  };
}

function createMockStore(ftsResults: SearchResult[], vecResults: SearchResult[]): Store {
  return {
    searchFTS: vi.fn().mockReturnValue(ftsResults),
    searchVec: vi.fn().mockReturnValue(vecResults),
    searchVecAsync: vi.fn().mockResolvedValue(vecResults),
    getCachedResult: vi.fn().mockReturnValue(null),
    setCachedResult: vi.fn(),
    getQueryEmbeddingCache: vi.fn().mockReturnValue(null),
    setQueryEmbeddingCache: vi.fn(),
    clearQueryEmbeddingCache: vi.fn(),
    clearCache: vi.fn().mockReturnValue(0),
    getCacheStats: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    insertDocument: vi.fn(),
    findDocument: vi.fn(),
    getDocumentBody: vi.fn(),
    deactivateDocument: vi.fn(),
    bulkDeactivateExcept: vi.fn(),
    insertContent: vi.fn(),
    insertEmbedding: vi.fn(),
    ensureVecTable: vi.fn(),
    getIndexHealth: vi.fn(),
    getHashesNeedingEmbedding: vi.fn(),
    getNextHashNeedingEmbedding: vi.fn().mockReturnValue(null),
    getWorkspaceStats: vi.fn().mockReturnValue([]),
    deleteDocumentsByPath: vi.fn().mockReturnValue(0),
    clearWorkspace: vi.fn().mockReturnValue({ documentsDeleted: 0, embeddingsDeleted: 0 }),
    cleanOrphanedEmbeddings: vi.fn().mockReturnValue(0),
    getCollectionStorageSize: vi.fn().mockReturnValue(0),
    modelStatus: { embedding: 'missing', reranker: 'missing', expander: 'missing' },
    setVectorStore: vi.fn(),
    insertFileEdge: vi.fn(),
    deleteFileEdges: vi.fn(),
    getFileEdges: vi.fn().mockReturnValue([]),
    updateCentralityScores: vi.fn(),
    updateClusterIds: vi.fn(),
    getEdgeSetHash: vi.fn().mockReturnValue(null),
    setEdgeSetHash: vi.fn(),
    supersedeDocument: vi.fn(),
    insertTags: vi.fn(),
    getDocumentTags: vi.fn().mockReturnValue([]),
    listAllTags: vi.fn().mockReturnValue([]),
    getFileDependencies: vi.fn().mockReturnValue([]),
    getFileDependents: vi.fn().mockReturnValue([]),
    getDocumentCentrality: vi.fn().mockReturnValue(null),
    getClusterMembers: vi.fn().mockReturnValue([]),
    getGraphStats: vi.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, clusterCount: 0, topCentrality: [] }),
    insertSymbol: vi.fn(),
    deleteSymbols: vi.fn(),
    querySymbols: vi.fn().mockReturnValue([]),
    getSymbolImpact: vi.fn().mockReturnValue([]),
  } as unknown as Store;
}

function setupTestDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS code_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      exported INTEGER DEFAULT 0,
      content_hash TEXT,
      project_hash TEXT NOT NULL,
      cluster_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS symbol_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      project_hash TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES code_symbols(id),
      FOREIGN KEY (target_id) REFERENCES code_symbols(id)
    );

    CREATE TABLE IF NOT EXISTS execution_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      flow_type TEXT NOT NULL,
      entry_symbol_id INTEGER,
      terminal_symbol_id INTEGER,
      step_count INTEGER DEFAULT 0,
      project_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS flow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      FOREIGN KEY (flow_id) REFERENCES execution_flows(id),
      FOREIGN KEY (symbol_id) REFERENCES code_symbols(id)
    );

    CREATE INDEX IF NOT EXISTS idx_code_symbols_file_path ON code_symbols(file_path, project_hash);
    CREATE INDEX IF NOT EXISTS idx_flow_steps_symbol ON flow_steps(symbol_id);
  `);

  return db;
}

describe('Search Enrichment', () => {
  let db: Database.Database;
  let dbPath: string;
  const projectHash = 'test-project-123';

  beforeEach(() => {
    const tmpDir = os.tmpdir();
    dbPath = path.join(tmpDir, `test-search-enrichment-${Date.now()}.sqlite`);
    db = setupTestDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  it('should enrich results with symbol names when db is provided', async () => {
    const filePath = '/src/auth.ts';
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', filePath, 1, 10, 1, projectHash);
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('validateToken', 'function', filePath, 12, 20, 1, projectHash);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'auth', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].symbols).toBeDefined();
    expect(results[0].symbols).toContain('handleLogin');
    expect(results[0].symbols).toContain('validateToken');
  });

  it('should enrich results with cluster label when symbols have cluster_id', async () => {
    const filePath = '/src/auth/login.ts';
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', filePath, 1, 10, 1, projectHash, 1);
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('validateCredentials', 'function', filePath, 12, 20, 1, projectHash, 1);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'login', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].clusterLabel).toBeDefined();
    expect(results[0].clusterLabel).toBe('auth');
  });

  it('should enrich results with flow count when symbols participate in flows', async () => {
    const filePath = '/src/api/handler.ts';
    const symbolResult = db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handleRequest', 'function', filePath, 1, 10, 1, projectHash);
    const symbolId = Number(symbolResult.lastInsertRowid);

    const flowResult = db.prepare(`
      INSERT INTO execution_flows (label, flow_type, entry_symbol_id, step_count, project_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run('HandleRequest -> ProcessData', 'intra_community', symbolId, 3, projectHash);
    const flowId = Number(flowResult.lastInsertRowid);

    db.prepare(`
      INSERT INTO flow_steps (flow_id, symbol_id, step_index)
      VALUES (?, ?, ?)
    `).run(flowId, symbolId, 0);

    const flow2Result = db.prepare(`
      INSERT INTO execution_flows (label, flow_type, entry_symbol_id, step_count, project_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run('HandleRequest -> SendResponse', 'cross_community', symbolId, 2, projectHash);
    const flow2Id = Number(flow2Result.lastInsertRowid);

    db.prepare(`
      INSERT INTO flow_steps (flow_id, symbol_id, step_index)
      VALUES (?, ?, ?)
    `).run(flow2Id, symbolId, 0);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'handler', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].flowCount).toBe(2);
  });

  it('should NOT enrich results when db is NOT provided (backward compatible)', async () => {
    const filePath = '/src/auth.ts';
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', filePath, 1, 10, 1, projectHash);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'auth', limit: 10, projectHash },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].symbols).toBeUndefined();
    expect(results[0].clusterLabel).toBeUndefined();
    expect(results[0].flowCount).toBeUndefined();
  });

  it('should NOT enrich results when projectHash is NOT provided', async () => {
    const filePath = '/src/auth.ts';
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', filePath, 1, 10, 1, projectHash);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'auth', limit: 10, db },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].symbols).toBeUndefined();
  });

  it('should NOT add enrichment for files with no symbols', async () => {
    const fileWithSymbols = '/src/auth.ts';
    const fileWithoutSymbols = '/src/config.ts';

    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', fileWithSymbols, 1, 10, 1, projectHash);

    const mockFtsResults = [
      createMockResult('doc1', fileWithSymbols, 10),
      createMockResult('doc2', fileWithoutSymbols, 8),
    ];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'test', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(2);

    const resultWithSymbols = results.find(r => r.path === fileWithSymbols);
    const resultWithoutSymbols = results.find(r => r.path === fileWithoutSymbols);

    expect(resultWithSymbols?.symbols).toContain('handleLogin');
    expect(resultWithoutSymbols?.symbols).toBeUndefined();
  });

  it('should handle multiple files with different enrichment data', async () => {
    const file1 = '/src/auth/login.ts';
    const file2 = '/src/api/handler.ts';

    const sym1 = db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('handleLogin', 'function', file1, 1, 10, 1, projectHash, 1);
    const sym1Id = Number(sym1.lastInsertRowid);

    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('handleRequest', 'function', file2, 1, 10, 1, projectHash, 2);

    const flowResult = db.prepare(`
      INSERT INTO execution_flows (label, flow_type, entry_symbol_id, step_count, project_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run('Login Flow', 'intra_community', sym1Id, 2, projectHash);
    const flowId = Number(flowResult.lastInsertRowid);

    db.prepare(`
      INSERT INTO flow_steps (flow_id, symbol_id, step_index)
      VALUES (?, ?, ?)
    `).run(flowId, sym1Id, 0);

    const mockFtsResults = [
      createMockResult('doc1', file1, 10),
      createMockResult('doc2', file2, 8),
    ];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'test', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(2);

    const result1 = results.find(r => r.path === file1);
    const result2 = results.find(r => r.path === file2);

    expect(result1?.symbols).toContain('handleLogin');
    expect(result1?.clusterLabel).toBe('auth');
    expect(result1?.flowCount).toBe(1);

    expect(result2?.symbols).toContain('handleRequest');
    expect(result2?.flowCount).toBeUndefined();
  });

  it('should use dominant cluster label when file has symbols in multiple clusters', async () => {
    const filePath = '/src/mixed.ts';

    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('func1', 'function', filePath, 1, 10, 1, projectHash, 1);
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('func2', 'function', filePath, 12, 20, 1, projectHash, 1);
    db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, project_hash, cluster_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('func3', 'function', filePath, 22, 30, 1, projectHash, 2);

    const mockFtsResults = [createMockResult('doc1', filePath, 10)];
    const store = createMockStore(mockFtsResults, []);

    const results = await hybridSearch(
      store,
      { query: 'test', limit: 10, projectHash, db },
      {}
    );

    expect(results.length).toBe(1);
    expect(results[0].symbols?.length).toBe(3);
    expect(results[0].clusterLabel).toBeDefined();
  });
});
