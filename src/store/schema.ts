import Database from 'better-sqlite3';
import { log } from '../logger.js';

export function openDatabase(dbPath: string, opts?: { readonly?: boolean }): Database.Database {
  const db = new Database(dbPath, opts);
  applyPragmas(db);
  return db;
}

export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 15000');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864');
}

export function applySchema(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS doc_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      flow_type TEXT NOT NULL DEFAULT 'doc_flow',
      description TEXT,
      services TEXT,
      source_file TEXT,
      last_updated TEXT,
      project_hash TEXT NOT NULL DEFAULT 'global'
    );
    CREATE INDEX IF NOT EXISTS idx_doc_flows_project ON doc_flows(project_hash);

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
}

export function runMigrations(db: Database.Database): void {
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
  const TARGET_VERSION = 10;

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

  if (currentVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_consolidation_queue_status ON consolidation_queue(status);

      CREATE TABLE IF NOT EXISTS consolidation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        target_doc_id INTEGER,
        model TEXT,
        tokens_used INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.pragma(`user_version = 4`);
    log('store', 'Schema migrated to version 4 (consolidation queue tables)');
  }

  if (currentVersion < 5) {
    const hasAccessCount = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'access_count');
    if (!hasAccessCount) {
      db.exec("ALTER TABLE documents ADD COLUMN access_count INTEGER DEFAULT 0");
    }
    const hasLastAccessedAt = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'last_accessed_at');
    if (!hasLastAccessedAt) {
      db.exec("ALTER TABLE documents ADD COLUMN last_accessed_at TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_access ON documents(access_count, last_accessed_at)");
    db.pragma(`user_version = 5`);
    log('store', 'Schema migrated to version 5 (access tracking columns)');
  }

  if (currentVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        project_hash TEXT NOT NULL,
        first_learned_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
        contradicted_at TEXT,
        contradicted_by_memory_id INTEGER,
        UNIQUE(name COLLATE NOCASE, type, project_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(type, project_hash);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES memory_entities(id),
        target_id INTEGER NOT NULL REFERENCES memory_entities(id),
        edge_type TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, target_id, edge_type, project_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);
    `);
    db.pragma(`user_version = 6`);
    log('store', 'Schema migrated to version 6 (memory graph tables)');
  }

  if (currentVersion < 7) {
    db.exec(`ALTER TABLE memory_entities ADD COLUMN pruned_at TEXT`);
    db.pragma(`user_version = 7`);
    log('store', 'Schema migrated to version 7 (entity pruning support)');
  }

  if (currentVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        to_doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        relationship_type TEXT NOT NULL,
        description TEXT,
        strength REAL NOT NULL DEFAULT 1.0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        project_hash TEXT NOT NULL,
        UNIQUE(from_doc_id, to_doc_id, relationship_type)
      );
      CREATE INDEX IF NOT EXISTS idx_mc_from ON memory_connections(from_doc_id);
      CREATE INDEX IF NOT EXISTS idx_mc_to ON memory_connections(to_doc_id);
      CREATE INDEX IF NOT EXISTS idx_mc_type ON memory_connections(relationship_type);
      CREATE INDEX IF NOT EXISTS idx_mc_project ON memory_connections(project_hash);
    `);
    db.pragma(`user_version = 8`);
    log('store', 'Schema migrated to version 8 (memory connections)');
  }

  if (currentVersion < 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS path_prefixes (
        project_hash TEXT PRIMARY KEY,
        prefix TEXT NOT NULL
      );
    `);
    db.pragma(`user_version = 9`);
    log('store', 'Schema migrated to version 9 (path prefix compression)');
  }

  if (currentVersion < 10) {
    const hasDomainType = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'domain_type');
    if (!hasDomainType) {
      db.exec("ALTER TABLE documents ADD COLUMN domain_type TEXT DEFAULT 'general'");
    }
    const hasLastReinforcedAt = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'last_reinforced_at');
    if (!hasLastReinforcedAt) {
      db.exec("ALTER TABLE documents ADD COLUMN last_reinforced_at TEXT");
    }
    db.pragma(`user_version = 10`);
    log('store', 'Schema migrated to version 10 (domain_type, last_reinforced_at columns)');
  }

  void TARGET_VERSION;
}

export function initStatements(db: Database.Database): Record<string, Database.Statement<unknown[], unknown>> {
  return {
    insertContent: db.prepare(`INSERT OR IGNORE INTO content (hash, body) VALUES (?, ?)`),
    insertDocument: db.prepare(`
      INSERT INTO documents (collection, path, title, hash, agent, created_at, modified_at, active, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, path) DO UPDATE SET
        title = excluded.title,
        hash = excluded.hash,
        agent = excluded.agent,
        modified_at = excluded.modified_at,
        active = excluded.active,
        project_hash = excluded.project_hash
    `),
    findDocumentByPath: db.prepare(`
      SELECT id, collection, path, title, hash, agent, created_at as createdAt, modified_at as modifiedAt, active, project_hash as projectHash
      FROM documents WHERE path = ? AND collection = ? AND active = 1
    `),
    findDocumentByDocid: db.prepare(`
      SELECT id, collection, path, title, hash, agent, created_at as createdAt, modified_at as modifiedAt, active, project_hash as projectHash
      FROM documents WHERE substr(hash, 1, 6) = ? AND active = 1
    `),
    findDocumentByPathAnyCollection: db.prepare(`
      SELECT id, collection, path, title, hash, agent, created_at as createdAt, modified_at as modifiedAt, active, project_hash as projectHash
      FROM documents WHERE path = ? AND active = 1 LIMIT 1
    `),
    findDocMetadataByHash: db.prepare(`
      SELECT project_hash, created_at FROM documents WHERE hash = ? LIMIT 1
    `),
    getContent: db.prepare(`SELECT body FROM content WHERE hash = ?`),
    deactivateDocument: db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ?`),
    insertConnection: db.prepare(`
      INSERT INTO memory_connections (from_doc_id, to_doc_id, relationship_type, description, strength, created_by, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_doc_id, to_doc_id, relationship_type) DO UPDATE SET
        description = excluded.description, strength = excluded.strength, created_by = excluded.created_by
    `),
    getConnectionsFrom: db.prepare(`SELECT * FROM memory_connections WHERE from_doc_id = ? ORDER BY strength DESC`),
    getConnectionsTo: db.prepare(`SELECT * FROM memory_connections WHERE to_doc_id = ? ORDER BY strength DESC`),
    getConnectionsBoth: db.prepare(`SELECT * FROM memory_connections WHERE from_doc_id = ? OR to_doc_id = ? ORDER BY strength DESC`),
    getConnectionsByType: db.prepare(`SELECT * FROM memory_connections WHERE (from_doc_id = ? OR to_doc_id = ?) AND relationship_type = ? ORDER BY strength DESC`),
    deleteConnection: db.prepare(`DELETE FROM memory_connections WHERE id = ?`),
    getConnectionCount: db.prepare(`SELECT COUNT(*) as cnt FROM memory_connections WHERE from_doc_id = ? OR to_doc_id = ?`),
    insertEmbedding: db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model) VALUES (?, ?, ?, ?)`),
    getCachedResult: db.prepare(`SELECT result FROM llm_cache WHERE hash = ? AND project_hash = ?`),
    setCachedResult: db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, project_hash, type, result) VALUES (?, ?, ?, ?)`),
    getDocumentCount: db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`),
    getEmbeddedCount: db.prepare(`SELECT COUNT(*) as count FROM content_vectors`),
    getCollectionStats: db.prepare(`
      SELECT collection as name, COUNT(*) as documentCount, MIN(path) as path
      FROM documents WHERE active = 1
      GROUP BY collection
    `),
    getWorkspaceStats: db.prepare(`
      SELECT project_hash as projectHash, COUNT(*) as count
      FROM documents WHERE active = 1
      GROUP BY project_hash
    `),
    getExtractedFactCount: db.prepare(`SELECT COUNT(*) as count FROM documents WHERE path LIKE 'auto:extracted-fact:%' AND active = 1`),
    getPendingEmbeddingCount: db.prepare(`
      SELECT COUNT(*) as count
      FROM content c
      JOIN documents d ON d.hash = c.hash AND d.active = 1
      LEFT JOIN content_vectors cv ON cv.hash = c.hash
      WHERE cv.hash IS NULL AND d.collection != 'sessions'
    `),
    getHashesNeedingEmbedding: db.prepare(`
      SELECT c.hash, c.body, d.path
      FROM content c
      JOIN documents d ON d.hash = c.hash AND d.active = 1
      LEFT JOIN content_vectors cv ON cv.hash = c.hash
      WHERE cv.hash IS NULL AND d.collection != 'sessions'
      LIMIT ?
    `),
    getHashesNeedingEmbeddingByWorkspace: db.prepare(`
      SELECT c.hash, c.body, d.path
      FROM content c
      JOIN documents d ON d.hash = c.hash AND d.active = 1
      LEFT JOIN content_vectors cv ON cv.hash = c.hash
      WHERE cv.hash IS NULL AND d.collection != 'sessions' AND d.project_hash IN (?, 'global')
      LIMIT ?
    `),
    getNextHashNeedingEmbedding: db.prepare(`
      SELECT c.hash, c.body, d.path
      FROM content c
      JOIN documents d ON d.hash = c.hash AND d.active = 1
      LEFT JOIN content_vectors cv ON cv.hash = c.hash
      WHERE cv.hash IS NULL AND d.collection != 'sessions'
      LIMIT 1
    `),
    getNextHashNeedingEmbeddingByWorkspace: db.prepare(`
      SELECT c.hash, c.body, d.path
      FROM content c
      JOIN documents d ON d.hash = c.hash AND d.active = 1
      LEFT JOIN content_vectors cv ON cv.hash = c.hash
      WHERE cv.hash IS NULL AND d.collection != 'sessions' AND d.project_hash IN (?, 'global')
      LIMIT 1
    `),
    insertFileEdge: db.prepare(`INSERT OR REPLACE INTO file_edges (source_path, target_path, edge_type, project_hash) VALUES (?, ?, ?, ?)`),
    deleteFileEdges: db.prepare(`DELETE FROM file_edges WHERE source_path = ? AND project_hash = ?`),
    getFileEdges: db.prepare(`SELECT source_path, target_path FROM file_edges WHERE project_hash = ?`),
    updateCentrality: db.prepare(`UPDATE documents SET centrality = ? WHERE collection = 'codebase' AND project_hash = ? AND path = ?`),
    updateClusterId: db.prepare(`UPDATE documents SET cluster_id = ? WHERE collection = 'codebase' AND project_hash = ? AND path = ?`),
    getEdgeSetHash: db.prepare(`SELECT result FROM llm_cache WHERE hash = 'edge_hash' AND project_hash = ? AND type = 'edge_hash'`),
    setEdgeSetHash: db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, project_hash, type, result) VALUES ('edge_hash', ?, 'edge_hash', ?)`),
    supersedeDocument: db.prepare(`UPDATE documents SET superseded_by = ? WHERE id = ?`),
    recordTokenUsage: db.prepare(`
      INSERT INTO token_usage (model, total_tokens, request_count, last_updated)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(model) DO UPDATE SET
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + 1,
        last_updated = datetime('now')
    `),
    getTokenUsage: db.prepare(`SELECT model, total_tokens as totalTokens, request_count as requestCount, last_updated as lastUpdated FROM token_usage ORDER BY total_tokens DESC`),
    insertTelemetry: db.prepare(`
      INSERT INTO search_telemetry (query_id, query_text, tier, config_variant, result_docids, execution_ms, session_id, cache_key, workspace_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateTelemetryExpand: db.prepare(`
      UPDATE search_telemetry SET expanded_indices = ?, feedback_signal = 'positive'
      WHERE cache_key = ? AND feedback_signal = 'neutral'
    `),
    updateTelemetryReformulation: db.prepare(`UPDATE search_telemetry SET feedback_signal = 'negative' WHERE id = ?`),
    getRecentQueries: db.prepare(`
      SELECT id, query_text, timestamp FROM search_telemetry
      WHERE session_id = ? AND timestamp > datetime('now', '-60 seconds')
      ORDER BY timestamp DESC LIMIT 5
    `),
    getConfigVariantByCacheKey: db.prepare(`SELECT config_variant FROM search_telemetry WHERE cache_key = ? LIMIT 1`),
    getConfigVariantById: db.prepare(`SELECT config_variant FROM search_telemetry WHERE id = ? LIMIT 1`),
    purgeTelemetry: db.prepare(`DELETE FROM search_telemetry WHERE timestamp < datetime('now', '-' || ? || ' days')`),
    getTelemetryCount: db.prepare(`SELECT COUNT(*) as count FROM search_telemetry`),
    upsertBandit: db.prepare(`
      INSERT INTO bandit_stats (parameter_name, variant_value, successes, failures, workspace_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(parameter_name, variant_value, workspace_hash) DO UPDATE SET
        successes = excluded.successes,
        failures = excluded.failures,
        updated_at = datetime('now')
    `),
    getBanditStats: db.prepare(`SELECT parameter_name, variant_value, successes, failures FROM bandit_stats WHERE workspace_hash = ?`),
    insertConfigVersion: db.prepare(`INSERT INTO config_versions (config_json, expand_rate) VALUES (?, ?)`),
    getLatestConfigVersion: db.prepare(`SELECT version_id, config_json, expand_rate, created_at FROM config_versions ORDER BY version_id DESC LIMIT 1`),
    getConfigVersion: db.prepare(`SELECT version_id, config_json, expand_rate, created_at FROM config_versions WHERE version_id = ?`),
    getWorkspaceProfile: db.prepare(`SELECT workspace_hash, profile_data, updated_at FROM workspace_profiles WHERE workspace_hash = ?`),
    upsertWorkspaceProfile: db.prepare(`
      INSERT INTO workspace_profiles (workspace_hash, profile_data, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(workspace_hash) DO UPDATE SET
        profile_data = excluded.profile_data,
        updated_at = datetime('now')
    `),
    upsertGlobalLearning: db.prepare(`
      INSERT INTO global_learning (parameter_name, value, confidence, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(parameter_name) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        updated_at = datetime('now')
    `),
    getGlobalLearning: db.prepare(`SELECT parameter_name, value, confidence FROM global_learning`),
    getActiveDocumentsWithAccess: db.prepare(`SELECT id, path, hash, access_count, last_accessed_at FROM documents WHERE active = 1`),
    getTopAccessedDocuments: db.prepare(`
      SELECT id, path, collection, title, hash, access_count, last_accessed_at
      FROM documents
      WHERE active = 1 AND superseded_by IS NULL
        AND project_hash IN (?, 'global')
      ORDER BY access_count DESC
      LIMIT ?
    `),
    getTopAccessedDocumentsAll: db.prepare(`
      SELECT id, path, collection, title, hash, access_count, last_accessed_at
      FROM documents
      WHERE active = 1 AND superseded_by IS NULL
      ORDER BY access_count DESC
      LIMIT ?
    `),
    getTagCountForDocument: db.prepare(`SELECT COUNT(*) as cnt FROM document_tags WHERE document_id = ?`),
    getTelemetryStats: db.prepare(`
      SELECT COUNT(*) as queryCount, SUM(CASE WHEN feedback_signal = 'positive' THEN 1 ELSE 0 END) as expandCount
      FROM search_telemetry WHERE workspace_hash = ?
    `),
    getTelemetryQueryTexts: db.prepare(`SELECT query_text FROM search_telemetry WHERE workspace_hash = ? ORDER BY timestamp DESC LIMIT 500`),
    insertChainMembership: db.prepare(`INSERT OR REPLACE INTO query_chain_membership (chain_id, query_id, position, workspace_hash) VALUES (?, ?, ?, ?)`),
    getChainsByWorkspace: db.prepare(`SELECT chain_id, query_id, position FROM query_chain_membership WHERE workspace_hash = ? ORDER BY chain_id, position LIMIT ?`),
    getRecentTelemetryQueries: db.prepare(`SELECT id, query_id, query_text, timestamp, session_id FROM search_telemetry WHERE workspace_hash = ? ORDER BY timestamp DESC LIMIT ?`),
    upsertQueryCluster: db.prepare(`
      INSERT INTO query_clusters (cluster_id, centroid_embedding, representative_query, query_count, workspace_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(cluster_id, workspace_hash) DO UPDATE SET
        centroid_embedding = excluded.centroid_embedding,
        representative_query = excluded.representative_query,
        query_count = excluded.query_count,
        updated_at = datetime('now')
    `),
    getQueryClusters: db.prepare(`SELECT cluster_id, centroid_embedding, representative_query, query_count FROM query_clusters WHERE workspace_hash = ? ORDER BY cluster_id`),
    clearQueryClusters: db.prepare(`DELETE FROM query_clusters WHERE workspace_hash = ?`),
    upsertClusterTransition: db.prepare(`
      INSERT INTO cluster_transitions (from_cluster_id, to_cluster_id, frequency, probability, workspace_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(from_cluster_id, to_cluster_id, workspace_hash) DO UPDATE SET
        frequency = excluded.frequency,
        probability = excluded.probability,
        updated_at = datetime('now')
    `),
    getClusterTransitions: db.prepare(`SELECT from_cluster_id, to_cluster_id, frequency, probability FROM cluster_transitions WHERE workspace_hash = ? ORDER BY frequency DESC`),
    getTransitionsFrom: db.prepare(`SELECT to_cluster_id, frequency, probability FROM cluster_transitions WHERE from_cluster_id = ? AND workspace_hash = ? ORDER BY probability DESC LIMIT ?`),
    clearClusterTransitions: db.prepare(`DELETE FROM cluster_transitions WHERE workspace_hash = ?`),
    upsertGlobalTransition: db.prepare(`
      INSERT INTO global_transitions (from_cluster_id, to_cluster_id, frequency, probability, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(from_cluster_id, to_cluster_id) DO UPDATE SET
        frequency = excluded.frequency,
        probability = excluded.probability,
        updated_at = datetime('now')
    `),
    getGlobalTransitions: db.prepare(`SELECT from_cluster_id, to_cluster_id, frequency, probability FROM global_transitions ORDER BY frequency DESC`),
    getGlobalTransitionsFrom: db.prepare(`SELECT to_cluster_id, frequency, probability FROM global_transitions WHERE from_cluster_id = ? ORDER BY probability DESC LIMIT ?`),
    clearGlobalTransitions: db.prepare(`DELETE FROM global_transitions`),
    insertSuggestionFeedback: db.prepare(`INSERT INTO suggestion_feedback (suggested_query, actual_next_query, match_type, workspace_hash) VALUES (?, ?, ?, ?)`),
    getSuggestionAccuracy: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN match_type = 'exact' THEN 1 ELSE 0 END) as exact,
        SUM(CASE WHEN match_type = 'partial' THEN 1 ELSE 0 END) as partial,
        SUM(CASE WHEN match_type = 'none' THEN 1 ELSE 0 END) as none
      FROM suggestion_feedback WHERE workspace_hash = ?
    `),
    enqueueConsolidation: db.prepare(`INSERT INTO consolidation_queue (document_id, status, created_at) VALUES (?, 'pending', datetime('now'))`),
    getNextPendingJob: db.prepare(`SELECT id, document_id FROM consolidation_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`),
    updateJobStatus: db.prepare(`UPDATE consolidation_queue SET status = ?, processed_at = datetime('now'), result = ?, error = ? WHERE id = ?`),
    getQueueStats: db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM consolidation_queue
    `),
    addConsolidationLog: db.prepare(`INSERT INTO consolidation_log (document_id, action, reason, target_doc_id, model, tokens_used, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`),
    getRecentConsolidationLogs: db.prepare(`SELECT id, document_id, action, reason, target_doc_id, model, tokens_used, created_at FROM consolidation_log ORDER BY created_at DESC LIMIT ?`),
    insertOrUpdateEntity: db.prepare(`
      INSERT INTO memory_entities (name, type, description, project_hash, first_learned_at, last_confirmed_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(name COLLATE NOCASE, type, project_hash) DO UPDATE SET
        description = COALESCE(excluded.description, memory_entities.description),
        last_confirmed_at = datetime('now')
    `),
    getEntityById: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE id = ?
    `),
    getEntityByName: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE name COLLATE NOCASE = ?
    `),
    getEntityByNameAndType: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE name COLLATE NOCASE = ? AND type = ?
    `),
    getEntityByNameTypeProject: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE name COLLATE NOCASE = ? AND type = ? AND project_hash = ?
    `),
    insertMemoryEdge: db.prepare(`INSERT OR IGNORE INTO memory_edges (source_id, target_id, edge_type, project_hash) VALUES (?, ?, ?, ?)`),
    getEntityEdgesIncoming: db.prepare(`
      SELECT e.id, e.source_id as sourceId, e.target_id as targetId, e.edge_type as edgeType,
             e.project_hash as projectHash, e.created_at as createdAt,
             s.name as sourceName, t.name as targetName
      FROM memory_edges e
      JOIN memory_entities s ON s.id = e.source_id
      JOIN memory_entities t ON t.id = e.target_id
      WHERE e.target_id = ?
    `),
    getEntityEdgesOutgoing: db.prepare(`
      SELECT e.id, e.source_id as sourceId, e.target_id as targetId, e.edge_type as edgeType,
             e.project_hash as projectHash, e.created_at as createdAt,
             s.name as sourceName, t.name as targetName
      FROM memory_edges e
      JOIN memory_entities s ON s.id = e.source_id
      JOIN memory_entities t ON t.id = e.target_id
      WHERE e.source_id = ?
    `),
    getEntityEdgesBoth: db.prepare(`
      SELECT e.id, e.source_id as sourceId, e.target_id as targetId, e.edge_type as edgeType,
             e.project_hash as projectHash, e.created_at as createdAt,
             s.name as sourceName, t.name as targetName
      FROM memory_edges e
      JOIN memory_entities s ON s.id = e.source_id
      JOIN memory_entities t ON t.id = e.target_id
      WHERE e.source_id = ? OR e.target_id = ?
    `),
    markEntityContradicted: db.prepare(`UPDATE memory_entities SET contradicted_at = datetime('now'), contradicted_by_memory_id = ? WHERE id = ?`),
    confirmEntity: db.prepare(`UPDATE memory_entities SET last_confirmed_at = datetime('now') WHERE id = ?`),
    getMemoryEntities: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE project_hash = ?
      ORDER BY last_confirmed_at DESC
      LIMIT ?
    `),
    getMemoryEntityCount: db.prepare(`SELECT COUNT(*) as count FROM memory_entities WHERE project_hash = ?`),
    getContradictedEntitiesForPruning: db.prepare(`
      SELECT id FROM memory_entities
      WHERE contradicted_at IS NOT NULL
        AND contradicted_at < datetime('now', '-' || ? || ' days')
        AND pruned_at IS NULL
      LIMIT ?
    `),
    getContradictedEntitiesForPruningByProject: db.prepare(`
      SELECT id FROM memory_entities
      WHERE contradicted_at IS NOT NULL
        AND contradicted_at < datetime('now', '-' || ? || ' days')
        AND pruned_at IS NULL
        AND project_hash = ?
      LIMIT ?
    `),
    getOrphanEntitiesForPruning: db.prepare(`
      SELECT e.id FROM memory_entities e
      LEFT JOIN memory_edges me_src ON me_src.source_id = e.id
      LEFT JOIN memory_edges me_tgt ON me_tgt.target_id = e.id
      WHERE me_src.id IS NULL AND me_tgt.id IS NULL
        AND e.last_confirmed_at < datetime('now', '-' || ? || ' days')
        AND e.pruned_at IS NULL
      LIMIT ?
    `),
    getOrphanEntitiesForPruningByProject: db.prepare(`
      SELECT e.id FROM memory_entities e
      LEFT JOIN memory_edges me_src ON me_src.source_id = e.id
      LEFT JOIN memory_edges me_tgt ON me_tgt.target_id = e.id
      WHERE me_src.id IS NULL AND me_tgt.id IS NULL
        AND e.last_confirmed_at < datetime('now', '-' || ? || ' days')
        AND e.pruned_at IS NULL
        AND e.project_hash = ?
      LIMIT ?
    `),
    getPrunedEntitiesForHardDelete: db.prepare(`
      SELECT id FROM memory_entities
      WHERE pruned_at IS NOT NULL
        AND pruned_at < datetime('now', '-' || ? || ' days')
      LIMIT ?
    `),
    getPrunedEntitiesForHardDeleteByProject: db.prepare(`
      SELECT id FROM memory_entities
      WHERE pruned_at IS NOT NULL
        AND pruned_at < datetime('now', '-' || ? || ' days')
        AND project_hash = ?
      LIMIT ?
    `),
    getActiveEntitiesByTypeAndProject: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities
      WHERE pruned_at IS NULL AND contradicted_at IS NULL
      ORDER BY type, project_hash, name COLLATE NOCASE
    `),
    getActiveEntitiesByTypeAndProjectFiltered: db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities
      WHERE pruned_at IS NULL AND contradicted_at IS NULL AND project_hash = ?
      ORDER BY type, name COLLATE NOCASE
    `),
    getEntityEdgeCount: db.prepare(`SELECT COUNT(*) as count FROM memory_edges WHERE source_id = ? OR target_id = ?`),
    redirectEntityEdgesSource: db.prepare(`UPDATE memory_edges SET source_id = ? WHERE source_id = ?`),
    redirectEntityEdgesTarget: db.prepare(`UPDATE memory_edges SET target_id = ? WHERE target_id = ?`),
    deleteEntity: db.prepare(`DELETE FROM memory_entities WHERE id = ?`),
    deleteSelfLoopEdges: db.prepare(`DELETE FROM memory_edges WHERE source_id = target_id`),
    deleteDuplicateEdges: db.prepare(`
      DELETE FROM memory_edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM memory_edges
        GROUP BY source_id, target_id, edge_type, project_hash
      )
    `),
    getSymbolsForProject: db.prepare(`
      SELECT id, name, kind, file_path as filePath, start_line as startLine, end_line as endLine,
             exported, cluster_id as clusterId
      FROM code_symbols WHERE project_hash = ?
    `),
    getSymbolEdgesForProject: db.prepare(`
      SELECT id, source_id as sourceId, target_id as targetId, edge_type as edgeType, confidence
      FROM symbol_edges WHERE project_hash = ?
    `),
    getSymbolClusters: db.prepare(`
      SELECT cluster_id as clusterId, COUNT(*) as memberCount
      FROM code_symbols WHERE project_hash = ? AND cluster_id IS NOT NULL
      GROUP BY cluster_id
    `),
    getFlowsWithSteps: db.prepare(`
      SELECT ef.id, ef.label, ef.flow_type as flowType, ef.step_count as stepCount,
        entry.name as entryName, entry.file_path as entryFile,
        term.name as terminalName, term.file_path as terminalFile
      FROM execution_flows ef
      JOIN code_symbols entry ON ef.entry_symbol_id = entry.id
      JOIN code_symbols term ON ef.terminal_symbol_id = term.id
      WHERE ef.project_hash = ?
    `),
    getFlowSteps: db.prepare(`
      SELECT fs.step_index as stepIndex, cs.id as symbolId, cs.name, cs.kind, cs.file_path as filePath, cs.start_line as startLine
      FROM flow_steps fs
      JOIN code_symbols cs ON fs.symbol_id = cs.id
      WHERE fs.flow_id = ?
      ORDER BY fs.step_index
    `),
    getDocFlows: db.prepare(`
      SELECT id, label, flow_type as flowType, description, services, source_file as sourceFile, last_updated as lastUpdated
      FROM doc_flows
      WHERE project_hash = ?
      ORDER BY label ASC
    `),
    upsertDocFlow: db.prepare(`
      INSERT INTO doc_flows (label, flow_type, description, services, source_file, last_updated, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `),
    deleteDocFlowsByProject: db.prepare(`DELETE FROM doc_flows WHERE project_hash = ?`),
    getAllConnections: db.prepare(`
      SELECT mc.id, mc.from_doc_id as fromDocId, mc.to_doc_id as toDocId, mc.relationship_type as relationshipType,
             mc.strength, mc.description, mc.created_at as createdAt, mc.created_by as createdBy, mc.project_hash as projectHash,
             d1.title as fromTitle, d1.path as fromPath,
             d2.title as toTitle, d2.path as toPath
      FROM memory_connections mc
      JOIN documents d1 ON mc.from_doc_id = d1.id
      JOIN documents d2 ON mc.to_doc_id = d2.id
      WHERE mc.project_hash = ?
    `),
    getInfrastructureSymbols: db.prepare(`
      SELECT type, pattern, operation, repo, file_path as filePath, line_number as lineNumber
      FROM symbols WHERE project_hash = ?
      ORDER BY type, pattern, operation
    `),
    insertPrefix: db.prepare(`INSERT OR IGNORE INTO path_prefixes (project_hash, prefix) VALUES (?, ?)`),
    getPrefix: db.prepare(`SELECT prefix FROM path_prefixes WHERE project_hash = ?`),
    getFileDependenciesStmt: db.prepare(`
      SELECT target_path FROM file_edges
      WHERE source_path = ? AND project_hash = ?
    `),
    getFileDependentsStmt: db.prepare(`
      SELECT source_path FROM file_edges
      WHERE target_path = ? AND project_hash = ?
    `),
    getDocumentCentralityStmt: db.prepare(`
      SELECT centrality, cluster_id FROM documents
      WHERE path = ? AND active = 1
    `),
    getClusterMembersStmt: db.prepare(`
      SELECT path FROM documents
      WHERE cluster_id = ? AND project_hash = ? AND active = 1
      ORDER BY centrality DESC
    `),
    graphEdgeCount: db.prepare(`SELECT COUNT(*) as count FROM file_edges WHERE project_hash = ?`),
    graphNodeCount: db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT source_path as node FROM file_edges WHERE project_hash = ?
        UNION
        SELECT target_path as node FROM file_edges WHERE project_hash = ?
      )
    `),
    graphClusterCount: db.prepare(`
      SELECT COUNT(DISTINCT cluster_id) as count FROM documents
      WHERE project_hash = ? AND cluster_id IS NOT NULL AND active = 1
    `),
    graphTopCentrality: db.prepare(`
      SELECT path, centrality FROM documents
      WHERE project_hash = ? AND active = 1 AND centrality > 0
      ORDER BY centrality DESC
      LIMIT 10
    `),
  };
}

export type Stmts = ReturnType<typeof initStatements>;
