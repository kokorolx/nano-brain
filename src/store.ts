import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Store, Document, SearchResult, IndexHealth, StoreSearchOptions, RemoveWorkspaceResult } from './types.js';
import type { VectorStore, VectorPoint } from './vector-store.js';
import { SqliteVecStore } from './providers/sqlite-vec.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chunkMarkdown } from './chunker.js';
import { log } from './logger.js';
import { checkAndRecoverDB, type CorruptionRecoveryResult } from './db/corruption-recovery.js';
import { incrementCounter } from './metrics.js';

export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 15000');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864');
}

export function openDatabase(dbPath: string, opts?: { readonly?: boolean }): Database.Database {
  const db = new Database(dbPath, opts);
  applyPragmas(db);
  return db;
}

let lastCorruptionRecovery: CorruptionRecoveryResult | null = null;

export function getLastCorruptionRecovery(): CorruptionRecoveryResult | null {
  return lastCorruptionRecovery;
}

export function clearCorruptionRecovery(): void {
  lastCorruptionRecovery = null;
}

export function sanitizeFTS5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const quotedTokens = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  if (quotedTokens.length === 1) return quotedTokens[0];
  return quotedTokens.join(' OR ');
}

export function createStore(dbPath: string): Store {
  log('store', 'createStore dbPath=' + dbPath);
  
  const recoveryResult = checkAndRecoverDB(dbPath, {
    logger: { log, error: console.error },
    metricsCallback: (event: string) => {
      if (event === 'corruption_detected') {
        incrementCounter('database_corruption_detected');
      }
    }
  });
  
  const db = recoveryResult.db;
  if (recoveryResult.recovered) {
    lastCorruptionRecovery = recoveryResult;
    log('store', `Database recovered from corruption at ${recoveryResult.recoveredAt}`);
  }
  
  applyPragmas(db);
  
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
    CREATE INDEX IF NOT EXISTS idx_symbols_file_project ON symbols(file_path, project_hash);
    CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified_at) WHERE active = 1;

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

    CREATE TABLE IF NOT EXISTS token_usage (
      model TEXT PRIMARY KEY,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS search_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      query_text TEXT NOT NULL,
      tier TEXT NOT NULL,
      config_variant TEXT,
      result_docids TEXT NOT NULL DEFAULT '[]',
      expanded_indices TEXT NOT NULL DEFAULT '[]',
      execution_ms INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      feedback_signal TEXT NOT NULL DEFAULT 'neutral',
      cache_key TEXT,
      workspace_hash TEXT NOT NULL DEFAULT 'global'
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON search_telemetry(timestamp);
    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON search_telemetry(session_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_config ON search_telemetry(config_variant);
    CREATE INDEX IF NOT EXISTS idx_telemetry_cache_key ON search_telemetry(cache_key);
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
  
  // Schema versioning
  const currentVersion = (db.pragma('user_version') as Array<{ user_version: number }>)[0].user_version;
  const TARGET_VERSION = 3;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bandit_stats (
        parameter_name TEXT NOT NULL,
        variant_value REAL NOT NULL,
        successes INTEGER NOT NULL DEFAULT 1,
        failures INTEGER NOT NULL DEFAULT 1,
        workspace_hash TEXT NOT NULL DEFAULT 'global',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (parameter_name, variant_value, workspace_hash)
      );

      CREATE TABLE IF NOT EXISTS config_versions (
        version_id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_json TEXT NOT NULL,
        expand_rate REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS consolidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        insight TEXT NOT NULL,
        connections TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS importance_scores (
        doc_hash TEXT PRIMARY KEY,
        usage_count INTEGER NOT NULL DEFAULT 0,
        entity_density REAL NOT NULL DEFAULT 0.0,
        last_accessed TEXT,
        connection_count INTEGER NOT NULL DEFAULT 0,
        importance_score REAL NOT NULL DEFAULT 0.0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS workspace_profiles (
        workspace_hash TEXT PRIMARY KEY,
        profile_data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS global_learning (
        parameter_name TEXT PRIMARY KEY,
        value REAL NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    
    db.pragma(`user_version = 1`);
    log('store', 'Schema migrated to version 1 (self-learning tables)');
  }

  if (currentVersion < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS query_chain_membership (
        chain_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        workspace_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chain_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_chain_workspace ON query_chain_membership(workspace_hash);
      CREATE INDEX IF NOT EXISTS idx_telemetry_ws_session_ts ON search_telemetry(workspace_hash, session_id, timestamp);

      CREATE TABLE IF NOT EXISTS query_clusters (
        cluster_id INTEGER NOT NULL,
        centroid_embedding TEXT NOT NULL,
        representative_query TEXT NOT NULL,
        query_count INTEGER NOT NULL DEFAULT 0,
        workspace_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (cluster_id, workspace_hash)
      );

      CREATE TABLE IF NOT EXISTS cluster_transitions (
        from_cluster_id INTEGER NOT NULL,
        to_cluster_id INTEGER NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 0,
        probability REAL NOT NULL DEFAULT 0.0,
        workspace_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (from_cluster_id, to_cluster_id, workspace_hash)
      );

      CREATE TABLE IF NOT EXISTS global_transitions (
        from_cluster_id INTEGER NOT NULL,
        to_cluster_id INTEGER NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 0,
        probability REAL NOT NULL DEFAULT 0.0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (from_cluster_id, to_cluster_id)
      );
    `);
    db.pragma(`user_version = 2`);
    log('store', 'Schema migrated to version 2 (proactive intelligence tables)');
  }

  if (currentVersion < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS suggestion_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suggested_query TEXT NOT NULL,
        actual_next_query TEXT NOT NULL,
        match_type TEXT NOT NULL DEFAULT 'none',
        workspace_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_workspace ON suggestion_feedback(workspace_hash);
    `);
    db.pragma(`user_version = 3`);
    log('store', 'Schema migrated to version 3 (suggestion feedback table)');
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
    WHERE cv.hash IS NULL AND d.collection != 'sessions'
    LIMIT ?
  `);

  const getHashesNeedingEmbeddingByWorkspaceStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL AND d.collection != 'sessions' AND d.project_hash IN (?, 'global')
    LIMIT ?
  `);
  const getNextHashNeedingEmbeddingStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL AND d.collection != 'sessions'
    LIMIT 1
  `);

  const getNextHashNeedingEmbeddingByWorkspaceStmt = db.prepare(`
    SELECT c.hash, c.body, d.path
    FROM content c
    JOIN documents d ON d.hash = c.hash AND d.active = 1
    LEFT JOIN content_vectors cv ON cv.hash = c.hash
    WHERE cv.hash IS NULL AND d.collection != 'sessions' AND d.project_hash IN (?, 'global')
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

  const recordTokenUsageStmt = db.prepare(`
    INSERT INTO token_usage (model, total_tokens, request_count, last_updated)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(model) DO UPDATE SET
      total_tokens = total_tokens + excluded.total_tokens,
      request_count = request_count + 1,
      last_updated = datetime('now')
  `);

  const getTokenUsageStmt = db.prepare(`SELECT model, total_tokens as totalTokens, request_count as requestCount, last_updated as lastUpdated FROM token_usage ORDER BY total_tokens DESC`);

  const insertTelemetryStmt = db.prepare(`
    INSERT INTO search_telemetry (query_id, query_text, tier, config_variant, result_docids, execution_ms, session_id, cache_key, workspace_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateTelemetryExpandStmt = db.prepare(`
    UPDATE search_telemetry SET expanded_indices = ?, feedback_signal = 'positive'
    WHERE cache_key = ? AND feedback_signal = 'neutral'
  `);

  const updateTelemetryReformulationStmt = db.prepare(`
    UPDATE search_telemetry SET feedback_signal = 'negative'
    WHERE id = ?
  `);

  const getRecentQueriesStmt = db.prepare(`
    SELECT id, query_text, timestamp FROM search_telemetry
    WHERE session_id = ? AND timestamp > datetime('now', '-60 seconds')
    ORDER BY timestamp DESC LIMIT 5
  `);

  const purgeTelemetryStmt = db.prepare(`
    DELETE FROM search_telemetry WHERE timestamp < datetime('now', '-' || ? || ' days')
  `);

  const getTelemetryCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM search_telemetry
  `);

  const upsertBanditStmt = db.prepare(`
    INSERT INTO bandit_stats (parameter_name, variant_value, successes, failures, workspace_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(parameter_name, variant_value, workspace_hash) DO UPDATE SET
      successes = excluded.successes,
      failures = excluded.failures,
      updated_at = datetime('now')
  `);

  const getBanditStatsStmt = db.prepare(`
    SELECT parameter_name, variant_value, successes, failures
    FROM bandit_stats WHERE workspace_hash = ?
  `);

  const insertConfigVersionStmt = db.prepare(`
    INSERT INTO config_versions (config_json, expand_rate) VALUES (?, ?)
  `);

  const getLatestConfigVersionStmt = db.prepare(`
    SELECT version_id, config_json, expand_rate, created_at
    FROM config_versions ORDER BY version_id DESC LIMIT 1
  `);

  const getConfigVersionStmt = db.prepare(`
    SELECT version_id, config_json, expand_rate, created_at
    FROM config_versions WHERE version_id = ?
  `);

  const getWorkspaceProfileStmt = db.prepare(`
    SELECT workspace_hash, profile_data, updated_at FROM workspace_profiles WHERE workspace_hash = ?
  `);

  const upsertWorkspaceProfileStmt = db.prepare(`
    INSERT INTO workspace_profiles (workspace_hash, profile_data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(workspace_hash) DO UPDATE SET
      profile_data = excluded.profile_data,
      updated_at = datetime('now')
  `);

  const upsertGlobalLearningStmt = db.prepare(`
    INSERT INTO global_learning (parameter_name, value, confidence, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(parameter_name) DO UPDATE SET
      value = excluded.value,
      confidence = excluded.confidence,
      updated_at = datetime('now')
  `);

  const getGlobalLearningStmt = db.prepare(`
    SELECT parameter_name, value, confidence FROM global_learning
  `);

  const getTelemetryStatsStmt = db.prepare(`
    SELECT COUNT(*) as queryCount, SUM(CASE WHEN feedback_signal = 'positive' THEN 1 ELSE 0 END) as expandCount
    FROM search_telemetry WHERE workspace_hash = ?
  `);

  const getTelemetryQueryTextsStmt = db.prepare(`
    SELECT query_text FROM search_telemetry WHERE workspace_hash = ? ORDER BY timestamp DESC LIMIT 500
  `);

  const insertChainMembershipStmt = db.prepare(`
    INSERT OR REPLACE INTO query_chain_membership (chain_id, query_id, position, workspace_hash)
    VALUES (?, ?, ?, ?)
  `);

  const getChainsByWorkspaceStmt = db.prepare(`
    SELECT chain_id, query_id, position FROM query_chain_membership
    WHERE workspace_hash = ? ORDER BY chain_id, position LIMIT ?
  `);

  const getRecentTelemetryQueriesStmt = db.prepare(`
    SELECT id, query_id, query_text, timestamp, session_id FROM search_telemetry
    WHERE workspace_hash = ? ORDER BY timestamp DESC LIMIT ?
  `);

  const upsertQueryClusterStmt = db.prepare(`
    INSERT INTO query_clusters (cluster_id, centroid_embedding, representative_query, query_count, workspace_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cluster_id, workspace_hash) DO UPDATE SET
      centroid_embedding = excluded.centroid_embedding,
      representative_query = excluded.representative_query,
      query_count = excluded.query_count,
      updated_at = datetime('now')
  `);

  const getQueryClustersStmt = db.prepare(`
    SELECT cluster_id, centroid_embedding, representative_query, query_count
    FROM query_clusters WHERE workspace_hash = ? ORDER BY cluster_id
  `);

  const clearQueryClustersStmt = db.prepare(`
    DELETE FROM query_clusters WHERE workspace_hash = ?
  `);

  const upsertClusterTransitionStmt = db.prepare(`
    INSERT INTO cluster_transitions (from_cluster_id, to_cluster_id, frequency, probability, workspace_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(from_cluster_id, to_cluster_id, workspace_hash) DO UPDATE SET
      frequency = excluded.frequency,
      probability = excluded.probability,
      updated_at = datetime('now')
  `);

  const getClusterTransitionsStmt = db.prepare(`
    SELECT from_cluster_id, to_cluster_id, frequency, probability
    FROM cluster_transitions WHERE workspace_hash = ? ORDER BY frequency DESC
  `);

  const getTransitionsFromStmt = db.prepare(`
    SELECT to_cluster_id, frequency, probability
    FROM cluster_transitions WHERE from_cluster_id = ? AND workspace_hash = ?
    ORDER BY probability DESC LIMIT ?
  `);

  const clearClusterTransitionsStmt = db.prepare(`
    DELETE FROM cluster_transitions WHERE workspace_hash = ?
  `);

  const upsertGlobalTransitionStmt = db.prepare(`
    INSERT INTO global_transitions (from_cluster_id, to_cluster_id, frequency, probability, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(from_cluster_id, to_cluster_id) DO UPDATE SET
      frequency = excluded.frequency,
      probability = excluded.probability,
      updated_at = datetime('now')
  `);

  const getGlobalTransitionsStmt = db.prepare(`
    SELECT from_cluster_id, to_cluster_id, frequency, probability
    FROM global_transitions ORDER BY frequency DESC
  `);

  const getGlobalTransitionsFromStmt = db.prepare(`
    SELECT to_cluster_id, frequency, probability
    FROM global_transitions WHERE from_cluster_id = ?
    ORDER BY probability DESC LIMIT ?
  `);

  const clearGlobalTransitionsStmt = db.prepare(`
    DELETE FROM global_transitions
  `);

  const insertSuggestionFeedbackStmt = db.prepare(`
    INSERT INTO suggestion_feedback (suggested_query, actual_next_query, match_type, workspace_hash)
    VALUES (?, ?, ?, ?)
  `);

  const getSuggestionAccuracyStmt = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN match_type = 'exact' THEN 1 ELSE 0 END) as exact,
      SUM(CASE WHEN match_type = 'partial' THEN 1 ELSE 0 END) as partial,
      SUM(CASE WHEN match_type = 'none' THEN 1 ELSE 0 END) as none
    FROM suggestion_feedback WHERE workspace_hash = ?
  `);
  
  return {
    modelStatus: {
      embedding: 'missing',
      reranker: 'missing',
      expander: 'missing',
    },
    
    getDb() {
      return db;
    },
    
    close() {
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore checkpoint errors */ }
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
      // For UPSERT (ON CONFLICT DO UPDATE), lastInsertRowid returns a phantom
      // autoincrement value that doesn't correspond to any actual row.
      // Always verify via lookup to get the real id.
      const existing = findDocumentByPathStmt.get(doc.path) as { id: number } | undefined;
      if (existing) return existing.id;
      const rowid = Number(result.lastInsertRowid);
      if (rowid > 0) return rowid;
      return 0;
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
      const beforeHashes = new Set<string>();
      if (vectorStore) {
        const rows = db.prepare('SELECT DISTINCT hash FROM documents WHERE collection = ? AND active = 1').all(collection) as Array<{ hash: string }>;
        for (const r of rows) beforeHashes.add(r.hash);
      }
      
      db.exec('CREATE TEMP TABLE IF NOT EXISTS _active_paths(path TEXT PRIMARY KEY)');
      db.exec('DELETE FROM _active_paths');
      const insertPath = db.prepare('INSERT OR IGNORE INTO _active_paths(path) VALUES(?)');
      const insertMany = db.transaction((paths: string[]) => {
        for (const p of paths) insertPath.run(p);
      });
      insertMany(activePaths);
      const updateStmt = db.prepare('UPDATE documents SET active = 0 WHERE collection = ? AND path NOT IN (SELECT path FROM _active_paths)');
      const result = updateStmt.run(collection);
      db.exec('DROP TABLE IF EXISTS _active_paths');
      
      if (vectorStore && beforeHashes.size > 0) {
        const afterRows = db.prepare('SELECT DISTINCT hash FROM documents WHERE collection = ? AND active = 1').all(collection) as Array<{ hash: string }>;
        const afterHashes = new Set(afterRows.map(r => r.hash));
        for (const hash of beforeHashes) {
          if (!afterHashes.has(hash)) {
            vectorStore.deleteByHash(hash).catch(err => {
              log('store', 'bulkDeactivateExcept vector cleanup failed hash=' + hash.substring(0, 8));
              console.warn('[store] Failed to cleanup vector:', err);
            });
          }
        }
      }
      
      return result.changes;
    },
    
    insertEmbeddingLocal(hash: string, seq: number, pos: number, model: string, filePath?: string) {
      const pathSuffix = filePath ? ' path=' + filePath : '';
      log('store', 'insertEmbeddingLocal hash=' + hash.substring(0, 8) + ' seq=' + seq + pathSuffix, 'debug');
      insertEmbeddingStmt.run(hash, seq, pos, model);
    },

    insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string, externalVectorStore?: VectorStore) {
      log('store', 'insertEmbedding hash=' + hash.substring(0, 8) + ' seq=' + seq, 'debug');
      insertEmbeddingStmt.run(hash, seq, pos, model);
      
      const useExternalStore = externalVectorStore && !(externalVectorStore instanceof SqliteVecStore);
      
      if (useExternalStore) {
        const point: VectorPoint = {
          id: `${hash}:${seq}`,
          embedding,
          metadata: { hash, seq, pos, model },
        };
        externalVectorStore.upsert(point).catch((err) => {
          log('store', 'insertEmbedding external vector store upsert failed hash=' + hash.substring(0, 8));
          console.warn(`[store] External vector store upsert failed for ${hash.substring(0, 8)}:${seq}, will retry on next embedding cycle:`, err);
        });
      } else if (vecAvailable) {
        try {
          const hashSeq = `${hash}:${seq}`;
          try {
            db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(hashSeq);
          } catch {
          }
          const insertVecStmt = db.prepare(`
            INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)
          `);
          insertVecStmt.run(hashSeq, new Float32Array(embedding));
        } catch (err) {
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
      log('store', 'searchFTS query=' + query + ' results=' + rows.length, 'debug');
      
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
        log('store', 'searchVec query=' + query + ' results=' + rows.length, 'debug');
        
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
    
    getVectorStore(): VectorStore | null {
      return vectorStore;
    },
    
    cleanupVectorsForHash(hash: string): void {
      if (vectorStore) {
        vectorStore.deleteByHash(hash).catch(err => {
          log('store', 'cleanupVectorsForHash failed hash=' + hash.substring(0, 8));
          console.warn('[store] Failed to cleanup vectors for hash:', err);
        });
      }
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
          
          log('store', 'searchVecAsync(qdrant) query=' + query + ' results=' + results.length, 'debug');
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
      const pending = (getHashesNeedingEmbeddingStmt.all(1000000) as unknown[]).length;
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
    
    getHashesNeedingEmbedding(projectHash?: string, limit?: number): Array<{ hash: string; body: string; path: string }> {
      const effectiveLimit = limit ?? 1000000;
      if (projectHash && projectHash !== 'all') {
        return getHashesNeedingEmbeddingByWorkspaceStmt.all(projectHash, effectiveLimit) as Array<{ hash: string; body: string; path: string }>;
      }
      return getHashesNeedingEmbeddingStmt.all(effectiveLimit) as Array<{ hash: string; body: string; path: string }>;
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
      log('store', 'clearWorkspace project=' + resolveProjectLabel(projectHash));
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

    removeWorkspace(projectHash: string): RemoveWorkspaceResult {
      log('store', 'removeWorkspace project=' + resolveProjectLabel(projectHash));
      const transaction = db.transaction(() => {
        // 1. Delete execution_flows (flow_steps cascade via FK)
        const flowsResult = db.prepare('DELETE FROM execution_flows WHERE project_hash = ?').run(projectHash);

        // 2. Delete symbol_edges
        const symbolEdgesResult = db.prepare('DELETE FROM symbol_edges WHERE project_hash = ?').run(projectHash);

        // 3. Delete code_symbols
        const codeSymbolsResult = db.prepare('DELETE FROM code_symbols WHERE project_hash = ?').run(projectHash);

        // 4. Delete symbols
        const symbolsResult = db.prepare('DELETE FROM symbols WHERE project_hash = ?').run(projectHash);

        // 5. Delete file_edges
        const fileEdgesResult = db.prepare('DELETE FROM file_edges WHERE project_hash = ?').run(projectHash);

        // 6. Collect all documents for this workspace
        const docs = db.prepare(
          'SELECT id, hash, collection, path FROM documents WHERE project_hash = ?'
        ).all(projectHash) as Array<{ id: number; hash: string; collection: string; path: string }>;

        let embeddingsDeleted = 0;
        let contentDeleted = 0;

        if (docs.length > 0) {
          // 7. Find hashes that are ONLY used by this workspace (orphaned after delete)
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

          // 8. Delete embeddings for orphaned hashes
          for (const hash of orphanedHashes) {
            const cvResult = db.prepare('DELETE FROM content_vectors WHERE hash = ?').run(hash);
            embeddingsDeleted += cvResult.changes;
            if (vecAvailable) {
              try {
                db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? || ':%'").run(hash);
              } catch { /* vec table may not exist */ }
            }
          }

          // 9. Delete the documents (AFTER DELETE trigger handles FTS cleanup)
          db.prepare('DELETE FROM documents WHERE project_hash = ?').run(projectHash);

          // 10. Delete orphaned content
          for (const hash of orphanedHashes) {
            db.prepare('DELETE FROM content WHERE hash = ?').run(hash);
            contentDeleted++;
          }
        }

        // 11. Delete cache entries for this workspace
        const cacheResult = db.prepare('DELETE FROM llm_cache WHERE project_hash = ?').run(projectHash);

        const result: RemoveWorkspaceResult = {
          documentsDeleted: docs.length,
          embeddingsDeleted,
          contentDeleted,
          cacheDeleted: cacheResult.changes,
          fileEdgesDeleted: fileEdgesResult.changes,
          symbolsDeleted: symbolsResult.changes,
          codeSymbolsDeleted: codeSymbolsResult.changes,
          symbolEdgesDeleted: symbolEdgesResult.changes,
          executionFlowsDeleted: flowsResult.changes,
        };

        log('store', 'removeWorkspace result=' + JSON.stringify(result));
        return result;
      });
      return transaction();
    },
    
    cleanOrphanedEmbeddings(): number {
      let totalDeleted = 0;
      
      let orphanedHashes: string[] = [];
      if (vectorStore) {
        orphanedHashes = (db.prepare(`
          SELECT DISTINCT hash FROM content_vectors WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
        `).all() as Array<{ hash: string }>).map(r => r.hash);
      }
      
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
      
      if (vectorStore && orphanedHashes.length > 0) {
        for (const hash of orphanedHashes) {
          vectorStore.deleteByHash(hash).catch(err => {
            log('store', 'cleanOrphanedEmbeddings vector cleanup failed hash=' + hash.substring(0, 8));
            console.warn('[store] Failed to cleanup orphaned vector:', err);
          });
        }
        log('store', 'cleanOrphanedEmbeddings queued ' + orphanedHashes.length + ' vector store deletes');
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

    recordTokenUsage(model: string, tokens: number) {
      try {
        recordTokenUsageStmt.run(model, tokens);
      } catch (err) {
        console.warn('[store] Failed to record token usage:', err instanceof Error ? err.message : String(err));
      }
    },

    getTokenUsage() {
      return getTokenUsageStmt.all() as Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>;
    },

    getSqliteVecCount(): number {
      if (!vecAvailable) return 0;
      try {
        const row = db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number };
        return row.count;
      } catch { return 0; }
    },

    logSearchQuery(queryId: string, queryText: string, tier: string, configVariant: string | null, resultDocids: string[], executionMs: number, sessionId: string | null, cacheKey: string | null, workspaceHash: string) {
      try {
        insertTelemetryStmt.run(queryId, queryText, tier, configVariant, JSON.stringify(resultDocids), executionMs, sessionId, cacheKey, workspaceHash);
      } catch (err) {
        console.warn('[store] Failed to log telemetry:', err instanceof Error ? err.message : String(err));
      }
    },

    logSearchExpand(cacheKey: string, expandedIndices: number[]) {
      try {
        updateTelemetryExpandStmt.run(JSON.stringify(expandedIndices), cacheKey);
      } catch (err) {
        console.warn('[store] Failed to log expand:', err instanceof Error ? err.message : String(err));
      }
    },

    getRecentQueries(sessionId: string): Array<{ id: number; query_text: string; timestamp: string }> {
      return getRecentQueriesStmt.all(sessionId) as Array<{ id: number; query_text: string; timestamp: string }>;
    },

    markReformulation(telemetryId: number) {
      try {
        updateTelemetryReformulationStmt.run(telemetryId);
      } catch (err) {
        console.warn('[store] Failed to mark reformulation:', err instanceof Error ? err.message : String(err));
      }
    },

    purgeTelemetry(retentionDays: number): number {
      const result = purgeTelemetryStmt.run(retentionDays);
      return result.changes;
    },

    getTelemetryCount(): number {
      return (getTelemetryCountStmt.get() as { count: number }).count;
    },

    saveBanditStats(stats: Array<{ parameterName: string; variantValue: number; successes: number; failures: number }>, workspaceHash: string) {
      for (const s of stats) {
        try {
          upsertBanditStmt.run(s.parameterName, s.variantValue, s.successes, s.failures, workspaceHash);
        } catch (err) {
          console.warn('[store] Failed to save bandit stats:', err instanceof Error ? err.message : String(err));
        }
      }
    },

    loadBanditStats(workspaceHash: string): Array<{ parameter_name: string; variant_value: number; successes: number; failures: number }> {
      return getBanditStatsStmt.all(workspaceHash) as Array<{ parameter_name: string; variant_value: number; successes: number; failures: number }>;
    },

    saveConfigVersion(configJson: string, expandRate: number | null): number {
      try {
        const result = insertConfigVersionStmt.run(configJson, expandRate);
        return Number(result.lastInsertRowid);
      } catch (err) {
        console.warn('[store] Failed to save config version:', err instanceof Error ? err.message : String(err));
        return 0;
      }
    },

    getLatestConfigVersion(): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null {
      return getLatestConfigVersionStmt.get() as { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;
    },

    getConfigVersion(versionId: number): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null {
      return getConfigVersionStmt.get(versionId) as { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;
    },

    getWorkspaceProfile(workspaceHash: string): { workspace_hash: string; profile_data: string; updated_at: string } | null {
      return getWorkspaceProfileStmt.get(workspaceHash) as { workspace_hash: string; profile_data: string; updated_at: string } | null;
    },

    saveWorkspaceProfile(workspaceHash: string, profileData: string): void {
      upsertWorkspaceProfileStmt.run(workspaceHash, profileData);
    },

    saveGlobalLearning(parameterName: string, value: number, confidence: number): void {
      upsertGlobalLearningStmt.run(parameterName, value, confidence);
    },

    getGlobalLearning(): Array<{ parameter_name: string; value: number; confidence: number }> {
      return getGlobalLearningStmt.all() as Array<{ parameter_name: string; value: number; confidence: number }>;
    },

    getTelemetryStats(workspaceHash: string): { queryCount: number; expandCount: number } {
      const row = getTelemetryStatsStmt.get(workspaceHash) as { queryCount: number; expandCount: number | null } | undefined;
      return {
        queryCount: row?.queryCount ?? 0,
        expandCount: row?.expandCount ?? 0,
      };
    },

    getTelemetryTopKeywords(workspaceHash: string, limit: number): Array<{ keyword: string; count: number }> {
      const rows = getTelemetryQueryTextsStmt.all(workspaceHash) as Array<{ query_text: string }>;
      const stopwords = new Set([
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below', 'between',
        'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
        'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
        'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
        'you', 'your', 'yours', 'yourself', 'yourselves',
        'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
        'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'am', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'all', 'any',
        'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
      ]);
      const keywordCounts = new Map<string, number>();
      for (const row of rows) {
        const tokens = row.query_text.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !stopwords.has(t));
        for (const token of tokens) {
          keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
        }
      }
      const sorted = [...keywordCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([keyword, count]) => ({ keyword, count }));
      return sorted;
    },

    insertChainMembership(chainId: string, queryId: string, position: number, workspaceHash: string): void {
      try {
        insertChainMembershipStmt.run(chainId, queryId, position, workspaceHash);
      } catch (err) {
        console.warn('[store] Failed to insert chain membership:', err instanceof Error ? err.message : String(err));
      }
    },

    getChainsByWorkspace(workspaceHash: string, limit: number): Array<{ chain_id: string; query_id: string; position: number }> {
      return getChainsByWorkspaceStmt.all(workspaceHash, limit) as Array<{ chain_id: string; query_id: string; position: number }>;
    },

    getRecentTelemetryQueries(workspaceHash: string, limit: number): Array<{ id: number; query_id: string; query_text: string; timestamp: string; session_id: string }> {
      return getRecentTelemetryQueriesStmt.all(workspaceHash, limit) as Array<{ id: number; query_id: string; query_text: string; timestamp: string; session_id: string }>;
    },

    upsertQueryCluster(clusterId: number, centroidEmbedding: string, representativeQuery: string, queryCount: number, workspaceHash: string): void {
      try {
        upsertQueryClusterStmt.run(clusterId, centroidEmbedding, representativeQuery, queryCount, workspaceHash);
      } catch (err) {
        console.warn('[store] Failed to upsert query cluster:', err instanceof Error ? err.message : String(err));
      }
    },

    getQueryClusters(workspaceHash: string): Array<{ cluster_id: number; centroid_embedding: string; representative_query: string; query_count: number }> {
      return getQueryClustersStmt.all(workspaceHash) as Array<{ cluster_id: number; centroid_embedding: string; representative_query: string; query_count: number }>;
    },

    clearQueryClusters(workspaceHash: string): void {
      clearQueryClustersStmt.run(workspaceHash);
    },

    upsertClusterTransition(fromId: number, toId: number, frequency: number, probability: number, workspaceHash: string): void {
      try {
        upsertClusterTransitionStmt.run(fromId, toId, frequency, probability, workspaceHash);
      } catch (err) {
        console.warn('[store] Failed to upsert cluster transition:', err instanceof Error ? err.message : String(err));
      }
    },

    getClusterTransitions(workspaceHash: string): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }> {
      return getClusterTransitionsStmt.all(workspaceHash) as Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
    },

    getTransitionsFrom(fromClusterId: number, workspaceHash: string, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }> {
      return getTransitionsFromStmt.all(fromClusterId, workspaceHash, limit) as Array<{ to_cluster_id: number; frequency: number; probability: number }>;
    },

    clearClusterTransitions(workspaceHash: string): void {
      clearClusterTransitionsStmt.run(workspaceHash);
    },

    upsertGlobalTransition(fromId: number, toId: number, frequency: number, probability: number): void {
      try {
        upsertGlobalTransitionStmt.run(fromId, toId, frequency, probability);
      } catch (err) {
        console.warn('[store] Failed to upsert global transition:', err instanceof Error ? err.message : String(err));
      }
    },

    getGlobalTransitions(): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }> {
      return getGlobalTransitionsStmt.all() as Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
    },

    getGlobalTransitionsFrom(fromClusterId: number, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }> {
      return getGlobalTransitionsFromStmt.all(fromClusterId, limit) as Array<{ to_cluster_id: number; frequency: number; probability: number }>;
    },

    clearGlobalTransitions(): void {
      clearGlobalTransitionsStmt.run();
    },

    recordSuggestionFeedback(suggestedQuery: string, actualQuery: string, matchType: string, workspaceHash: string): void {
      try {
        insertSuggestionFeedbackStmt.run(suggestedQuery, actualQuery, matchType, workspaceHash);
      } catch (err) {
        console.warn('[store] Failed to record suggestion feedback:', err instanceof Error ? err.message : String(err));
      }
    },

    getSuggestionAccuracy(workspaceHash: string): { total: number; exact: number; partial: number; none: number } {
      const row = getSuggestionAccuracyStmt.get(workspaceHash) as { total: number; exact: number; partial: number; none: number } | undefined;
      return {
        total: row?.total ?? 0,
        exact: row?.exact ?? 0,
        partial: row?.partial ?? 0,
        none: row?.none ?? 0,
      };
    },
  };
}

export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function resolveWorkspaceDbPath(dataDir: string, workspacePath: string): string {
  const dirName = path.basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
  return path.join(dataDir, `${dirName}-${hash}.sqlite`);
}

const projectLabelCache = new Map<string, string>()
let projectLabelDataDir: string | null = null

export function resolveProjectLabel(projectHash: string, dataDir?: string): string {
  if (projectLabelCache.has(projectHash)) return projectLabelCache.get(projectHash)!
  const dir = dataDir ?? projectLabelDataDir
  if (!dir) return projectHash
  try {
    const files = fs.readdirSync(dir)
    for (const file of files) {
      if (!file.endsWith('.sqlite')) continue
      const match = file.match(/^(.+)-([a-f0-9]{12})\.sqlite$/)
      if (match && match[2] === projectHash) {
        const label = `${match[1]}(${projectHash})`
        projectLabelCache.set(projectHash, label)
        return label
      }
    }
  } catch { /* skip */ }
  projectLabelCache.set(projectHash, projectHash)
  return projectHash
}

export function setProjectLabelDataDir(dataDir: string): void {
  projectLabelDataDir = dataDir
}

export function openWorkspaceStore(dataDir: string, workspacePath: string): Store | null {
  const dbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  return createStore(dbPath);
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
  
  if (existingDoc && existingDoc.hash !== hash) {
    store.cleanupVectorsForHash(existingDoc.hash);
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
