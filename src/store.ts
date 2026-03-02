import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Store, Document, SearchResult, IndexHealth } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { chunkMarkdown } from './chunker.js';

export function sanitizeFTS5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function createStore(dbPath: string): Store {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  let vecAvailable = false;
  
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
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
    SELECT result FROM llm_cache WHERE hash = ?
  `);
  
  const setCachedResultStmt = db.prepare(`
    INSERT OR REPLACE INTO llm_cache (hash, result) VALUES (?, ?)
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
            console.error(`[store] vectors_vec empty but content_vectors has ${cvCount} stale rows, clearing for re-embedding`);
            db.exec(`DELETE FROM content_vectors`);
          }
          return;
        } catch {
          needsRebuild = true;
        }
        if (needsRebuild) {
          db.exec(`DROP TABLE IF EXISTS vectors_vec`);
          db.exec(`DELETE FROM content_vectors`);
          db.exec(`
            CREATE VIRTUAL TABLE vectors_vec USING vec0(
              hash_seq TEXT PRIMARY KEY,
              embedding float[${dimensions}] distance_metric=cosine
            );
          `);
          console.error(`[store] Recreated vectors_vec with ${dimensions} dimensions, cleared content_vectors for re-embedding`);
        }
      } catch (err) {
        console.warn('Failed to recreate vector table:', err);
      }
    },
    
    searchFTS(query: string, limit = 10, collection?: string, projectHash?: string): SearchResult[] {
      const sanitized = sanitizeFTS5Query(query);
      if (!sanitized) return [];
      
      let rows: unknown[];
      if (projectHash && projectHash !== 'all') {
        if (collection) {
          rows = searchFTSWithWorkspaceAndCollectionStmt.all(sanitized, collection, projectHash, limit);
        } else {
          rows = searchFTSWithWorkspaceStmt.all(sanitized, projectHash, limit);
        }
      } else {
        rows = collection
          ? searchFTSWithCollectionStmt.all(sanitized, collection, limit)
          : searchFTSStmt.all(sanitized, limit);
      }
      
      return (rows as Array<Record<string, unknown>>).map(row => ({
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
      }));
    },
    
    searchVec(query: string, embedding: number[], limit = 10, collection?: string, projectHash?: string): SearchResult[] {
      if (!vecAvailable) {
        return [];
      }
      
      try {
        let sql = `
          SELECT v.hash_seq, v.distance, d.id, d.path, d.collection, d.title, d.hash, d.agent
          FROM vectors_vec v
          JOIN documents d ON substr(v.hash_seq, 1, instr(v.hash_seq, ':') - 1) = d.hash
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
        sql += ` ORDER BY v.distance`;
        
        const stmt = db.prepare(sql);
        const rows = stmt.all(...params) as Array<Record<string, unknown>>;
        
        return rows.map(row => ({
          id: String(row.id),
          path: row.path as string,
          collection: row.collection as string,
          title: row.title as string,
          snippet: '',
          score: 1 - (row.distance as number),
          startLine: 0,
          endLine: 0,
          docid: (row.hash as string).substring(0, 6),
          agent: row.agent as string | undefined,
        }));
      } catch (err) {
        console.warn('Vector search failed:', err);
        return [];
      }
    },
    
    getCachedResult(hash: string): string | null {
      const row = getCachedResultStmt.get(hash) as { result: string } | undefined;
      return row?.result ?? null;
    },
    
    setCachedResult(hash: string, result: string) {
      setCachedResultStmt.run(hash, result);
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
