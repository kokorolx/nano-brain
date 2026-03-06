import { describe, it, expect, vi } from 'vitest';
import {
  rrfFuse,
  applyTopRankBonus,
  positionAwareBlend,
  formatSnippet,
  searchFTS,
  searchVec,
  hybridSearch,
} from '../src/search.js';
import type { SearchResult, Store } from '../src/types.js';

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

function createMockStore(ftsResults: SearchResult[], vecResults: SearchResult[]): Store {
  return {
    searchFTS: vi.fn().mockReturnValue(ftsResults),
    searchVec: vi.fn().mockReturnValue(vecResults),
    searchVecAsync: vi.fn().mockResolvedValue(vecResults),
    getCachedResult: vi.fn().mockReturnValue(null),
    setCachedResult: vi.fn(),
    getQueryEmbeddingCache: vi.fn().mockReturnValue(null),
    setQueryEmbeddingCache: vi.fn(),
    clearQueryEmbeddingCache: vi.fn(),
    clearCache: vi.fn().mockReturnValue(0),
    getCacheStats: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    insertDocument: vi.fn(),
    findDocument: vi.fn(),
    getDocumentBody: vi.fn(),
    deactivateDocument: vi.fn(),
    bulkDeactivateExcept: vi.fn(),
    insertContent: vi.fn(),
    insertEmbedding: vi.fn(),
    ensureVecTable: vi.fn(),
    getIndexHealth: vi.fn(),
    getHashesNeedingEmbedding: vi.fn(),
    getNextHashNeedingEmbedding: vi.fn().mockReturnValue(null),
    getWorkspaceStats: vi.fn().mockReturnValue([]),
    deleteDocumentsByPath: vi.fn().mockReturnValue(0),
    clearWorkspace: vi.fn().mockReturnValue({ documentsDeleted: 0, embeddingsDeleted: 0 }),
    cleanOrphanedEmbeddings: vi.fn().mockReturnValue(0),
    getCollectionStorageSize: vi.fn().mockReturnValue(0),
    modelStatus: { embedding: 'missing', reranker: 'missing', expander: 'missing' },
  } as unknown as Store;
}

