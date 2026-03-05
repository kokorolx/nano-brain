import type Database from 'better-sqlite3';
import { SqliteVecStore } from './providers/sqlite-vec.js';
import { QdrantVecStore } from './providers/qdrant.js';

export interface VectorSearchOptions {
  limit?: number;
  collection?: string;
  projectHash?: string;
}

export interface VectorSearchResult {
  hashSeq: string;
  score: number;
  hash: string;
  seq: number;
}

export interface VectorPointMetadata {
  hash: string;
  seq: number;
  pos: number;
  model: string;
  collection?: string;
  projectHash?: string;
}

export interface VectorPoint {
  id: string;
  embedding: number[];
  metadata: VectorPointMetadata;
}

export interface VectorStoreHealth {
  ok: boolean;
  provider: string;
  vectorCount: number;
  dimensions?: number;
  error?: string;
}

export interface VectorStore {
  search(embedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  upsert(point: VectorPoint): Promise<void>;
  batchUpsert(points: VectorPoint[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByHash(hash: string): Promise<void>;
  health(): Promise<VectorStoreHealth>;
  close(): Promise<void>;
}

export interface VectorConfig {
  provider: 'sqlite-vec' | 'qdrant';
  url?: string;
  apiKey?: string;
  collection?: string;
  dimensions?: number;
}

export function createVectorStore(
  config: VectorConfig,
  db?: Database.Database,
  vecAvailable?: boolean
): VectorStore {
  if (config.provider === 'sqlite-vec') {
    if (!db) {
      throw new Error('sqlite-vec provider requires a Database instance');
    }
    return new SqliteVecStore(db, vecAvailable ?? false);
  }

  if (config.provider === 'qdrant') {
    if (!config.url) {
      throw new Error('Qdrant provider requires a URL (vector.url in config.yml)');
    }
    return new QdrantVecStore({
      url: config.url,
      apiKey: config.apiKey,
      collection: config.collection,
      dimensions: config.dimensions,
    });
  }

  throw new Error(`Unknown vector store provider: ${config.provider}`);
}
