import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResultCache } from '../src/cache.js';
import type { SearchResult } from '../src/types.js';

function createMockResult(id: string, score: number, snippet: string = 'test snippet'): SearchResult {
  return {
    id,
    path: `path/${id}`,
    collection: 'test',
    title: `Title ${id}`,
    snippet,
    score,
    startLine: 1,
    endLine: 10,
    docid: id.substring(0, 6),
  };
}

describe('ResultCache', () => {
  let cache: ResultCache;

  beforeEach(() => {
    cache = new ResultCache();
  });

  it('set() returns incrementing keys', () => {
    const results = [createMockResult('doc1', 0.9)];
    const key1 = cache.set(results, 'query1');
    const key2 = cache.set(results, 'query2');
    const key3 = cache.set(results, 'query3');

    expect(key1).toBe('search_1');
    expect(key2).toBe('search_2');
    expect(key3).toBe('search_3');
  });

  it('get() returns cached entry', () => {
    const results = [createMockResult('doc1', 0.9), createMockResult('doc2', 0.8)];
    const key = cache.set(results, 'test query');

    const entry = cache.get(key);

    expect(entry).not.toBeNull();
    expect(entry!.results).toEqual(results);
    expect(entry!.query).toBe('test query');
  });

  it('get() returns null for unknown key', () => {
    const entry = cache.get('nonexistent_key');
    expect(entry).toBeNull();
  });

  it('get() returns null after TTL expires', async () => {
    const shortTtlCache = new ResultCache(10);
    const results = [createMockResult('doc1', 0.9)];
    const key = shortTtlCache.set(results, 'query');

    await new Promise(resolve => setTimeout(resolve, 20));

    const entry = shortTtlCache.get(key);
    expect(entry).toBeNull();
  });

  it('lazy cleanup removes expired entries on set()', async () => {
    const shortTtlCache = new ResultCache(10);
    const results = [createMockResult('doc1', 0.9)];
    const key1 = shortTtlCache.set(results, 'query1');

    await new Promise(resolve => setTimeout(resolve, 20));

    shortTtlCache.set(results, 'query2');

    const entry1 = shortTtlCache.get(key1);
    expect(entry1).toBeNull();
  });

  it('stores startLine/endLine/docid per result', () => {
    const results = [
      { ...createMockResult('doc1', 0.9), startLine: 5, endLine: 15, docid: 'abc123' },
      { ...createMockResult('doc2', 0.8), startLine: 20, endLine: 30, docid: 'def456' },
    ];
    const key = cache.set(results, 'query');

    const entry = cache.get(key);

    expect(entry!.startLines).toEqual([5, 20]);
    expect(entry!.endLines).toEqual([15, 30]);
    expect(entry!.docids).toEqual(['abc123', 'def456']);
  });

  it('clear() removes all entries', () => {
    const results = [createMockResult('doc1', 0.9)];
    const key1 = cache.set(results, 'query1');
    const key2 = cache.set(results, 'query2');

    cache.clear();

    expect(cache.get(key1)).toBeNull();
    expect(cache.get(key2)).toBeNull();
  });
});