describe('Search Pipeline', () => {
  describe('rrfFuse', () => {
    it('should merge two result sets with RRF scores', () => {
      const set1 = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
        createMockResult('doc3', 6),
      ];
      const set2 = [
        createMockResult('doc2', 9),
        createMockResult('doc4', 7),
        createMockResult('doc1', 5),
      ];
      
      const merged = rrfFuse([set1, set2], 60);
      
      expect(merged.length).toBe(4);
      expect(merged[0].id).toBe('doc2');
      expect(merged.map(r => r.id)).toContain('doc1');
      expect(merged.map(r => r.id)).toContain('doc3');
      expect(merged.map(r => r.id)).toContain('doc4');
    });
    
    it('should apply weights correctly - original query gets 2x weight', () => {
      const originalSet = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
      ];
      const expandedSet = [
        createMockResult('doc3', 10),
        createMockResult('doc2', 9),
      ];
      
      const merged = rrfFuse([originalSet, expandedSet], 60, [2, 1]);
      
      expect(merged[0].id).toBe('doc2');
      expect(merged[0].score).toBeGreaterThan(merged[1].score);
    });
    
    it('should handle different k values', () => {
      const set1 = [createMockResult('doc1', 10)];
      
      const mergedK60 = rrfFuse([set1], 60);
      const mergedK30 = rrfFuse([set1], 30);
      
      expect(mergedK30[0].score).toBeGreaterThan(mergedK60[0].score);
    });
    
    it('should deduplicate documents across sets', () => {
      const set1 = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
      ];
      const set2 = [
        createMockResult('doc1', 9),
        createMockResult('doc2', 7),
      ];
      
      const merged = rrfFuse([set1, set2], 60);
      
      expect(merged.length).toBe(2);
      expect(merged[0].score).toBeGreaterThan(1 / 61);
    });
    
    it('should handle empty result sets', () => {
      const merged = rrfFuse([[], []], 60);
      expect(merged.length).toBe(0);
    });
  });
  
  describe('applyTopRankBonus', () => {
    it('should add +0.05 bonus to rank #1', () => {
      const originalFts = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
      ];
      const rrfResults = [
        createMockResult('doc2', 0.5),
        createMockResult('doc1', 0.4),
      ];
      
      const boosted = applyTopRankBonus(rrfResults, originalFts);
      
      const doc1 = boosted.find(r => r.id === 'doc1');
      expect(doc1?.score).toBe(0.45);
    });
    
    it('should add +0.02 bonus to rank #2 and #3', () => {
      const originalFts = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
        createMockResult('doc3', 6),
        createMockResult('doc4', 4),
      ];
      const rrfResults = [
        createMockResult('doc4', 0.5),
        createMockResult('doc3', 0.4),
        createMockResult('doc2', 0.3),
        createMockResult('doc1', 0.2),
      ];
      
      const boosted = applyTopRankBonus(rrfResults, originalFts);
      
      const doc2 = boosted.find(r => r.id === 'doc2');
      const doc3 = boosted.find(r => r.id === 'doc3');
      expect(doc2?.score).toBeCloseTo(0.32, 5);
      expect(doc3?.score).toBeCloseTo(0.42, 5);
    });
    
    it('should not add bonus to other ranks', () => {
      const originalFts = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
        createMockResult('doc3', 6),
        createMockResult('doc4', 4),
      ];
      const rrfResults = [
        createMockResult('doc4', 0.5),
      ];
      
      const boosted = applyTopRankBonus(rrfResults, originalFts);
      
      const doc4 = boosted.find(r => r.id === 'doc4');
      expect(doc4?.score).toBe(0.5);
    });
    
    it('should re-sort after applying bonuses', () => {
      const originalFts = [
        createMockResult('doc1', 10),
      ];
      const rrfResults = [
        createMockResult('doc2', 0.5),
        createMockResult('doc1', 0.48),
      ];
      
      const boosted = applyTopRankBonus(rrfResults, originalFts);
      
      expect(boosted[0].id).toBe('doc1');
      expect(boosted[0].score).toBe(0.53);
    });
  });
  
  describe('positionAwareBlend', () => {
    it('should use 75/25 split for top 3 positions', () => {
      const rrfResults = [
        createMockResult('doc1', 0.8),
        createMockResult('doc2', 0.7),
        createMockResult('doc3', 0.6),
      ];
      const rerankScores = new Map([
        ['doc1', 0.4],
        ['doc2', 0.5],
        ['doc3', 0.6],
      ]);
      
      const blended = positionAwareBlend(rrfResults, rerankScores);
      
      expect(blended[0].score).toBeCloseTo(0.75 * 0.8 + 0.25 * 0.4, 5);
      expect(blended[1].score).toBeCloseTo(0.75 * 0.7 + 0.25 * 0.5, 5);
      expect(blended[2].score).toBeCloseTo(0.75 * 0.6 + 0.25 * 0.6, 5);
    });
    
    it('should use 60/40 split for positions 4-10', () => {
      const rrfResults = Array.from({ length: 10 }, (_, i) =>
        createMockResult(`doc${i}`, 1 - i * 0.05)
      );
      const rerankScores = new Map(
        rrfResults.map((r, i) => [r.id, 0.9 - i * 0.05])
      );
      
      const blended = positionAwareBlend(rrfResults, rerankScores);
      
      const doc3 = blended.find(r => r.id === 'doc3');
      const expectedScore = 0.60 * (1 - 3 * 0.05) + 0.40 * (0.9 - 3 * 0.05);
      expect(doc3?.score).toBeCloseTo(expectedScore, 5);
    });
    
    it('should use 40/60 split for positions 11+', () => {
      const rrfResults = Array.from({ length: 15 }, (_, i) =>
        createMockResult(`doc${i}`, 1 - i * 0.03)
      );
      const rerankScores = new Map(
        rrfResults.map((r, i) => [r.id, 0.9 - i * 0.03])
      );
      
      const blended = positionAwareBlend(rrfResults, rerankScores);
      
      const doc10 = blended.find(r => r.id === 'doc10');
      const expectedScore = 0.40 * (1 - 10 * 0.03) + 0.60 * (0.9 - 10 * 0.03);
      expect(doc10?.score).toBeCloseTo(expectedScore, 5);
    });
    
    it('should use RRF score as-is when rerank score is missing', () => {
      const rrfResults = [
        createMockResult('doc1', 0.8),
        createMockResult('doc2', 0.7),
      ];
      const rerankScores = new Map([
        ['doc1', 0.5],
      ]);
      
      const blended = positionAwareBlend(rrfResults, rerankScores);
      
      const doc2 = blended.find(r => r.id === 'doc2');
      expect(doc2?.score).toBe(0.7);
    });
    
    it('should re-sort after blending', () => {
      const rrfResults = [
        createMockResult('doc1', 0.5),
        createMockResult('doc2', 0.4),
      ];
      const rerankScores = new Map([
        ['doc1', 0.3],
        ['doc2', 0.9],
      ]);
      
      const blended = positionAwareBlend(rrfResults, rerankScores);
      
      expect(blended[0].id).toBe('doc2');
    });
  });
  
  describe('formatSnippet', () => {
    it('should return text as-is if under max length', () => {
      const text = 'Short text';
      expect(formatSnippet(text, 100)).toBe('Short text');
    });
    
    it('should truncate at word boundary with ellipsis', () => {
      const text = 'This is a long text that needs to be truncated at a word boundary';
      const result = formatSnippet(text, 30);
      
      expect(result.endsWith('...')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(33);
      expect(result).not.toContain('boundar');
    });
    
    it('should truncate with ellipsis if no good word boundary', () => {
      const text = 'a'.repeat(1000);
      const result = formatSnippet(text, 700);
      
      expect(result.endsWith('...')).toBe(true);
      expect(result.length).toBe(703);
    });
    
    it('should use default max length of 700', () => {
      const text = 'a'.repeat(1000);
      const result = formatSnippet(text);
      
      expect(result.length).toBe(703);
    });
  });
  
  describe('searchFTS', () => {
    it('should call store.searchFTS with correct parameters', () => {
      const mockResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockResults, []);
      
      const results = searchFTS(store, 'test query', { limit: 5, collection: 'test-col' });
      
      expect(store.searchFTS).toHaveBeenCalledWith('test query', { limit: 5, collection: 'test-col' });
      expect(results).toEqual(mockResults);
    });
    
    it('should work without options', () => {
      const mockResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockResults, []);
      
      const results = searchFTS(store, 'test query');
      
      expect(store.searchFTS).toHaveBeenCalledWith('test query', undefined);
      expect(results).toEqual(mockResults);
    });
  });
  
  describe('searchVec', () => {
    it('should call store.searchVec with correct parameters', () => {
      const mockResults = [createMockResult('doc1', 0.9)];
      const store = createMockStore([], mockResults);
      const embedding = [0.1, 0.2, 0.3];
      
      const results = searchVec(store, 'test query', embedding, { limit: 5, collection: 'test-col' });
      
      expect(store.searchVec).toHaveBeenCalledWith('test query', embedding, { limit: 5, collection: 'test-col' });
      expect(results).toEqual(mockResults);
    });
  });
  
  describe('hybridSearch', () => {
    it('should work with BM25 only (no embedder/reranker/expander)', async () => {
      const mockFtsResults = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
      ];
      const store = createMockStore(mockFtsResults, []);
      
      const results = await hybridSearch(
        store,
        { query: 'test query', limit: 10 },
        {}
      );
      
      expect(results.length).toBeGreaterThan(0);
      expect(store.searchFTS).toHaveBeenCalled();
    });
    
    it('should use expanded queries when expander is provided', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      
      const expander = {
        expand: vi.fn().mockResolvedValue(['variant1', 'variant2']),
      };
      
      await hybridSearch(
        store,
        { query: 'test query', useExpansion: true },
        { expander }
      );
      
      expect(expander.expand).toHaveBeenCalledWith('test query');
      expect(store.searchFTS).toHaveBeenCalledTimes(3);
    });
    
    it('should cache expansion results', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      
      const expander = {
        expand: vi.fn().mockResolvedValue(['variant1', 'variant2']),
      };
      
      await hybridSearch(
        store,
        { query: 'test query', useExpansion: true },
        { expander }
      );
      
      expect(store.setCachedResult).toHaveBeenCalled();
      const cacheCall = (store.setCachedResult as any).mock.calls[0];
      expect(cacheCall[1]).toContain('variant1');
    });
    
    it('should use cached expansion results', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      (store.getCachedResult as any).mockReturnValue('["variant1","variant2"]');
      
      const expander = {
        expand: vi.fn().mockResolvedValue(['should-not-be-called']),
      };
      
      await hybridSearch(
        store,
        { query: 'test query', useExpansion: true },
        { expander }
      );
      
      expect(expander.expand).not.toHaveBeenCalled();
      expect(store.searchFTS).toHaveBeenCalledTimes(3);
    });
    
    it('should apply position-aware blending with reranker', async () => {
      const mockFtsResults = [
        createMockResult('doc1', 10, 'snippet1'),
        createMockResult('doc2', 8, 'snippet2'),
      ];
      const store = createMockStore(mockFtsResults, []);
      
      const reranker = {
        rerank: vi.fn().mockResolvedValue({
          results: [
            { file: 'doc2', score: 0.9, index: 1 },
            { file: 'doc1', score: 0.7, index: 0 },
          ],
        }),
      };
      
      const results = await hybridSearch(
        store,
        { query: 'test query', useReranking: true },
        { reranker }
      );
      
      expect(reranker.rerank).toHaveBeenCalled();
      expect(results.length).toBeGreaterThan(0);
    });
    
    it('should cache reranking results', async () => {
      const mockFtsResults = [createMockResult('doc1', 10, 'snippet1')];
      const store = createMockStore(mockFtsResults, []);
      
      const reranker = {
        rerank: vi.fn().mockResolvedValue({
          results: [{ file: 'doc1', score: 0.9, index: 0 }],
        }),
      };
      
      await hybridSearch(
        store,
        { query: 'test query', useReranking: true },
        { reranker }
      );
      
      expect(store.setCachedResult).toHaveBeenCalled();
    });
    
    it('should filter by minScore', async () => {
      const mockFtsResults = [
        createMockResult('doc1', 10),
        createMockResult('doc2', 8),
        createMockResult('doc3', 6),
      ];
      const store = createMockStore(mockFtsResults, []);
      
      const results = await hybridSearch(
        store,
        { query: 'test query', minScore: 0.015 },
        {}
      );
      
      expect(results.every(r => r.score >= 0.015)).toBe(true);
    });
    
    it('should limit results to specified limit', async () => {
      const mockFtsResults = Array.from({ length: 50 }, (_, i) =>
        createMockResult(`doc${i}`, 50 - i)
      );
      const store = createMockStore(mockFtsResults, []);
      
      const results = await hybridSearch(
        store,
        { query: 'test query', limit: 5 },
        {}
      );
      
      expect(results.length).toBeLessThanOrEqual(5);
    });
    
    it('should format snippets in final results', async () => {
      const longSnippet = 'a'.repeat(1000);
      const mockFtsResults = [createMockResult('doc1', 10, longSnippet)];
      const store = createMockStore(mockFtsResults, []);
      
      const results = await hybridSearch(
        store,
        { query: 'test query' },
        {}
      );
      
      expect(results[0].snippet.length).toBeLessThanOrEqual(703);
      expect(results[0].snippet.endsWith('...')).toBe(true);
    });
    
    it('should use embedder for vector search', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const mockVecResults = [createMockResult('doc2', 0.9)];
      const store = createMockStore(mockFtsResults, mockVecResults);
      
      const embedder = {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
      };
      
      await hybridSearch(
        store,
        { query: 'test query' },
        { embedder }
      );
      
      expect(embedder.embed).toHaveBeenCalledWith('test query');
      expect(store.searchVecAsync).toHaveBeenCalled();
    });
    
    it('should handle embedder errors gracefully', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      
      const embedder = {
        embed: vi.fn().mockRejectedValue(new Error('Embedding failed')),
      };
      
      const results = await hybridSearch(
        store,
        { query: 'test query' },
        { embedder }
      );
      
      expect(results.length).toBeGreaterThan(0);
    });
    
    it('should handle expander errors gracefully', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      
      const expander = {
        expand: vi.fn().mockRejectedValue(new Error('Expansion failed')),
      };
      
      const results = await hybridSearch(
        store,
        { query: 'test query', useExpansion: true },
        { expander }
      );
      
      expect(results.length).toBeGreaterThan(0);
    });
    
    it('should handle reranker errors gracefully', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)];
      const store = createMockStore(mockFtsResults, []);
      
      const reranker = {
        rerank: vi.fn().mockRejectedValue(new Error('Reranking failed')),
      };
      
      const results = await hybridSearch(
        store,
        { query: 'test query', useReranking: true },
        { reranker }
      );
      
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
