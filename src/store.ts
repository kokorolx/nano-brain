import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Store, Document, SearchResult, IndexHealth, StoreSearchOptions } from './types.js';
import type { VectorStore } from './vector-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chunkMarkdown } from './chunker.js';
import { log } from './logger.js';

export function sanitizeFTS5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function createStore(dbPath: string): Store {
  log('store', 'createStore dbPath=' + dbPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  let vecAvailable = false;
  let vectorStore: VectorStore | null = null;
  
  try {
    sqliteVec.load(db);
    vecAvailable = true;
  } catch {
    console.warn('sqlite-vec extension not available, vector search disabled');
  }
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash),
      UNIQUE(collection, path)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active);
    CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash);
    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active);

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath,
      title,
      body,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(filepath, title, body)
      SELECT NEW.collection || '/' || NEW.path, NEW.title, c.body
      FROM content c WHERE c.hash = NEW.hash;
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE filepath = OLD.collection || '/' || OLD.path;
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE OF hash ON documents BEGIN
      DELETE FROM documents_fts WHERE filepath = OLD.collection || '/' || OLD.path;
      INSERT INTO documents_fts(filepath, title, body)
      SELECT NEW.collection || '/' || NEW.path, NEW.title, c.body
      FROM content c WHERE c.hash = NEW.hash;
    END;

    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (hash, seq)
    );

    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT NOT NULL,
      project_hash TEXT NOT NULL DEFAULT 'global',
      type TEXT NOT NULL DEFAULT 'general',
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (hash, project_hash)
    );

    CREATE TABLE IF NOT EXISTS file_edges (
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      edge_type TEXT NOT NULL DEFAULT 'import',
      project_hash TEXT NOT NULL DEFAULT 'global',
      PRIMARY KEY(source_path, target_path, project_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_file_edges_source ON file_edges(source_path);
    CREATE INDEX IF NOT EXISTS idx_file_edges_target ON file_edges(target_path);

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY(document_id, tag),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag);

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      operation TEXT NOT NULL,
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_number INTEGER,
      raw_expression TEXT,
      project_hash TEXT NOT NULL DEFAULT 'global',
      UNIQUE(type, pattern, operation, repo, file_path, line_number)
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_type_pattern ON symbols(type, pattern);
    CREATE INDEX IF NOT EXISTS idx_symbols_repo ON symbols(repo);

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
    CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project_hash);

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
    CREATE INDEX IF NOT EXISTS idx_symbol_edges_type ON symbol_edges(edge_type);

    CREATE TABLE IF NOT EXISTS execution_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      flow_type TEXT NOT NULL,
      entry_symbol_id INTEGER NOT NULL,
      terminal_symbol_id INTEGER NOT NULL,
      step_count INTEGER NOT NULL,
      project_hash TEXT NOT NULL DEFAULT 'global',
      FOREIGN KEY (entry_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (terminal_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_flows_project ON execution_flows(project_hash);

    CREATE TABLE IF NOT EXISTS flow_steps (
      flow_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      PRIMARY KEY (flow_id, step_index),
      FOREIGN KEY (flow_id) REFERENCES execution_flows(id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_flow_steps_symbol ON flow_steps(symbol_id);
  `);
  
  const hasProjectHash = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'project_hash');
  if (!hasProjectHash) {
    db.exec("ALTER TABLE documents ADD COLUMN project_hash TEXT DEFAULT 'global'");
    const sessionPathRegex = /sessions\/([a-f0-9]{12})\//i;
    const rows = db.prepare("SELECT id, path FROM documents").all() as Array<{ id: number; path: string }>;
    const updateStmt = db.prepare("UPDATE documents SET project_hash = ? WHERE id = ?");
    for (const row of rows) {
      const match = row.path.match(sessionPathRegex);
      if (match) {
        updateStmt.run(match[1], row.id);
      }
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_project_hash ON documents(project_hash, active)");
  
  const hasCentrality = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'centrality');
  if (!hasCentrality) {
    db.exec("ALTER TABLE documents ADD COLUMN centrality REAL DEFAULT 0.0");
  }
  
  const hasClusterId = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'cluster_id');
  if (!hasClusterId) {
    db.exec("ALTER TABLE documents ADD COLUMN cluster_id INTEGER DEFAULT NULL");
  }
  
  const hasSupersededBy = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'superseded_by');
  if (!hasSupersededBy) {
    db.exec("ALTER TABLE documents ADD COLUMN superseded_by INTEGER DEFAULT NULL");
  }
  
  const hasProjectHashCol = (db.pragma('table_info(llm_cache)') as Array<{name: string}>).some(c => c.name === 'project_hash');
  if (!hasProjectHashCol) {
    db.exec(`
      ALTER TABLE llm_cache RENAME TO llm_cache_old;
      CREATE TABLE llm_cache (
        hash TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        type TEXT NOT NULL DEFAULT 'general',
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (hash, project_hash)
      );
      INSERT INTO llm_cache (hash, project_hash, type, result, created_at)
        SELECT hash, 'global', 'general', result, created_at FROM llm_cache_old;
      DROP TABLE llm_cache_old;
    `);
  }
  
  if (vecAvailable) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(
          hash_seq TEXT PRIMARY KEY,
          embedding float[768] distance_metric=cosine
        );
      `);
    } catch (err) {
      console.warn('Failed to create vector table:', err);
      vecAvailable = false;
    }
  }
  
  const insertContentStmt = db.prepare(`
    INSERT OR IGNORE INTO content (hash, body) VALUES (?, ?)
  `);
  
  const insertDocumentStmt = db.prepare(`
    INSERT INTO documents (collection, path, title, hash, agent, created_at, modified_at, active, project_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      agent = excluded.agent,
      modified_at = excluded.modified_at,
      active = excluded.active,
      project_hash = excluded.project_hash
  `);
  
  const findDocumentByPathStmt = db.prepare(`
    SELECT id, collection, path, title, hash, agent, created_at as createdAt, modified_at as modifiedAt, active, project_hash as projectHash
    FROM documents WHERE path = ? AND active = 1
  `);
  
  const findDocumentByDocidStmt = db.prepare(`
    SELECT id, collection, path, title, hash, agent, created_at as createdAt, modified_at as modifiedAt, active, project_hash as projectHash
    FROM documents WHERE substr(hash, 1, 6) = ? AND active = 1
  `);
  
  const getContentStmt = db.prepare(`
    SELECT body FROM content WHERE hash = ?
  `);
  
  const deactivateDocumentStmt = db.prepare(`
    UPDATE documents SET active = 0 WHERE collection = ? AND path = ?
  `);
  
  const bulkDeactivateExceptStmt = db.prepare(`
    UPDATE documents SET active = 0 
    WHERE collection = ? AND path NOT IN (SELECT value FROM json_each(?))
  `);
  
  const searchFTSStmt = db.prepare(`
    SELECT 
      d.id, d.path, d.collection, d.title, d.hash, d.agent,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
      bm25(documents_fts) as score
    FROM documents_fts f
    JOIN documents d ON f.filepath = d.collection || '/' || d.path
    WHERE documents_fts MATCH ? AND d.active = 1
    ORDER BY bm25(documents_fts)
    LIMIT ?
  `);
  
  const searchFTSWithCollectionStmt = db.prepare(`
    SELECT 
      d.id, d.path, d.collection, d.title, d.hash, d.agent,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
      bm25(documents_fts) as score
    FROM documents_fts f
    JOIN documents d ON f.filepath = d.collection || '/' || d.path
    WHERE documents_fts MATCH ? AND d.active = 1 AND d.collection = ?
    ORDER BY bm25(documents_fts)
    LIMIT ?
  `);
  
  const searchFTSWithWorkspaceStmt = db.prepare(`
    SELECT 
      d.id, d.path, d.collection, d.title, d.hash, d.agent,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
      bm25(documents_fts) as score
    FROM documents_fts f
    JOIN documents d ON f.filepath = d.collection || '/' || d.path
    WHERE documents_fts MATCH ? AND d.active = 1 AND d.project_hash IN (?, 'global')
    ORDER BY bm25(documents_fts)
    LIMIT ?
  `);
  
  const searchFTSWithWorkspaceAndCollectionStmt = db.prepare(`
    SELECT 
      d.id, d.path, d.collection, d.title, d.hash, d.agent,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
      bm25(documents_fts) as score
    FROM documents_fts f
    JOIN documents d ON f.filepath = d.collection || '/' || d.path
    WHERE documents_fts MATCH ? AND d.active = 1 AND d.collection = ? AND d.project_hash IN (?, 'global')
    ORDER BY bm25(documents_fts)
    LIMIT ?
  `);
  
  const insertEmbeddingStmt = db.prepare(`
    INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model)
    VALUES (?, ?, ?, ?)
  `);
  
  const getCachedResultStmt = db.prepare(`
    SELECT result FROM llm_cache WHERE hash = ? AND project_hash = ?
  `);
  
  const setCachedResultStmt = db.prepare(`
    INSERT OR REPLACE INTO llm_cache (hash, project_hash, type, result) VALUES (?, ?, ?, ?)
  `);
  
  const getDocumentCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM documents WHERE active = 1
  `);
  
  const getEmbeddedCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM content_vectors
  `);
  
  const getCollectionStatsStmt = db.prepare(`
    SELECT collection as name, COUNT(*) as documentCount, MIN(path) as path
    FROM documents WHERE active = 1
    GROUP BY collection
  `);
  
  const getWorkspaceStatsStmt = db.prepare(`
    SELECT project_hash as projectHash, COUNT(*) as count
    FROM documents WHERE active = 1
    GROUP BY project_hash
  `);
  
  const getHashesNeedingEmbeddingStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL
  `);

  const getHashesNeedingEmbeddingByWorkspaceStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL AND d.project_hash IN (?, 'global')
  `);
  const getNextHashNeedingEmbeddingStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL
    LIMIT 1
  `);

  const getNextHashNeedingEmbeddingByWorkspaceStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL AND d.project_hash IN (?, 'global')
    LIMIT 1
  `);

  const insertFileEdgeStmt = db.prepare(`
    INSERT OR REPLACE INTO file_edges (source_path, target_path, edge_type, project_hash)
    VALUES (?, ?, ?, ?)
  `);

  const deleteFileEdgesStmt = db.prepare(`
    DELETE FROM file_edges WHERE source_path = ? AND project_hash = ?
  `);

  const getFileEdgesStmt = db.prepare(`
    SELECT source_path, target_path FROM file_edges WHERE project_hash = ?
  `);

  const updateCentralityStmt = db.prepare(`
    UPDATE documents SET centrality = ? WHERE collection = 'codebase' AND project_hash = ? AND path = ?
  `);

  const updateClusterIdStmt = db.prepare(`
    UPDATE documents SET cluster_id = ? WHERE collection = 'codebase' AND project_hash = ? AND path = ?
  `);

  const getEdgeSetHashStmt = db.prepare(`
    SELECT result FROM llm_cache WHERE hash = 'edge_hash' AND project_hash = ? AND type = 'edge_hash'
  `);

  const setEdgeSetHashStmt = db.prepare(`
    INSERT OR REPLACE INTO llm_cache (hash, project_hash, type, result) VALUES ('edge_hash', ?, 'edge_hash', ?)
  `);

  const supersedeDocumentStmt = db.prepare(`
    UPDATE documents SET superseded_by = ? WHERE id = ?
  `);
  
  return {
    modelStatus: {
      embedding: 'missing',
      reranker: 'missing',
      expander: 'missing',
    },
    
    close() {
      db.close();
    },
    
    insertContent(hash: string, body: string) {
      insertContentStmt.run(hash, body);
    },
    
    insertDocument(doc: Omit<Document, 'id'>): number {
      log('store', 'insertDocument collection=' + doc.collection + ' path=' + doc.path);
      const result = insertDocumentStmt.run(
        doc.collection,
        doc.path,
        doc.title,
        doc.hash,
        doc.agent ?? null,
        doc.createdAt,
        doc.modifiedAt,
        doc.active ? 1 : 0,
        doc.projectHash ?? 'global'
      );
      return Number(result.lastInsertRowid);
    },
    
    findDocument(pathOrDocid: string): Document | null {
      let row: Record<string, unknown> | undefined;
      
      if (pathOrDocid.length === 6 && /^[a-f0-9]+$/i.test(pathOrDocid)) {
        row = findDocumentByDocidStmt.get(pathOrDocid.toLowerCase()) as Record<string, unknown> | undefined;
      }
      
      if (!row) {
        row = findDocumentByPathStmt.get(pathOrDocid) as Record<string, unknown> | undefined;
      }
      
      if (!row) return null;
      
      return {
        id: row.id as number,
        collection: row.collection as string,
        path: row.path as string,
        title: row.title as string,
        hash: row.hash as string,
        agent: row.agent as string | undefined,
        createdAt: row.createdAt as string,
        modifiedAt: row.modifiedAt as string,
        active: Boolean(row.active),
        projectHash: row.projectHash as string | undefined,
      };
    },
    
    getDocumentBody(hash: string, fromLine?: number, maxLines?: number): string | null {
      const row = getContentStmt.get(hash) as { body: string } | undefined;
      if (!row) return null;
      
      if (fromLine === undefined && maxLines === undefined) {
        return row.body;
      }
      
      const lines = row.body.split('\n');
      const start = fromLine ?? 0;
      const end = maxLines !== undefined ? start + maxLines : lines.length;
      return lines.slice(start, end).join('\n');
    },
    
    deactivateDocument(collection: string, path: string) {
      deactivateDocumentStmt.run(collection, path);
    },
    
    bulkDeactivateExcept(collection: string, activePaths: string[]): number {
      const result = bulkDeactivateExceptStmt.run(collection, JSON.stringify(activePaths));
      return result.changes;
    },
    
    insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string) {
      log('store', 'insertEmbedding hash=' + hash.substring(0, 8) + ' seq=' + seq);
      insertEmbeddingStmt.run(hash, seq, pos, model);
      
      if (vecAvailable) {
        try {
          const hashSeq = `${hash}:${seq}`;
          // sqlite-vec virtual tables don't support INSERT OR REPLACE,
          // so delete first then insert to handle re-embedding
          try {
            db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hashSeq);
          } catch {
            // Ignore if row doesn't exist
          }
          const insertVecStmt = db.prepare(`
            INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)
          `);
          insertVecStmt.run(hashSeq, new Float32Array(embedding));
        } catch (err) {
          // Silently ignore duplicate key errors (vector already exists)
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('UNIQUE constraint')) {
            log('store', 'insertEmbedding vector insert failed hash=' + hash.substring(0, 8));
            console.warn('Failed to insert vector:', err);
          }
        }
      }
    },
    
    ensureVecTable(dimensions: number) {
      if (!vecAvailable) return;
      try {
        let needsRebuild = false;
        // Check if existing table has correct dimensions by trying a dummy query
        try {
          const testVec = new Float32Array(dimensions);
          db.prepare('SELECT hash_seq FROM vectors_vec WHERE embedding MATCH ? LIMIT 1').get(testVec);
          // Table exists with correct dimensions — check consistency
          const vecCount = (db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number }).count;
          const cvCount = (db.prepare('SELECT COUNT(*) as count FROM content_vectors').get() as { count: number }).count;
          if (vecCount === 0 && cvCount > 0) {
            // vectors_vec was rebuilt but content_vectors has stale tracking rows
            log('store', 'ensureVecTable clearing stale content_vectors count=' + cvCount);
            console.error(`[store] vectors_vec empty but content_vectors has ${cvCount} stale rows, clearing for re-embedding`);
            db.exec(`DELETE FROM content_vectors`);
          }
          return;
        } catch {
          needsRebuild = true;
        }
        if (needsRebuild) {
          log('store', 'ensureVecTable rebuilding dimensions=' + dimensions);
          db.exec(`DROP TABLE IF EXISTS vectors_vec`);
          db.exec(`DELETE FROM content_vectors`);
          db.exec(`DELETE FROM llm_cache`);
          db.exec(`
            CREATE VIRTUAL TABLE vectors_vec USING vec0(
              hash_seq TEXT PRIMARY KEY,
              embedding float[${dimensions}] distance_metric=cosine
            );
          `);
          console.error(`[store] Recreated vectors_vec with ${dimensions} dimensions, cleared content_vectors and llm_cache for re-embedding`);
        }
      } catch (err) {
        console.warn('Failed to recreate vector table:', err);
      }
    },
    
    searchFTS(query: string, options: StoreSearchOptions = {}): SearchResult[] {
      const { limit = 10, collection, projectHash, tags, since, until } = options;
      const sanitized = sanitizeFTS5Query(query);
      if (!sanitized) return [];
      
      let sql = `
        SELECT 
          d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
          d.centrality, d.cluster_id, d.superseded_by,
          snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
          bm25(documents_fts) as score
        FROM documents_fts f
        JOIN documents d ON f.filepath = d.collection || '/' || d.path
        WHERE documents_fts MATCH ? AND d.active = 1
      `;
      const params: (string | number)[] = [sanitized];
      
      if (collection) {
        sql += ` AND d.collection = ?`;
        params.push(collection);
      }
      if (projectHash && projectHash !== 'all') {
        sql += ` AND d.project_hash IN (?, 'global')`;
        params.push(projectHash);
      }
      if (since) {
        sql += ` AND d.modified_at >= ?`;
        params.push(since);
      }
      if (until) {
        sql += ` AND d.modified_at <= ?`;
        params.push(until);
      }
      if (tags && tags.length > 0) {
        sql += ` AND d.id IN (
          SELECT dt.document_id FROM document_tags dt
          WHERE dt.tag IN (${tags.map(() => '?').join(',')})
          GROUP BY dt.document_id
          HAVING COUNT(DISTINCT dt.tag) = ?
        )`;
        params.push(...tags.map(t => t.toLowerCase().trim()));
        params.push(tags.length);
      }
      
      sql += ` ORDER BY bm25(documents_fts) LIMIT ?`;
      params.push(limit);
      
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      log('store', 'searchFTS query=' + query + ' results=' + rows.length);
      
      return rows.map(row => ({
        id: String(row.id),
        path: row.path as string,
        collection: row.collection as string,
        title: row.title as string,
        snippet: row.snippet as string,
        score: Math.abs(row.score as number),
        startLine: 0,
        endLine: 0,
        docid: (row.hash as string).substring(0, 6),
        agent: row.agent as string | undefined,
        projectHash: projectHash === 'all' ? (row.project_hash as string | undefined) : undefined,
        centrality: row.centrality as number | undefined,
        clusterId: row.cluster_id as number | undefined,
        supersededBy: row.superseded_by as number | null | undefined,
      }));
    },
    
    searchVec(query: string, embedding: number[], options: StoreSearchOptions = {}): SearchResult[] {
      const { limit = 10, collection, projectHash, tags, since, until } = options;
      if (!vecAvailable) {
        return [];
      }
      
      try {
        let sql = `
          SELECT v.hash_seq, v.distance, d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
                 d.centrality, d.cluster_id, d.superseded_by,
                 substr(c.body, 1, 700) as snippet
          FROM vectors_vec v
          JOIN documents d ON substr(v.hash_seq, 1, instr(v.hash_seq, ':') - 1) = d.hash
          LEFT JOIN content c ON c.hash = d.hash
          WHERE v.embedding MATCH ?
            AND k = ?
            AND d.active = 1
        `;
        
        const params: (Float32Array | string | number)[] = [new Float32Array(embedding), limit];
        if (collection) {
          sql += ` AND d.collection = ?`;
          params.push(collection);
        }
        if (projectHash && projectHash !== 'all') {
          sql += ` AND d.project_hash IN (?, 'global')`;
          params.push(projectHash);
        }
        if (since) {
          sql += ` AND d.modified_at >= ?`;
          params.push(since);
        }
        if (until) {
          sql += ` AND d.modified_at <= ?`;
          params.push(until);
        }
        if (tags && tags.length > 0) {
          sql += ` AND d.id IN (
            SELECT dt.document_id FROM document_tags dt
            WHERE dt.tag IN (${tags.map(() => '?').join(',')})
            GROUP BY dt.document_id
            HAVING COUNT(DISTINCT dt.tag) = ?
          )`;
          params.push(...tags.map(t => t.toLowerCase().trim()));
          params.push(tags.length);
        }
        sql += ` ORDER BY v.distance`;
        
        const stmt = db.prepare(sql);
        const rows = stmt.all(...params) as Array<Record<string, unknown>>;
        log('store', 'searchVec query=' + query + ' results=' + rows.length);
        
        return rows.map(row => ({
          id: String(row.id),
          path: row.path as string,
          collection: row.collection as string,
          title: row.title as string,
          snippet: (row.snippet as string) || '',
          score: 1 - (row.distance as number),
          startLine: 0,
          endLine: 0,
          docid: (row.hash as string).substring(0, 6),
          agent: row.agent as string | undefined,
          projectHash: projectHash === 'all' ? (row.project_hash as string | undefined) : undefined,
          centrality: row.centrality as number | undefined,
          clusterId: row.cluster_id as number | undefined,
          supersededBy: row.superseded_by as number | null | undefined,
        }));
      } catch (err) {
        console.warn('Vector search failed:', err);
        return [];
      }
    },
    
    setVectorStore(vs: VectorStore): void {
      vectorStore = vs;
    },
    
    async searchVecAsync(query: string, embedding: number[], options: StoreSearchOptions = {}): Promise<SearchResult[]> {
      const { limit = 10, collection, projectHash, tags, since, until } = options;
      
      if (vectorStore) {
        try {
          const vecResults = await vectorStore.search(embedding, { limit, collection, projectHash });
          if (vecResults.length === 0) return [];
          
          const results: SearchResult[] = [];
          for (const vr of vecResults) {
            const row = db.prepare(`
              SELECT d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
                     d.centrality, d.cluster_id, d.superseded_by, d.modified_at,
                     substr(c.body, 1, 700) as snippet
              FROM documents d
              LEFT JOIN content c ON c.hash = d.hash
              WHERE d.hash = ? AND d.active = 1
              LIMIT 1
            `).get(vr.hash) as Record<string, unknown> | undefined;
            
            if (!row) continue;
            
            if (collection && row.collection !== collection) continue;
            if (projectHash && projectHash !== 'all' && row.project_hash !== projectHash && row.project_hash !== 'global') continue;
            if (since && (row.modified_at as string) < since) continue;
            if (until && (row.modified_at as string) > until) continue;
            if (tags && tags.length > 0) {
              const tagCount = (db.prepare(`
                SELECT COUNT(DISTINCT tag) as cnt FROM document_tags 
                WHERE document_id = ? AND tag IN (${tags.map(() => '?').join(',')})
              `).get(row.id, ...tags.map(t => t.toLowerCase().trim())) as { cnt: number }).cnt;
              if (tagCount < tags.length) continue;
            }
            
            results.push({
              id: String(row.id),
              path: row.path as string,
              collection: row.collection as string,
              title: row.title as string,
              snippet: (row.snippet as string) || '',
              score: vr.score,
              startLine: 0,
              endLine: 0,
              docid: (row.hash as string).substring(0, 6),
              agent: row.agent as string | undefined,
              projectHash: projectHash === 'all' ? (row.project_hash as string | undefined) : undefined,
              centrality: row.centrality as number | undefined,
              clusterId: row.cluster_id as number | undefined,
              supersededBy: row.superseded_by as number | null | undefined,
            });
          }
          
          log('store', 'searchVecAsync(qdrant) query=' + query + ' results=' + results.length);
          return results;
        } catch (err) {
          console.warn('Qdrant vector search failed, falling back to SQLite:', err);
        }
      }
      
      return this.searchVec(query, embedding, options);
    },
    
    getCachedResult(hash: string, projectHash: string = 'global'): string | null {
      const row = getCachedResultStmt.get(hash, projectHash) as { result: string } | undefined;
      return row?.result ?? null;
    },
    
    setCachedResult(hash: string, result: string, projectHash: string = 'global', type: string = 'general') {
      setCachedResultStmt.run(hash, projectHash, type, result);
    },
    
    getQueryEmbeddingCache(query: string): number[] | null {
      const key = computeHash('qembed:' + query);
      const cached = getCachedResultStmt.get(key, 'global') as { result: string } | undefined;
      if (!cached) return null;
      try {
        return JSON.parse(cached.result) as number[];
      } catch {
        return null;
      }
    },
    
    setQueryEmbeddingCache(query: string, embedding: number[]) {
      const key = computeHash('qembed:' + query);
      setCachedResultStmt.run(key, 'global', 'qembed', JSON.stringify(embedding));
    },
    
    clearQueryEmbeddingCache() {
      db.exec("DELETE FROM llm_cache WHERE type = 'qembed'");
    },
    
    getIndexHealth(): IndexHealth {
      const docCount = (getDocumentCountStmt.get() as { count: number }).count;
      const embeddedCount = (getEmbeddedCountStmt.get() as { count: number }).count;
      const collections = getCollectionStatsStmt.all() as Array<{ name: string; documentCount: number; path: string }>;
      const pending = (getHashesNeedingEmbeddingStmt.all() as unknown[]).length;
      const workspaceStats = this.getWorkspaceStats();
      
      let dbSize = 0;
      try {
        const stats = fs.statSync(dbPath);
        dbSize = stats.size;
      } catch {
        // ignore
      }
      
      return {
        documentCount: docCount,
        embeddedCount: embeddedCount,
        pendingEmbeddings: pending,
        collections: collections,
        databaseSize: dbSize,
        modelStatus: this.modelStatus,
        workspaceStats: workspaceStats,
      };
    },
    
    getHashesNeedingEmbedding(projectHash?: string): Array<{ hash: string; body: string; path: string }> {
      if (projectHash && projectHash !== 'all') {
        return getHashesNeedingEmbeddingByWorkspaceStmt.all(projectHash) as Array<{ hash: string; body: string; path: string }>;
      }
      return getHashesNeedingEmbeddingStmt.all() as Array<{ hash: string; body: string; path: string }>;
    },

    getNextHashNeedingEmbedding(projectHash?: string): { hash: string; body: string; path: string } | null {
      if (projectHash && projectHash !== 'all') {
        return getNextHashNeedingEmbeddingByWorkspaceStmt.get(projectHash) as { hash: string; body: string; path: string } | null;
      }
      return getNextHashNeedingEmbeddingStmt.get() as { hash: string; body: string; path: string } | null;
    },
    
    getWorkspaceStats(): Array<{ projectHash: string; count: number }> {
      return getWorkspaceStatsStmt.all() as Array<{ projectHash: string; count: number }>;
    },
    
    deleteDocumentsByPath(filePath: string): number {
      const deleteStmt = db.prepare(`DELETE FROM documents WHERE path = ? AND active = 1`);
      const result = deleteStmt.run(filePath);
      return result.changes;
    },

    clearWorkspace(projectHash: string): { documentsDeleted: number; embeddingsDeleted: number } {
      log('store', 'clearWorkspace projectHash=' + projectHash);
      const transaction = db.transaction(() => {
        // 1. Collect all documents for this workspace
        const docs = db.prepare(
          'SELECT id, hash, collection, path FROM documents WHERE project_hash = ?'
        ).all(projectHash) as Array<{ id: number; hash: string; collection: string; path: string }>;

        if (docs.length === 0) return { documentsDeleted: 0, embeddingsDeleted: 0 };

        // 2. Find hashes that are ONLY used by this workspace (orphaned after delete)
        const uniqueHashes = [...new Set(docs.map(d => d.hash))];
        const orphanedHashes: string[] = [];
        for (const hash of uniqueHashes) {
          const otherUses = db.prepare(
            'SELECT COUNT(*) as count FROM documents WHERE hash = ? AND project_hash != ?'
          ).get(hash, projectHash) as { count: number };
          if (otherUses.count === 0) {
            orphanedHashes.push(hash);
          }
        }

        // 3. Delete embeddings for orphaned hashes
        let embeddingsDeleted = 0;
        for (const hash of orphanedHashes) {
          const cvResult = db.prepare('DELETE FROM content_vectors WHERE hash = ?').run(hash);
          embeddingsDeleted += cvResult.changes;
          if (vecAvailable) {
            try {
              db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? || ':%'").run(hash);
            } catch { /* vec table may not exist */ }
          }
        }

        // 4. Delete the documents (AFTER DELETE trigger handles FTS cleanup)
        const deleteResult = db.prepare('DELETE FROM documents WHERE project_hash = ?').run(projectHash);

        // 5. Delete orphaned content
        for (const hash of orphanedHashes) {
          db.prepare('DELETE FROM content WHERE hash = ?').run(hash);
        }

        // 6. Delete cache entries for this workspace
        db.prepare('DELETE FROM llm_cache WHERE project_hash = ?').run(projectHash);

        log('store', 'clearWorkspace result docs=' + deleteResult.changes + ' embeddings=' + embeddingsDeleted);
        return { documentsDeleted: deleteResult.changes, embeddingsDeleted };
      });
      return transaction();
    },
    
    cleanOrphanedEmbeddings(): number {
      let totalDeleted = 0;
      
      const deleteContentVectorsStmt = db.prepare(`
        DELETE FROM content_vectors WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
      `);
      const cvResult = deleteContentVectorsStmt.run();
      totalDeleted += cvResult.changes;
      
      if (vecAvailable) {
        try {
          const deleteVecStmt = db.prepare(`
            DELETE FROM vectors_vec WHERE substr(hash_seq, 1, instr(hash_seq, ':') - 1) NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
          `);
          const vecResult = deleteVecStmt.run();
          totalDeleted += vecResult.changes;
        } catch {
        }
      }
      
      log('store', 'cleanOrphanedEmbeddings deleted=' + totalDeleted);
      return totalDeleted;
    },
    
    getCollectionStorageSize(collection: string): number {
      const stmt = db.prepare(`
        SELECT COALESCE(SUM(LENGTH(c.body)), 0) as totalSize
        FROM documents d
        JOIN content c ON c.hash = d.hash
        WHERE d.collection = ? AND d.active = 1
      `);
      const row = stmt.get(collection) as { totalSize: number } | undefined;
      return row?.totalSize ?? 0;
    },
    
    clearCache(projectHash?: string, type?: string): number {
      let sql = 'DELETE FROM llm_cache';
      const conditions: string[] = [];
      const params: string[] = [];
      if (projectHash) {
        conditions.push('project_hash = ?');
        params.push(projectHash);
      }
      if (type) {
        conditions.push('type = ?');
        params.push(type);
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      const result = db.prepare(sql).run(...params);
      return result.changes;
    },
    
    getCacheStats(): Array<{ type: string; projectHash: string; count: number }> {
      return db.prepare('SELECT type, project_hash as projectHash, COUNT(*) as count FROM llm_cache GROUP BY type, project_hash ORDER BY count DESC').all() as Array<{ type: string; projectHash: string; count: number }>;
    },

    insertFileEdge(sourcePath: string, targetPath: string, projectHash: string, edgeType: string = 'import') {
      insertFileEdgeStmt.run(sourcePath, targetPath, edgeType, projectHash);
    },

    deleteFileEdges(sourcePath: string, projectHash: string) {
      deleteFileEdgesStmt.run(sourcePath, projectHash);
    },

    getFileEdges(projectHash: string): Array<{ source_path: string; target_path: string }> {
      return getFileEdgesStmt.all(projectHash) as Array<{ source_path: string; target_path: string }>;
    },

    updateCentralityScores(projectHash: string, scores: Map<string, number>) {
      for (const [filePath, score] of scores) {
        updateCentralityStmt.run(score, projectHash, filePath);
      }
    },

    updateClusterIds(projectHash: string, clusters: Map<string, number>) {
      for (const [filePath, clusterId] of clusters) {
        updateClusterIdStmt.run(clusterId, projectHash, filePath);
      }
    },

    getEdgeSetHash(projectHash: string): string | null {
      const row = getEdgeSetHashStmt.get(projectHash) as { result: string } | undefined;
      return row?.result ?? null;
    },

    setEdgeSetHash(projectHash: string, hash: string) {
      setEdgeSetHashStmt.run(projectHash, hash);
    },

    supersedeDocument(targetId: number, newId: number) {
      supersedeDocumentStmt.run(newId, targetId);
    },

    insertTags(documentId: number, tags: string[]) {
      const insertTagStmt = db.prepare(`INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)`);
      const uniqueTags = [...new Set(tags.map(t => t.toLowerCase().trim()).filter(t => t.length > 0))];
      for (const tag of uniqueTags) {
        insertTagStmt.run(documentId, tag);
      }
    },

    getDocumentTags(documentId: number): string[] {
      const rows = db.prepare(`SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`).all(documentId) as Array<{ tag: string }>;
      return rows.map(r => r.tag);
    },

    listAllTags(): Array<{ tag: string; count: number }> {
      return db.prepare(`
        SELECT tag, COUNT(*) as count 
        FROM document_tags 
        GROUP BY tag 
        ORDER BY count DESC, tag ASC
      `).all() as Array<{ tag: string; count: number }>;
    },

    getFileDependencies(filePath: string, projectHash: string): string[] {
      const rows = db.prepare(`
        SELECT target_path FROM file_edges 
        WHERE source_path = ? AND project_hash = ?
      `).all(filePath, projectHash) as Array<{ target_path: string }>;
      return rows.map(r => r.target_path);
    },

    getFileDependents(filePath: string, projectHash: string): string[] {
      const rows = db.prepare(`
        SELECT source_path FROM file_edges 
        WHERE target_path = ? AND project_hash = ?
      `).all(filePath, projectHash) as Array<{ source_path: string }>;
      return rows.map(r => r.source_path);
    },

    getDocumentCentrality(filePath: string): { centrality: number; clusterId: number | null } | null {
      const row = db.prepare(`
        SELECT centrality, cluster_id FROM documents 
        WHERE path = ? AND active = 1
      `).get(filePath) as { centrality: number; cluster_id: number | null } | undefined;
      if (!row) return null;
      return { centrality: row.centrality ?? 0, clusterId: row.cluster_id };
    },

    getClusterMembers(clusterId: number, projectHash: string): string[] {
      const rows = db.prepare(`
        SELECT path FROM documents 
        WHERE cluster_id = ? AND project_hash = ? AND active = 1
        ORDER BY centrality DESC
      `).all(clusterId, projectHash) as Array<{ path: string }>;
      return rows.map(r => r.path);
    },

    getGraphStats(projectHash: string): {
      nodeCount: number;
      edgeCount: number;
      clusterCount: number;
      topCentrality: Array<{ path: string; centrality: number }>;
    } {
      const edges = db.prepare(`
        SELECT COUNT(*) as count FROM file_edges WHERE project_hash = ?
      `).get(projectHash) as { count: number };
      
      const nodes = db.prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT source_path as node FROM file_edges WHERE project_hash = ?
          UNION
          SELECT target_path as node FROM file_edges WHERE project_hash = ?
        )
      `).get(projectHash, projectHash) as { count: number };
      
      const clusters = db.prepare(`
        SELECT COUNT(DISTINCT cluster_id) as count FROM documents 
        WHERE project_hash = ? AND cluster_id IS NOT NULL AND active = 1
      `).get(projectHash) as { count: number };
      
      const topCentrality = db.prepare(`
        SELECT path, centrality FROM documents 
        WHERE project_hash = ? AND active = 1 AND centrality > 0
        ORDER BY centrality DESC
        LIMIT 10
      `).all(projectHash) as Array<{ path: string; centrality: number }>;
      
      return {
        nodeCount: nodes.count,
        edgeCount: edges.count,
        clusterCount: clusters.count,
        topCentrality,
      };
    },

    insertSymbol(symbol: {
      type: string;
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
      rawExpression: string;
      projectHash: string;
    }) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        symbol.type,
        symbol.pattern,
        symbol.operation,
        symbol.repo,
        symbol.filePath,
        symbol.lineNumber,
        symbol.rawExpression,
        symbol.projectHash
      );
    },

    deleteSymbols(filePath: string, projectHash: string) {
      const stmt = db.prepare(`DELETE FROM symbols WHERE file_path = ? AND project_hash = ?`);
      stmt.run(filePath, projectHash);
    },

    querySymbols(options: {
      type?: string;
      pattern?: string;
      repo?: string;
      operation?: string;
      projectHash?: string;
    }): Array<{
      type: string;
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
      rawExpression: string;
    }> {
      let sql = `SELECT type, pattern, operation, repo, file_path as filePath, line_number as lineNumber, raw_expression as rawExpression FROM symbols WHERE 1=1`;
      const params: string[] = [];

      if (options.type) {
        sql += ` AND type = ?`;
        params.push(options.type);
      }
      if (options.pattern) {
        const likePattern = options.pattern.replace(/\*/g, '%');
        sql += ` AND pattern LIKE ?`;
        params.push(likePattern);
      }
      if (options.repo) {
        sql += ` AND repo = ?`;
        params.push(options.repo);
      }
      if (options.operation) {
        sql += ` AND operation = ?`;
        params.push(options.operation);
      }
      if (options.projectHash) {
        sql += ` AND project_hash = ?`;
        params.push(options.projectHash);
      }

      sql += ` ORDER BY type, pattern, repo, file_path`;

      return db.prepare(sql).all(...params) as Array<{
        type: string;
        pattern: string;
        operation: string;
        repo: string;
        filePath: string;
        lineNumber: number;
        rawExpression: string;
      }>;
    },

    getSymbolImpact(type: string, pattern: string, projectHash?: string): Array<{
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
    }> {
      const likePattern = pattern.replace(/\*/g, '%');
      let sql = `
        SELECT pattern, operation, repo, file_path as filePath, line_number as lineNumber
        FROM symbols
        WHERE type = ? AND pattern LIKE ?
      `;
      const params: string[] = [type, likePattern];

      if (projectHash) {
        sql += ` AND project_hash = ?`;
        params.push(projectHash);
      }

      sql += ` ORDER BY operation, repo, file_path`;

      return db.prepare(sql).all(...params) as Array<{
        pattern: string;
        operation: string;
        repo: string;
        filePath: string;
        lineNumber: number;
      }>;
    },
  };
}

export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Extract projectHash from a session file path.
 * Matches pattern: {sessionsDir}/{12-char-hex}/*.md
 * Returns undefined for non-session files.
 */
export function extractProjectHashFromPath(filePath: string, sessionsDir: string): string | undefined {
  if (!filePath || !sessionsDir) return undefined;
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedSessions = sessionsDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalizedFile.startsWith(normalizedSessions + '/')) return undefined;
  const relativePath = normalizedFile.slice(normalizedSessions.length + 1);
  const firstSlash = relativePath.indexOf('/');
  if (firstSlash === -1) return undefined;
  const subdirName = relativePath.slice(0, firstSlash);
  if (subdirName.length !== 12) return undefined;
  if (!/^[a-f0-9]{12}$/i.test(subdirName)) return undefined;
  return subdirName.toLowerCase();
}

export function indexDocument(
  store: Store,
  collection: string,
  filePath: string,
  content: string,
  title: string,
  projectHash?: string
): { hash: string; chunks: number; skipped: boolean } {
  const hash = computeHash(content);
  
  const existingDoc = store.findDocument(filePath);
  if (existingDoc && existingDoc.hash === hash) {
    return { hash, chunks: 0, skipped: true };
  }
  
  store.insertContent(hash, content);
  
  const chunks = chunkMarkdown(content, hash);
  
  const now = new Date().toISOString();
  store.insertDocument({
    collection,
    path: filePath,
    title,
    hash,
    createdAt: existingDoc?.createdAt ?? now,
    modifiedAt: now,
    active: true,
    projectHash,
  });
  
  return { hash, chunks: chunks.length, skipped: false };
}
