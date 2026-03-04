import { bench, describe, afterAll } from 'vitest';
import { createBenchStore, cleanupBenchStore } from './fixtures.js';
import { computeHash } from '../../src/store.js';
import type { Store } from '../../src/types.js';

let store: Store;
let dbPath: string;
let cacheHashes: string[];

const setup = await createBenchStore();
store = setup.store;
dbPath = setup.dbPath;
cacheHashes = setup.cacheHashes;

afterAll(() => {
  cleanupBenchStore(store, dbPath);
});

let writeCounter = 0;

describe('Cache', () => {
  bench('cache hit', () => {
    store.getCachedResult(cacheHashes[0], 'bench');
  });

  bench('cache miss', () => {
    store.getCachedResult(computeHash(`nonexistent-${Date.now()}`), 'bench');
  });

  bench('cache write', () => {
    const newHash = computeHash(`new-cache-key-${writeCounter++}`);
    store.setCachedResult(newHash, JSON.stringify({ data: 'test' }), 'bench', 'expand');
  });
});
