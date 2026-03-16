import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'crypto';
import { resolveHostUrl } from '../host.js';
import { log } from '../logger.js';
import type {
  VectorStore,
  VectorSearchOptions,
  VectorSearchResult,
  VectorPoint,
  VectorStoreHealth,
} from '../vector-store.js';

export interface QdrantVecStoreOptions {
  url: string;
  apiKey?: string;
  collection?: string;
  dimensions?: number;
}

// UUID v5-style deterministic ID from hash:seq string.
// Uses SHA-256 truncated to 128 bits, formatted as UUID.
// Collision-safe for millions of vectors (vs 32-bit hashStringToInt which collided at 49K).
function stringToUuid(str: string): string {
  const sha = createHash('sha256').update(str).digest('hex');
  return [
    sha.slice(0, 8),
    sha.slice(8, 12),
    '5' + sha.slice(13, 16),  // version 5
    ((parseInt(sha.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + sha.slice(18, 20),  // variant
    sha.slice(20, 32),
  ].join('-');
}

export class QdrantVecStore implements VectorStore {
  private client: QdrantClient;
  private collectionName: string;
  private dimensions: number;
  private initialized = false;

  constructor(options: QdrantVecStoreOptions) {
    const resolvedUrl = resolveHostUrl(options.url);
    this.client = new QdrantClient({
      url: resolvedUrl,
      apiKey: options.apiKey,
    });
    this.collectionName = options.collection ?? 'nano-brain';
    this.dimensions = options.dimensions ?? 1024;
  }

  async ensureCollection(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.client.getCollection(this.collectionName);
    } catch (err) {
      const errAny = err as any;
      const isNotFound = (errAny?.status === 404) ||
        (err instanceof Error && 
          (err.message.includes('404') || err.message.includes('Not found') || err.message.includes('doesn\'t exist')));
      
      if (isNotFound) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.dimensions,
            distance: 'Cosine',
          },
        });

        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'hash',
          field_schema: 'keyword',
        });

        await this.client.createPayloadIndex(this.collectionName, {
          field_name: 'collection',
          field_schema: 'keyword',
        });
      } else {
        throw err;
      }
    }

    this.initialized = true;
  }

  async search(embedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]> {
    await this.ensureCollection();

    const limit = options?.limit ?? 10;
    const filter: { must: Array<{ key: string; match: { value: string } }> } = { must: [] };

    if (options?.collection) {
      filter.must.push({
        key: 'collection',
        match: { value: options.collection },
      });
    }

    if (options?.projectHash) {
      filter.must.push({
        key: 'projectHash',
        match: { value: options.projectHash },
      });
    }

    const searchResult = await this.client.search(this.collectionName, {
      vector: embedding,
      limit,
      filter: filter.must.length > 0 ? filter : undefined,
      with_payload: true,
    });

    return searchResult.map((point) => {
      const payload = point.payload as { hashSeq?: string; hash?: string; seq?: number } | null;
      const hashSeq = payload?.hashSeq ?? String(point.id);
      
      let hash = payload?.hash ?? '';
      let seq = payload?.seq ?? 0;
      
      if (!hash && hashSeq.includes(':')) {
        const parts = hashSeq.split(':');
        hash = parts[0];
        seq = parseInt(parts[1], 10) || 0;
      }

      return {
        hashSeq,
        score: point.score,
        hash,
        seq,
      };
    });
  }

  private async retryOnSocketError<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause = (err as any)?.cause;
        const causeCode = cause?.code;
        const isSocketError = causeCode === 'UND_ERR_SOCKET' ||
          causeCode === 'ECONNRESET' ||
          causeCode === 'ECONNREFUSED' ||
          msg.includes('other side closed') ||
          msg.includes('fetch failed') ||
          msg.includes('socket hang up');
        
        if (isSocketError && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          log('qdrant', 'Socket error, retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + '/' + maxRetries + ')', 'warn');
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  async upsert(point: VectorPoint): Promise<void> {
    await this.ensureCollection();

    const uuid = stringToUuid(point.id);

    await this.retryOnSocketError(() =>
      this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: uuid,
            vector: point.embedding,
            payload: {
              ...point.metadata,
              hashSeq: point.id,
            },
          },
        ],
      })
    );
  }

  async batchUpsert(points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.ensureCollection();

    const BATCH_SIZE = 100;
    
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      
      await this.retryOnSocketError(() =>
        this.client.upsert(this.collectionName, {
          wait: true,
          points: batch.map((point) => ({
            id: stringToUuid(point.id),
            vector: point.embedding,
            payload: {
              ...point.metadata,
              hashSeq: point.id,
            },
          })),
        })
      );
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureCollection();

    const uuid = stringToUuid(id);
    
    await this.client.delete(this.collectionName, {
      wait: true,
      points: [uuid],
    });
  }

  async deleteByHash(hash: string): Promise<void> {
    await this.ensureCollection();

    await this.client.delete(this.collectionName, {
      wait: true,
      filter: {
        must: [
          {
            key: 'hash',
            match: { value: hash },
          },
        ],
      },
    });
  }

  async health(): Promise<VectorStoreHealth> {
    try {
      await this.ensureCollection();
      const info = await this.client.getCollection(this.collectionName);
      
      return {
        ok: true,
        provider: 'qdrant',
        vectorCount: info.points_count ?? 0,
        dimensions: this.dimensions,
      };
    } catch (err) {
      return {
        ok: false,
        provider: 'qdrant',
        vectorCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
  }
}
