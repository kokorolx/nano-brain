import { bench, describe, afterAll } from 'vitest';
import { createBenchStore, cleanupBenchStore } from './fixtures.js';
import { computeHash } from '../../src/store.js';
import type { Store } from '../../src/types.js';

let store: Store;
let dbPath: string;

const setup = await createBenchStore();
store = setup.store;
dbPath = setup.dbPath;

afterAll(() => {
  cleanupBenchStore(store, dbPath);
});

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateEmbedding(rng: () => number, dimensions: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    embedding.push(rng() * 2 - 1);
  }
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / norm);
}

let docCounter = 1000;
let embeddingCounter = 0;
const embeddingRng = mulberry32(99999);

describe('Store Operations', () => {
  bench('insertDocument', () => {
    const content = `# Benchmark Document ${docCounter}\n\nThis is benchmark content for document ${docCounter}.`;
    const hash = computeHash(content);
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'bench-insert',
      path: `bench/insert-${docCounter++}.md`,
      title: `Benchmark Document ${docCounter}`,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
  });

  bench('insertEmbedding', () => {
    const hash = computeHash(`embedding-bench-${embeddingCounter++}`);
    const embedding = generateEmbedding(embeddingRng, 1024);
    store.insertContent(hash, `content-${embeddingCounter}`);
    store.insertEmbedding(hash, 0, 0, embedding, 'bench-model');
  });

  bench('getIndexHealth', () => {
    store.getIndexHealth();
  });
});
