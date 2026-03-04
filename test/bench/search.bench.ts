import { bench, describe, afterAll } from 'vitest';
import { createBenchStore, cleanupBenchStore, BENCH_QUERIES, BENCH_EMBEDDINGS } from './fixtures.js';
import { hybridSearch } from '../../src/search.js';
import type { Store } from '../../src/types.js';

let store: Store;
let dbPath: string;

const setup = await createBenchStore();
store = setup.store;
dbPath = setup.dbPath;

afterAll(() => {
  cleanupBenchStore(store, dbPath);
});

const mockEmbedder = {
  embed: async (_text: string) => ({
    embedding: BENCH_EMBEDDINGS[0],
    model: 'mock',
    dimensions: 1024,
  }),
};

describe('FTS Search', () => {
  bench('simple query', () => {
    store.searchFTS(BENCH_QUERIES[0].split(' ')[0], 10);
  });

  bench('multi-term query', () => {
    store.searchFTS(BENCH_QUERIES[0], 10);
  });
});

describe('Vector Search', () => {
  bench('vector search', () => {
    store.searchVec(BENCH_QUERIES[0], BENCH_EMBEDDINGS[0], 10);
  });
});

describe('Hybrid Search', () => {
  bench('hybrid search', async () => {
    await hybridSearch(
      store,
      { query: BENCH_QUERIES[0], limit: 10 },
      { embedder: mockEmbedder }
    );
  });
});
