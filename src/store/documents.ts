import Database from 'better-sqlite3';
import * as path from 'path';
import type { Document, SearchResult, StoreSearchOptions, RemoveWorkspaceResult } from '../types.js';
import type { VectorStore } from '../vector-store.js';
import { log } from '../logger.js';
import type { Stmts } from './schema.js';

export function sanitizeFTS5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const quotedTokens = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  if (quotedTokens.length === 1) return quotedTokens[0];
  return quotedTokens.join(' OR ');
}

export function makeDocumentMethods(
  db: Database.Database,
  stmts: Stmts,
  state: { workspaceRoot: string | null; vectorStore: VectorStore | null; vecAvailable: boolean }
) {
  function toRelativePath(absolutePath: string, workspaceRoot: string): string {
    if (!absolutePath.startsWith('/')) return absolutePath;
    const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
    if (absolutePath.startsWith(prefix)) {
      return absolutePath.slice(prefix.length);
    }
    if (absolutePath === workspaceRoot || absolutePath === workspaceRoot + '/') {
      return '';
    }
    return absolutePath;
  }

  function toRel(p: string): string {
    return state.workspaceRoot ? toRelativePath(p, state.workspaceRoot) : p;
  }

  return {
    registerWorkspacePrefix(projectHash: string, workspaceRoot: string) {
      state.workspaceRoot = workspaceRoot;
      stmts.insertPrefix.run(projectHash, workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/');
    },

    getWorkspaceRoot(): string | null {
      return state.workspaceRoot;
    },

    toRelative(absolutePath: string): string {
      if (!state.workspaceRoot) return absolutePath;
      return toRelativePath(absolutePath, state.workspaceRoot);
    },

    resolvePath(relativePath: string, projectHash: string): string {
      const row = stmts.getPrefix.get(projectHash) as { prefix: string } | undefined;
      if (!row) {
        throw new Error(`Path prefix not registered for project_hash: ${projectHash}`);
      }
      return path.join(row.prefix, relativePath);
    },

    insertContent(hash: string, body: string) {
      stmts.insertContent.run(hash, body);
    },

    insertDocument(doc: Omit<Document, 'id'>): number {
      const relativePath = toRel(doc.path);
      log('store', 'insertDocument collection=' + doc.collection + ' path=' + relativePath);
      const result = stmts.insertDocument.run(
        doc.collection,
        relativePath,
        doc.title,
        doc.hash,
        doc.agent ?? null,
        doc.createdAt,
        doc.modifiedAt,
        doc.active ? 1 : 0,
        doc.projectHash ?? 'global'
      );
      const existing = stmts.findDocumentByPath.get(relativePath) as { id: number } | undefined;
      if (existing) return existing.id;
      const rowid = Number(result.lastInsertRowid);
      if (rowid > 0) return rowid;
      return 0;
    },

    findDocument(pathOrDocid: string): Document | null {
      let row: Record<string, unknown> | undefined;

      if (pathOrDocid.length === 6 && /^[a-f0-9]+$/i.test(pathOrDocid)) {
        row = stmts.findDocumentByDocid.get(pathOrDocid.toLowerCase()) as Record<string, unknown> | undefined;
      }

      if (!row) {
        const relativePath = toRel(pathOrDocid);
        row = stmts.findDocumentByPath.get(relativePath) as Record<string, unknown> | undefined;
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
      const row = stmts.getContent.get(hash) as { body: string } | undefined;
      if (!row) return null;

      if (fromLine === undefined && maxLines === undefined) {
        return row.body;
      }

      const lines = row.body.split('\n');
      const start = fromLine ?? 0;
      const end = maxLines !== undefined ? start + maxLines : lines.length;
      return lines.slice(start, end).join('\n');
    },

    deactivateDocument(collection: string, filePath: string) {
      stmts.deactivateDocument.run(collection, toRel(filePath));
    },

    bulkDeactivateExcept(collection: string, activePaths: string[]): number {
      const relativePaths = state.workspaceRoot
        ? activePaths.map(p => toRelativePath(p, state.workspaceRoot!))
        : activePaths;
      const transaction = db.transaction(() => {
        const beforeHashes = new Set<string>();
        if (state.vectorStore) {
          const rows = db.prepare('SELECT DISTINCT hash FROM documents WHERE collection = ? AND active = 1').all(collection) as Array<{ hash: string }>;
          for (const r of rows) beforeHashes.add(r.hash);
        }

        db.exec('CREATE TEMP TABLE IF NOT EXISTS _active_paths(path TEXT PRIMARY KEY)');
        db.exec('DELETE FROM _active_paths');
        const insertPath = db.prepare('INSERT OR IGNORE INTO _active_paths(path) VALUES(?)');
        const BATCH_SIZE = 200;
        const insertBatchInner = db.transaction((paths: string[]) => {
          for (const p of paths) insertPath.run(p);
        });
        for (let i = 0; i < relativePaths.length; i += BATCH_SIZE) {
          insertBatchInner(relativePaths.slice(i, i + BATCH_SIZE));
        }
        const updateStmt = db.prepare('UPDATE documents SET active = 0 WHERE collection = ? AND path NOT IN (SELECT path FROM _active_paths)');
        const result = updateStmt.run(collection);
        db.exec('DROP TABLE IF EXISTS _active_paths');

        let removedHashes: string[] = [];
        if (state.vectorStore && beforeHashes.size > 0) {
          const afterRows = db.prepare('SELECT DISTINCT hash FROM documents WHERE collection = ? AND active = 1').all(collection) as Array<{ hash: string }>;
          const afterHashes = new Set(afterRows.map(r => r.hash));
          removedHashes = [...beforeHashes].filter(h => !afterHashes.has(h));
        }

        return { changes: result.changes, removedHashes };
      });

      const { changes, removedHashes } = transaction();

      if (state.vectorStore && removedHashes.length > 0) {
        for (const hash of removedHashes) {
          state.vectorStore.deleteByHash(hash).catch(err => {
            log('store', 'bulkDeactivateExcept vector cleanup failed hash=' + hash.substring(0, 8));
            log('store', `Failed to cleanup vector: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          });
        }
      }

      return changes;
    },

    supersedeDocument(targetId: number, newId: number) {
      stmts.supersedeDocument.run(newId, targetId);
    },

    deleteDocumentsByPath(filePath: string): number {
      const relativePath = toRel(filePath);
      const deleteStmt = db.prepare(`DELETE FROM documents WHERE path = ? AND active = 1`);
      const result = deleteStmt.run(relativePath);
      return result.changes;
    },

    searchFTS(query: string, options: StoreSearchOptions = {}): SearchResult[] {
      const { limit = 10, collection, projectHash, tags, since, until } = options;
      const sanitized = sanitizeFTS5Query(query);
      if (!sanitized) return [];

      let sql = `
        SELECT
          d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
          d.centrality, d.cluster_id, d.superseded_by,
          d.access_count, d.last_accessed_at as lastAccessedAt,
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
        access_count: row.access_count as number | undefined,
        lastAccessedAt: row.lastAccessedAt as string | null | undefined,
      }));
    },

    getWorkspaceStats(): Array<{ projectHash: string; count: number }> {
      return stmts.getWorkspaceStats.all() as Array<{ projectHash: string; count: number }>;
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

    removeWorkspace(projectHash: string): RemoveWorkspaceResult {
      log('store', 'removeWorkspace project=' + projectHash);
      const transaction = db.transaction(() => {
        const flowsResult = db.prepare('DELETE FROM execution_flows WHERE project_hash = ?').run(projectHash);
        const symbolEdgesResult = db.prepare('DELETE FROM symbol_edges WHERE project_hash = ?').run(projectHash);
        const codeSymbolsResult = db.prepare('DELETE FROM code_symbols WHERE project_hash = ?').run(projectHash);
        const symbolsResult = db.prepare('DELETE FROM symbols WHERE project_hash = ?').run(projectHash);
        const fileEdgesResult = db.prepare('DELETE FROM file_edges WHERE project_hash = ?').run(projectHash);

        const docs = db.prepare(
          'SELECT id, hash, collection, path FROM documents WHERE project_hash = ?'
        ).all(projectHash) as Array<{ id: number; hash: string; collection: string; path: string }>;

        let embeddingsDeleted = 0;
        let contentDeleted = 0;

        if (docs.length > 0) {
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

          for (const hash of orphanedHashes) {
            const cvResult = db.prepare('DELETE FROM content_vectors WHERE hash = ?').run(hash);
            embeddingsDeleted += cvResult.changes;
            if (state.vecAvailable) {
              try {
                db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? || ':%'").run(hash);
              } catch { }
            }
          }

          db.prepare('DELETE FROM documents WHERE project_hash = ?').run(projectHash);

          for (const hash of orphanedHashes) {
            db.prepare('DELETE FROM content WHERE hash = ?').run(hash);
            contentDeleted++;
          }
        }

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

    clearWorkspace(projectHash: string): { documentsDeleted: number; embeddingsDeleted: number } {
      log('store', 'clearWorkspace project=' + projectHash);
      const transaction = db.transaction(() => {
        const docs = db.prepare(
          'SELECT id, hash, collection, path FROM documents WHERE project_hash = ?'
        ).all(projectHash) as Array<{ id: number; hash: string; collection: string; path: string }>;

        if (docs.length === 0) return { documentsDeleted: 0, embeddingsDeleted: 0 };

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

        let embeddingsDeleted = 0;
        for (const hash of orphanedHashes) {
          const cvResult = db.prepare('DELETE FROM content_vectors WHERE hash = ?').run(hash);
          embeddingsDeleted += cvResult.changes;
          if (state.vecAvailable) {
            try {
              db.prepare("DELETE FROM vectors_vec WHERE hash_seq LIKE ? || ':%'").run(hash);
            } catch { }
          }
        }

        const deleteResult = db.prepare('DELETE FROM documents WHERE project_hash = ?').run(projectHash);

        for (const hash of orphanedHashes) {
          db.prepare('DELETE FROM content WHERE hash = ?').run(hash);
        }

        db.prepare('DELETE FROM llm_cache WHERE project_hash = ?').run(projectHash);

        log('store', 'clearWorkspace result docs=' + deleteResult.changes + ' embeddings=' + embeddingsDeleted);
        return { documentsDeleted: deleteResult.changes, embeddingsDeleted };
      });
      return transaction();
    },
  };
}
