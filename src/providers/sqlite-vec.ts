import type Database from 'better-sqlite3';
import type {
  VectorStore,
  VectorSearchOptions,
  VectorSearchResult,
  VectorPoint,
  VectorStoreHealth,
} from '../vector-store.js';
import { log } from '../logger.js';

export class SqliteVecStore implements VectorStore {
  private db: Database.Database;
  private vecAvailable: boolean;

  constructor(db: Database.Database, vecAvailable: boolean) {
    this.db = db;
    this.vecAvailable = vecAvailable;
  }

  async search(embedding: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    if (!this.vecAvailable) {
      return [];
    }

    const { limit = 10 } = options;

    try {
      const sql = `
        SELECT v.hash_seq, v.distance
        FROM vectors_vec v
        WHERE v.embedding MATCH ?
          AND k = ?
        ORDER BY v.distance
      `;

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(new Float32Array(embedding), limit) as Array<{
        hash_seq: string;
        distance: number;
      }>;

      log('sqlite-vec', 'search results=' + rows.length);

      return rows.map(row => {
        const [hash, seqStr] = row.hash_seq.split(':');
        return {
          hashSeq: row.hash_seq,
          score: 1 - row.distance,
          hash,
          seq: parseInt(seqStr, 10),
        };
      });
    } catch (err) {
      log('sqlite-vec', 'search failed: ' + (err instanceof Error ? err.message : String(err)), 'warn');
      return [];
    }
  }

  async upsert(point: VectorPoint): Promise<void> {
    if (!this.vecAvailable) {
      return;
    }

    const { id, embedding, metadata } = point;

    try {
      try {
        this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(id);
      } catch {
      }

      const insertVecStmt = this.db.prepare(`
        INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)
      `);
      insertVecStmt.run(id, new Float32Array(embedding));

      log('sqlite-vec', 'upsert id=' + id.substring(0, 16));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('UNIQUE constraint')) {
        log('sqlite-vec', 'upsert failed id=' + id.substring(0, 16) + ': ' + msg, 'warn');
      }
    }
  }

  async batchUpsert(points: VectorPoint[]): Promise<void> {
    if (!this.vecAvailable || points.length === 0) {
      return;
    }

    const deleteStmt = this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
    const insertStmt = this.db.prepare(`
      INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)
    `);

    const transaction = this.db.transaction((pts: VectorPoint[]) => {
      for (const point of pts) {
        try {
          deleteStmt.run(point.id);
        } catch {
        }
        try {
          insertStmt.run(point.id, new Float32Array(point.embedding));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('UNIQUE constraint')) {
            log('sqlite-vec', 'Failed to insert vector: ' + msg, 'warn');
          }
        }
      }
    });

    transaction(points);
    log('sqlite-vec', 'batchUpsert count=' + points.length);
  }

  async delete(id: string): Promise<void> {
    if (!this.vecAvailable) {
      return;
    }

    try {
      this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(id);
      log('sqlite-vec', 'delete id=' + id.substring(0, 16));
    } catch (err) {
      log('sqlite-vec', 'delete failed id=' + id.substring(0, 16) + ': ' + (err instanceof Error ? err.message : String(err)), 'warn');
    }
  }

  async deleteByHash(hash: string): Promise<void> {
    if (!this.vecAvailable) {
      return;
    }

    try {
      this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ? || ':%'`).run(hash);
      log('sqlite-vec', 'deleteByHash hash=' + hash.substring(0, 8));
    } catch (err) {
      log('sqlite-vec', 'deleteByHash failed hash=' + hash.substring(0, 8) + ': ' + (err instanceof Error ? err.message : String(err)), 'warn');
    }
  }

  async health(): Promise<VectorStoreHealth> {
    if (!this.vecAvailable) {
      return {
        ok: false,
        provider: 'sqlite-vec',
        vectorCount: 0,
        error: 'sqlite-vec extension not available',
      };
    }

    try {
      const countResult = this.db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number };
      return {
        ok: true,
        provider: 'sqlite-vec',
        vectorCount: countResult.count,
      };
    } catch (err) {
      return {
        ok: false,
        provider: 'sqlite-vec',
        vectorCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
  }

  ensureVecTable(dimensions: number): void {
    if (!this.vecAvailable) return;

    try {
      let needsRebuild = false;
      try {
        const testVec = new Float32Array(dimensions);
        this.db.prepare('SELECT hash_seq FROM vectors_vec WHERE embedding MATCH ? LIMIT 1').get(testVec);
        const vecCount = (this.db.prepare('SELECT COUNT(*) as count FROM vectors_vec').get() as { count: number }).count;
        const cvCount = (this.db.prepare('SELECT COUNT(*) as count FROM content_vectors').get() as { count: number }).count;
        if (vecCount === 0 && cvCount > 0) {
          log('sqlite-vec', 'vectors_vec empty but content_vectors has ' + cvCount + ' stale rows, clearing for re-embedding');
          this.db.exec(`DELETE FROM content_vectors`);
        }
        return;
      } catch {
        needsRebuild = true;
      }

      if (needsRebuild) {
        log('sqlite-vec', 'ensureVecTable rebuilding dimensions=' + dimensions);
        this.db.exec(`DROP TABLE IF EXISTS vectors_vec`);
        this.db.exec(`DELETE FROM content_vectors`);
        this.db.exec(`DELETE FROM llm_cache`);
        this.db.exec(`
          CREATE VIRTUAL TABLE vectors_vec USING vec0(
            hash_seq TEXT PRIMARY KEY,
            embedding float[${dimensions}] distance_metric=cosine
          );
        `);
        log('sqlite-vec', 'Recreated vectors_vec with ' + dimensions + ' dimensions, cleared content_vectors and llm_cache for re-embedding');
      }
    } catch (err) {
      log('sqlite-vec', 'Failed to recreate vector table: ' + (err instanceof Error ? err.message : String(err)), 'warn');
    }
  }

  cleanOrphanedVectors(): number {
    if (!this.vecAvailable) {
      return 0;
    }

    try {
      const deleteVecStmt = this.db.prepare(`
        DELETE FROM vectors_vec WHERE substr(hash_seq, 1, instr(hash_seq, ':') - 1) NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
      `);
      const result = deleteVecStmt.run();
      log('sqlite-vec', 'cleanOrphanedVectors deleted=' + result.changes);
      return result.changes;
    } catch (err) {
      log('sqlite-vec', 'Failed to clean orphaned vectors: ' + (err instanceof Error ? err.message : String(err)), 'warn');
      return 0;
    }
  }
}
