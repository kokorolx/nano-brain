import { describe, it, expect } from 'vitest';
import {
  generateQueryId,
  jaccardSimilarity,
  levenshteinDistance,
  detectReformulation,
} from '../src/telemetry.js';

describe('telemetry', () => {
  describe('generateQueryId', () => {
    it('returns unique UUIDs', () => {
      const id1 = generateQueryId();
      const id2 = generateQueryId();
      const id3 = generateQueryId();
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('jaccardSimilarity', () => {
    it('returns 1 for identical strings', () => {
      expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
      expect(jaccardSimilarity('hello world', 'foo bar baz')).toBe(0);
    });

    it('returns correct similarity for partial overlap', () => {
      const sim = jaccardSimilarity('hello world', 'hello there');
      expect(sim).toBeCloseTo(1 / 3, 2);
    });

    it('is case insensitive', () => {
      expect(jaccardSimilarity('Hello World', 'hello world')).toBe(1);
    });

    it('handles empty strings', () => {
      expect(jaccardSimilarity('', '')).toBe(1);
      expect(jaccardSimilarity('hello', '')).toBe(0);
      expect(jaccardSimilarity('', 'world')).toBe(0);
    });
  });

  describe('levenshteinDistance', () => {
    it('returns 0 for identical strings', () => {
      expect(levenshteinDistance('hello', 'hello')).toBe(0);
    });

    it('returns length for empty vs non-empty', () => {
      expect(levenshteinDistance('', 'hello')).toBe(5);
      expect(levenshteinDistance('hello', '')).toBe(5);
    });

    it('returns correct distance for single edit', () => {
      expect(levenshteinDistance('hello', 'hallo')).toBe(1);
      expect(levenshteinDistance('hello', 'helloo')).toBe(1);
      expect(levenshteinDistance('hello', 'hell')).toBe(1);
    });

    it('returns correct distance for multiple edits', () => {
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    });
  });

  describe('detectReformulation', () => {
    it('returns null for no recent queries', () => {
      const result = detectReformulation('test query', []);
      expect(result).toBeNull();
    });

    it('returns null for dissimilar queries', () => {
      const recentQueries = [
        { id: 1, query_text: 'completely different topic' },
        { id: 2, query_text: 'another unrelated search' },
      ];
      const result = detectReformulation('test query', recentQueries);
      expect(result).toBeNull();
    });

    it('detects reformulation via Jaccard similarity', () => {
      const recentQueries = [
        { id: 1, query_text: 'how to implement search' },
      ];
      const result = detectReformulation('how to implement search feature', recentQueries);
      expect(result).toBe(1);
    });

    it('detects reformulation via Levenshtein distance', () => {
      const recentQueries = [
        { id: 42, query_text: 'authentication flow' },
      ];
      const result = detectReformulation('authentication flows', recentQueries);
      expect(result).toBe(42);
    });

    it('skips identical queries', () => {
      const recentQueries = [
        { id: 1, query_text: 'exact same query' },
      ];
      const result = detectReformulation('exact same query', recentQueries);
      expect(result).toBeNull();
    });

    it('returns first matching reformulation', () => {
      const recentQueries = [
        { id: 1, query_text: 'search implementation' },
        { id: 2, query_text: 'search impl' },
      ];
      const result = detectReformulation('search implementation guide', recentQueries);
      expect(result).toBe(1);
    });
  });
});
