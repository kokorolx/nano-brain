import Database from 'better-sqlite3';
import type { VectorStore, VectorPoint } from '../vector-store.js';
import { SqliteVecStore } from '../providers/sqlite-vec.js';
import { QdrantVecStore, stringToUuid } from '../providers/qdrant.js';
import type { SearchResult, StoreSearchOptions } from '../types.js';
import { log } from '../logger.js';
import type { Stmts } from './schema.js';

export function makeVectorMethods(
  db: Database.Database,
  stmts: Stmts,
  state: { vecAvailable: boolean; vectorStore: VectorStore | null }
) {
  return {
    setVectorStore(vs: VectorStore | null): void {
      state.vectorStore = vs;
    },

    getVectorStore(): VectorStore | null {
      return state.vectorStore;
    },

    insertEmbeddingLocal(hash: string, seq: number, pos: number, model: string, filePath?: string) {
      const pathSuffix = filePath ? ' path=' + filePath : '';
      log('store', 'insertEmbeddingLocal hash=' + hash.substring(0, 8) + ' seq=' + seq + pathSuffix, 'debug');
      stmts.insertEmbedding.run(hash, seq, pos, model);
    },

    async insertEmbeddingLocalBatch(items: Array<{ hash: string; seq: number; pos: number; model: string }>): Promise<void> {
      if (items.length === 0) return;
      const SUB_BATCH_SIZE = 25;
      const batchTx = db.transaction((rows: typeof items) => {
        for (const item of rows) {
          stmts.insertEmbedding.run(item.hash, item.seq, item.pos, item.model);
        }
      });
      for (let i = 0; i < items.length; i += SUB_BATCH_SIZE) {
        const subBatch = items.slice(i, i + SUB_BATCH_SIZE);
        try {
          batchTx(subBatch);
        } catch (err: any) {
          if (err?.code === 'SQLITE_BUSY') {
            log('store', 'insertEmbeddingLocalBatch SQLITE_BUSY skip sub-batch i=' + i, 'warn');
            continue;
          }
          throw err;
        }
        if (i + SUB_BATCH_SIZE < items.length) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      log('store', 'insertEmbeddingLocalBatch count=' + items.length, 'debug');
    },

    insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string, externalVectorStore?: VectorStore) {
      log('store', 'insertEmbedding hash=' + hash.substring(0, 8) + ' seq=' + seq, 'debug');
      stmts.insertEmbedding.run(hash, seq, pos, model);

      const useExternalStore = externalVectorStore && !(externalVectorStore instanceof SqliteVecStore);

      if (useExternalStore) {
        let projectHash: string | undefined;
        let createdAt: string | undefined;
        try {
          const docRow = db.prepare(`SELECT project_hash, created_at FROM documents WHERE hash = ? LIMIT 1`).get(hash) as { project_hash: string; created_at: string } | undefined;
          projectHash = docRow?.project_hash ?? undefined;
          createdAt = docRow?.created_at ?? undefined;
        } catch {
        }

        const point: VectorPoint = {
          id: `${hash}:${seq}`,
          embedding,
          metadata: { hash, seq, pos, model, projectHash, createdAt },
        };
        externalVectorStore.upsert(point).catch((err) => {
          log('store', 'insertEmbedding external vector store upsert failed hash=' + hash.substring(0, 8));
          log('store', `External vector store upsert failed for ${hash.substring(0, 8)}:${seq}, will retry on next embedding cycle: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        });
      } else if (state.vecAvailable) {
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
            log('store', `Failed to insert vector: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          }
        }
      }
    },

    ensureVecTable(dimensions: number) {
      if (!state.vecAvailable) return;
      try {
        let needsRebuild = false;
        try {
          const testVec = new Float32Array(dimensions);
          db.prepare('SELECT hash_seq FROM vectors_vec WHERE embedding MATCH ? LIMIT 1').get(testVec);
          const vecCount = (db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number }).count;
          const cvCount = (db.prepare('SELECT COUNT(*) as count FROM content_vectors').get() as { count: number }).count;
          const usingExternalVectorStore = state.vectorStore && !(state.vectorStore instanceof SqliteVecStore);
          if (vecCount === 0 && cvCount > 0 && !usingExternalVectorStore) {
            log('store', 'ensureVecTable clearing stale content_vectors count=' + cvCount);
            log('store', `vectors_vec empty but content_vectors has ${cvCount} stale rows, clearing for re-embedding`, 'error');
            db.exec(`DELETE FROM content_vectors`);
          } else if (vecCount === 0 && cvCount > 0 && usingExternalVectorStore) {
            log('store', `ensureVecTable: vectors_vec empty but external vector store active, skipping content_vectors clear (${cvCount} rows preserved)`);
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
          log('store', `Recreated vectors_vec with ${dimensions} dimensions, cleared content_vectors and llm_cache for re-embedding`);
        }
      } catch (err) {
        log('store', `Failed to recreate vector table: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    searchVec(query: string, embedding: number[], options: StoreSearchOptions = {}): SearchResult[] {
      const { limit = 10, collection, projectHash, tags, since, until } = options;
      if (!state.vecAvailable) {
        return [];
      }

      try {
        let sql = `
          SELECT v.hash_seq, v.distance, d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
                 d.centrality, d.cluster_id, d.superseded_by,
                 d.access_count, d.last_accessed_at as lastAccessedAt,
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
          access_count: row.access_count as number | undefined,
          lastAccessedAt: row.lastAccessedAt as string | null | undefined,
        }));
      } catch (err) {
        log('store', `Vector search failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return [];
      }
    },

    async searchVecAsync(query: string, embedding: number[], options: StoreSearchOptions = {}): Promise<SearchResult[]> {
      const { limit = 10, collection, projectHash, tags, since, until } = options;

      if (state.vectorStore) {
        try {
          const vecProjectHash = projectHash && projectHash !== 'all' ? projectHash : undefined;
          const vecResults = await state.vectorStore.search(embedding, { limit: limit * 3, collection, projectHash: vecProjectHash });
          if (vecResults.length === 0) return [];

          const results: SearchResult[] = [];
          for (const vr of vecResults) {
            const row = db.prepare(`
              SELECT d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
                     d.centrality, d.cluster_id, d.superseded_by, d.modified_at,
                     d.created_at as createdAt,
                     d.access_count, d.last_accessed_at as lastAccessedAt,
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
              access_count: row.access_count as number | undefined,
              lastAccessedAt: row.lastAccessedAt as string | null | undefined,
              createdAt: row.createdAt as string | undefined,
              charLength: (row.snippet as string | null)?.length,
            });
          }

          log('store', 'searchVecAsync(qdrant) query=' + query + ' results=' + results.length, 'debug');
          return results;
        } catch (err) {
          log('store', 'searchVecAsync qdrant failed, falling back to SQLite: ' + (err instanceof Error ? err.message : String(err)));
        }
      }

      return this.searchVec(query, embedding, options);
    },

    cleanupVectorsForHash(hash: string): void {
      if (state.vectorStore) {
        state.vectorStore.deleteByHash(hash).catch(err => {
          log('store', 'cleanupVectorsForHash failed hash=' + hash.substring(0, 8));
          log('store', `Failed to cleanup vectors for hash: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        });
      }
    },

    cleanOrphanedEmbeddings(): number {
      const transaction = db.transaction(() => {
        let totalDeleted = 0;

        let orphanedHashes: string[] = [];
        if (state.vectorStore) {
          orphanedHashes = (db.prepare(`
            SELECT DISTINCT hash FROM content_vectors WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
          `).all() as Array<{ hash: string }>).map(r => r.hash);
        }

        const deleteContentVectorsStmt = db.prepare(`
          DELETE FROM content_vectors WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
        `);
        const cvResult = deleteContentVectorsStmt.run();
        totalDeleted += cvResult.changes;

        if (state.vecAvailable) {
          try {
            const deleteVecStmt = db.prepare(`
              DELETE FROM vectors_vec WHERE substr(hash_seq, 1, instr(hash_seq, ':') - 1) NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
            `);
            const vecResult = deleteVecStmt.run();
            totalDeleted += vecResult.changes;
          } catch {
          }
        }

        return { totalDeleted, orphanedHashes };
      });

      const { totalDeleted, orphanedHashes } = transaction();

      if (state.vectorStore && orphanedHashes.length > 0) {
        for (const hash of orphanedHashes) {
          state.vectorStore.deleteByHash(hash).catch(err => {
            log('store', 'cleanOrphanedEmbeddings vector cleanup failed hash=' + hash.substring(0, 8));
            log('store', `Failed to cleanup orphaned vector: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          });
        }
        log('store', 'cleanOrphanedEmbeddings queued ' + orphanedHashes.length + ' vector store deletes');
      }

      log('store', 'cleanOrphanedEmbeddings deleted=' + totalDeleted);
      return totalDeleted;
    },

    getSqliteVecCount(): number {
      if (!state.vecAvailable) return 0;
      try {
        const row = db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number };
        return row.count;
      } catch { return 0; }
    },

    getHashesNeedingEmbedding(projectHash?: string, limit?: number): Array<{ hash: string; body: string; path: string }> {
      const effectiveLimit = limit ?? 1000000;
      if (projectHash && projectHash !== 'all') {
        return stmts.getHashesNeedingEmbeddingByWorkspace.all(projectHash, effectiveLimit) as Array<{ hash: string; body: string; path: string }>;
      }
      return stmts.getHashesNeedingEmbedding.all(effectiveLimit) as Array<{ hash: string; body: string; path: string }>;
    },

    getNextHashNeedingEmbedding(projectHash?: string): { hash: string; body: string; path: string } | null {
      if (projectHash && projectHash !== 'all') {
        return stmts.getNextHashNeedingEmbeddingByWorkspace.get(projectHash) as { hash: string; body: string; path: string } | null;
      }
      return stmts.getNextHashNeedingEmbedding.get() as { hash: string; body: string; path: string } | null;
    },
  };
}

export async function backfillQdrantProjectHash(db: Database.Database, vectorStore: VectorStore): Promise<void> {
  if (!(vectorStore instanceof QdrantVecStore)) return;

  const rows = db.prepare(`
    SELECT cv.hash, cv.seq, d.project_hash
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    WHERE d.project_hash IS NOT NULL
  `).all() as Array<{ hash: string; seq: number; project_hash: string }>;

  if (rows.length === 0) return;

  log('store', 'backfillQdrantProjectHash starting rows=' + rows.length);

  const BATCH_SIZE = 100;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await (vectorStore as QdrantVecStore).batchSetPayload(batch.map(r => ({
        id: stringToUuid(`${r.hash}:${r.seq}`),
        payload: { projectHash: r.project_hash },
      })));
    } catch (err) {
      log('store', 'backfillQdrantProjectHash batch failed i=' + i + ' err=' + (err instanceof Error ? err.message : String(err)), 'warn');
    }
  }

  log('store', 'backfillQdrantProjectHash complete rows=' + rows.length);
}
