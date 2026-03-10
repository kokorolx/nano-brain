import type { SearchResult } from './types.js';

export interface CacheEntry {
  results: SearchResult[];
  query: string;
  startLines: number[];
  endLines: number[];
  docids: string[];
  expires: number;
}

export class ResultCache {
  private cache = new Map<string, CacheEntry>();
  private counter = 0;
  private ttlMs: number;

  constructor(ttlMs: number = 15 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  set(results: SearchResult[], query: string): string {
    this.cleanup();
    
    this.counter++;
    const key = `search_${this.counter}`;
    this.cache.set(key, {
      results,
      query,
      startLines: results.map(r => r.startLine),
      endLines: results.map(r => r.endLine),
      docids: results.map(r => r.docid),
      expires: Date.now() + this.ttlMs,
    });
    return key;
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expires) {
        this.cache.delete(key);
      }
    }
  }
}
