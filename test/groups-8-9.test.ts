import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  rrfFuse,
  positionAwareBlend,
  hybridSearch,
  parseSearchConfig,
  applyCentralityBoost,
  applySupersedeDemotion,
} from '../src/search.js'
import { findCycles } from '../src/graph.js'
import { createStore } from '../src/store.js'
import { DEFAULT_SEARCH_CONFIG } from '../src/types.js'
import type { SearchResult, Store, SearchConfig } from '../src/types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function createMockResult(
  id: string,
  score: number,
  opts: { centrality?: number; supersededBy?: number | null; snippet?: string } = {}
): SearchResult {
  return {
    id,
    path: `path/${id}`,
    collection: 'test',
    title: `Title ${id}`,
    snippet: opts.snippet ?? 'test snippet',
    score,
    startLine: 1,
    endLine: 10,
    docid: id.substring(0, 6),
    centrality: opts.centrality,
    supersededBy: opts.supersededBy,
  }
}

function createMockStore(ftsResults: SearchResult[], vecResults: SearchResult[]): Store {
  return {
    searchFTS: vi.fn().mockReturnValue(ftsResults),
    searchVec: vi.fn().mockReturnValue(vecResults),
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
    insertFileEdge: vi.fn(),
    deleteFileEdges: vi.fn(),
    getFileEdges: vi.fn().mockReturnValue([]),
    updateCentralityScores: vi.fn(),
    updateClusterIds: vi.fn(),
    getEdgeSetHash: vi.fn().mockReturnValue(null),
    setEdgeSetHash: vi.fn(),
    supersedeDocument: vi.fn(),
    insertTags: vi.fn(),
    getDocumentTags: vi.fn().mockReturnValue([]),
    listAllTags: vi.fn().mockReturnValue([]),
    getFileDependencies: vi.fn().mockReturnValue([]),
    getFileDependents: vi.fn().mockReturnValue([]),
    getDocumentCentrality: vi.fn().mockReturnValue(null),
    getClusterMembers: vi.fn().mockReturnValue([]),
    getGraphStats: vi.fn().mockReturnValue({ nodeCount: 0, edgeCount: 0, clusterCount: 0, topCentrality: [] }),
  } as unknown as Store
}

describe('Group 8: Search Tuning Config', () => {
  describe('parseSearchConfig', () => {
    it('should return default config when no partial provided', () => {
      const config = parseSearchConfig()
      expect(config).toEqual(DEFAULT_SEARCH_CONFIG)
    })

    it('should return default config when empty partial provided', () => {
      const config = parseSearchConfig({})
      expect(config).toEqual(DEFAULT_SEARCH_CONFIG)
    })

    it('should override rrf_k', () => {
      const config = parseSearchConfig({ rrf_k: 30 })
      expect(config.rrf_k).toBe(30)
      expect(config.top_k).toBe(DEFAULT_SEARCH_CONFIG.top_k)
    })

    it('should override top_k', () => {
      const config = parseSearchConfig({ top_k: 50 })
      expect(config.top_k).toBe(50)
    })

    it('should override centrality_weight', () => {
      const config = parseSearchConfig({ centrality_weight: 0.2 })
      expect(config.centrality_weight).toBe(0.2)
    })

    it('should override supersede_demotion', () => {
      const config = parseSearchConfig({ supersede_demotion: 0.5 })
      expect(config.supersede_demotion).toBe(0.5)
    })

    it('should reject negative rrf_k and use default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const config = parseSearchConfig({ rrf_k: -10 })
      expect(config.rrf_k).toBe(DEFAULT_SEARCH_CONFIG.rrf_k)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid rrf_k'))
      warnSpy.mockRestore()
    })

    it('should reject negative top_k and use default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const config = parseSearchConfig({ top_k: -5 })
      expect(config.top_k).toBe(DEFAULT_SEARCH_CONFIG.top_k)
      warnSpy.mockRestore()
    })

    it('should reject negative centrality_weight and use default', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const config = parseSearchConfig({ centrality_weight: -0.1 })
      expect(config.centrality_weight).toBe(DEFAULT_SEARCH_CONFIG.centrality_weight)
      warnSpy.mockRestore()
    })

    it('should warn if blending weights do not sum to 1.0', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      parseSearchConfig({
        blending: {
          top3: { rrf: 0.5, rerank: 0.3 },
          mid: { rrf: 0.6, rerank: 0.4 },
          tail: { rrf: 0.4, rerank: 0.6 },
        },
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sum to 0.80'))
      warnSpy.mockRestore()
    })

    it('should override blending weights', () => {
      const config = parseSearchConfig({
        blending: {
          top3: { rrf: 0.8, rerank: 0.2 },
          mid: { rrf: 0.5, rerank: 0.5 },
          tail: { rrf: 0.3, rerank: 0.7 },
        },
      })
      expect(config.blending.top3).toEqual({ rrf: 0.8, rerank: 0.2 })
      expect(config.blending.mid).toEqual({ rrf: 0.5, rerank: 0.5 })
      expect(config.blending.tail).toEqual({ rrf: 0.3, rerank: 0.7 })
    })

    it('should override expansion settings', () => {
      const config = parseSearchConfig({
        expansion: { enabled: false, weight: 0.5 },
      })
      expect(config.expansion.enabled).toBe(false)
      expect(config.expansion.weight).toBe(0.5)
    })

    it('should override reranking settings', () => {
      const config = parseSearchConfig({
        reranking: { enabled: false },
      })
      expect(config.reranking.enabled).toBe(false)
    })
  })

  describe('applyCentralityBoost', () => {
    it('should boost results with centrality > 0', () => {
      const results = [
        createMockResult('doc1', 1.0, { centrality: 0.5 }),
        createMockResult('doc2', 1.0, { centrality: 0 }),
        createMockResult('doc3', 1.0),
      ]
      
      const boosted = applyCentralityBoost(results, 0.1)
      
      expect(boosted[0].score).toBeCloseTo(1.0 * (1 + 0.1 * 0.5), 5)
      expect(boosted[1].score).toBe(1.0)
      expect(boosted[2].score).toBe(1.0)
    })

    it('should apply correct formula: final_score = rrf_score * (1 + centrality_weight * centrality)', () => {
      const results = [createMockResult('doc1', 0.8, { centrality: 0.3 })]
      const boosted = applyCentralityBoost(results, 0.1)
      
      const expected = 0.8 * (1 + 0.1 * 0.3)
      expect(boosted[0].score).toBeCloseTo(expected, 5)
    })

    it('should not modify results without centrality', () => {
      const results = [createMockResult('doc1', 0.5)]
      const boosted = applyCentralityBoost(results, 0.1)
      expect(boosted[0].score).toBe(0.5)
    })
  })

  describe('applySupersedeDemotion', () => {
    it('should demote results with supersededBy set', () => {
      const results = [
        createMockResult('doc1', 1.0, { supersededBy: 123 }),
        createMockResult('doc2', 1.0, { supersededBy: null }),
        createMockResult('doc3', 1.0),
      ]
      
      const demoted = applySupersedeDemotion(results, 0.3)
      
      expect(demoted[0].score).toBeCloseTo(0.3, 5)
      expect(demoted[1].score).toBe(1.0)
      expect(demoted[2].score).toBe(1.0)
    })

    it('should apply correct formula: final_score *= supersede_demotion', () => {
      const results = [createMockResult('doc1', 0.8, { supersededBy: 1 })]
      const demoted = applySupersedeDemotion(results, 0.3)
      
      expect(demoted[0].score).toBeCloseTo(0.8 * 0.3, 5)
    })
  })

  describe('positionAwareBlend with custom config', () => {
    it('should use custom blending weights from config', () => {
      const rrfResults = [
        createMockResult('doc1', 0.8),
        createMockResult('doc2', 0.7),
        createMockResult('doc3', 0.6),
      ]
      const rerankScores = new Map([
        ['doc1', 0.4],
        ['doc2', 0.5],
        ['doc3', 0.6],
      ])
      
      const customBlending = {
        top3: { rrf: 0.9, rerank: 0.1 },
        mid: { rrf: 0.5, rerank: 0.5 },
        tail: { rrf: 0.2, rerank: 0.8 },
      }
      
      const blended = positionAwareBlend(rrfResults, rerankScores, customBlending)
      
      expect(blended[0].score).toBeCloseTo(0.9 * 0.8 + 0.1 * 0.4, 5)
    })

    it('should use default blending when config not provided', () => {
      const rrfResults = [createMockResult('doc1', 0.8)]
      const rerankScores = new Map([['doc1', 0.4]])
      
      const blended = positionAwareBlend(rrfResults, rerankScores)
      
      expect(blended[0].score).toBeCloseTo(0.75 * 0.8 + 0.25 * 0.4, 5)
    })
  })

  describe('rrfFuse with custom k', () => {
    it('should use custom rrf_k value', () => {
      const set1 = [createMockResult('doc1', 10)]
      
      const mergedK60 = rrfFuse([set1], 60)
      const mergedK30 = rrfFuse([set1], 30)
      
      expect(mergedK30[0].score).toBeGreaterThan(mergedK60[0].score)
      expect(mergedK60[0].score).toBeCloseTo(1 / 61, 5)
      expect(mergedK30[0].score).toBeCloseTo(1 / 31, 5)
    })
  })

  describe('hybridSearch with SearchConfig', () => {
    it('should use custom rrf_k from config', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)]
      const store = createMockStore(mockFtsResults, [])
      
      const customConfig: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        rrf_k: 30,
      }
      
      const results = await hybridSearch(
        store,
        { query: 'test', searchConfig: customConfig },
        {}
      )
      
      expect(results.length).toBeGreaterThan(0)
    })

    it('should apply centrality boost in hybrid search', async () => {
      const mockFtsResults = [
        createMockResult('doc1', 10, { centrality: 0.5 }),
        createMockResult('doc2', 10, { centrality: 0 }),
      ]
      const store = createMockStore(mockFtsResults, [])
      
      const customConfig: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        centrality_weight: 0.2,
      }
      
      const results = await hybridSearch(
        store,
        { query: 'test', searchConfig: customConfig },
        {}
      )
      
      const doc1 = results.find(r => r.id === 'doc1')
      const doc2 = results.find(r => r.id === 'doc2')
      expect(doc1!.score).toBeGreaterThan(doc2!.score)
    })

    it('should apply supersede demotion in hybrid search', async () => {
      const mockFtsResults = [
        createMockResult('doc1', 10, { supersededBy: 123 }),
        createMockResult('doc2', 10),
      ]
      const store = createMockStore(mockFtsResults, [])
      
      const customConfig: SearchConfig = {
        ...DEFAULT_SEARCH_CONFIG,
        supersede_demotion: 0.3,
      }
      
      const results = await hybridSearch(
        store,
        { query: 'test', searchConfig: customConfig },
        {}
      )
      
      const doc1 = results.find(r => r.id === 'doc1')
      const doc2 = results.find(r => r.id === 'doc2')
      expect(doc2!.score).toBeGreaterThan(doc1!.score)
    })

    it('should use default config when searchConfig not provided', async () => {
      const mockFtsResults = [createMockResult('doc1', 10)]
      const store = createMockStore(mockFtsResults, [])
      
      const results = await hybridSearch(
        store,
        { query: 'test' },
        {}
      )
      
      expect(results.length).toBeGreaterThan(0)
    })
  })
})

describe('Group 9: Focus & Graph Stats', () => {
  describe('findCycles', () => {
    it('should find simple cycle A -> B -> A', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(1)
      expect(cycles[0]).toEqual(['A', 'B'])
    })

    it('should find triangle cycle A -> B -> C -> A', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'A' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(1)
      expect(cycles[0].length).toBe(3)
    })

    it('should find multiple cycles', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'A' },
        { source: 'C', target: 'D' },
        { source: 'D', target: 'C' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(2)
    })

    it('should respect maxLength limit', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'D' },
        { source: 'D', target: 'E' },
        { source: 'E', target: 'F' },
        { source: 'F', target: 'A' },
      ]
      
      const cyclesMax5 = findCycles(edges, 5)
      const cyclesMax6 = findCycles(edges, 6)
      
      expect(cyclesMax5.length).toBe(0)
      expect(cyclesMax6.length).toBe(1)
    })

    it('should return empty array for acyclic graph', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'D' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(0)
    })

    it('should return empty array for empty graph', () => {
      const cycles = findCycles([], 5)
      expect(cycles.length).toBe(0)
    })

    it('should handle self-loops', () => {
      const edges = [{ source: 'A', target: 'A' }]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(0)
    })

    it('should normalize cycles to start with smallest node', () => {
      const edges = [
        { source: 'C', target: 'A' },
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles[0][0]).toBe('A')
    })

    it('should deduplicate equivalent cycles', () => {
      const edges = [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
        { source: 'C', target: 'A' },
      ]
      const cycles = findCycles(edges, 5)
      
      expect(cycles.length).toBe(1)
    })
  })

  describe('Store focus/graph-stats methods', () => {
    let tmpDir: string
    let dbPath: string
    let store: Store

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-focus-test-'))
      dbPath = path.join(tmpDir, 'test.db')
      store = createStore(dbPath)
    })

    afterEach(() => {
      store.close()
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('should get file dependencies', () => {
      store.insertFileEdge('/src/a.ts', '/src/b.ts', 'test-project')
      store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project')

      const deps = store.getFileDependencies('/src/a.ts', 'test-project')
      
      expect(deps).toHaveLength(2)
      expect(deps).toContain('/src/b.ts')
      expect(deps).toContain('/src/c.ts')
    })

    it('should get file dependents', () => {
      store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project')
      store.insertFileEdge('/src/b.ts', '/src/c.ts', 'test-project')

      const dependents = store.getFileDependents('/src/c.ts', 'test-project')
      
      expect(dependents).toHaveLength(2)
      expect(dependents).toContain('/src/a.ts')
      expect(dependents).toContain('/src/b.ts')
    })

    it('should return empty array for unconnected file', () => {
      const deps = store.getFileDependencies('/src/standalone.ts', 'test-project')
      const dependents = store.getFileDependents('/src/standalone.ts', 'test-project')
      
      expect(deps).toHaveLength(0)
      expect(dependents).toHaveLength(0)
    })

    it('should get document centrality', () => {
      const hash = 'abc123'
      store.insertContent(hash, 'test content')
      store.insertDocument({
        collection: 'codebase',
        path: '/src/test.ts',
        title: 'test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      
      store.updateCentralityScores('test-project', new Map([['/src/test.ts', 0.5]]))
      store.updateClusterIds('test-project', new Map([['/src/test.ts', 1]]))
      
      const info = store.getDocumentCentrality('/src/test.ts')
      
      expect(info).not.toBeNull()
      expect(info!.centrality).toBeCloseTo(0.5, 5)
      expect(info!.clusterId).toBe(1)
    })

    it('should return null for non-existent document', () => {
      const info = store.getDocumentCentrality('/src/nonexistent.ts')
      expect(info).toBeNull()
    })

    it('should get cluster members', () => {
      const hash1 = 'abc123'
      const hash2 = 'def456'
      store.insertContent(hash1, 'test content 1')
      store.insertContent(hash2, 'test content 2')
      store.insertDocument({
        collection: 'codebase',
        path: '/src/a.ts',
        title: 'a',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      store.insertDocument({
        collection: 'codebase',
        path: '/src/b.ts',
        title: 'b',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      
      store.updateClusterIds('test-project', new Map([
        ['/src/a.ts', 1],
        ['/src/b.ts', 1],
      ]))
      
      const members = store.getClusterMembers(1, 'test-project')
      
      expect(members).toHaveLength(2)
      expect(members).toContain('/src/a.ts')
      expect(members).toContain('/src/b.ts')
    })

    it('should get graph stats', () => {
      store.insertFileEdge('/src/a.ts', '/src/b.ts', 'test-project')
      store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project')
      store.insertFileEdge('/src/b.ts', '/src/c.ts', 'test-project')
      
      const hash = 'abc123'
      store.insertContent(hash, 'test content')
      store.insertDocument({
        collection: 'codebase',
        path: '/src/a.ts',
        title: 'a',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      store.updateCentralityScores('test-project', new Map([['/src/a.ts', 0.8]]))
      store.updateClusterIds('test-project', new Map([['/src/a.ts', 1]]))
      
      const stats = store.getGraphStats('test-project')
      
      expect(stats.edgeCount).toBe(3)
      expect(stats.nodeCount).toBeGreaterThan(0)
      expect(stats.clusterCount).toBe(1)
      expect(stats.topCentrality.length).toBeGreaterThan(0)
      expect(stats.topCentrality[0].path).toBe('/src/a.ts')
      expect(stats.topCentrality[0].centrality).toBeCloseTo(0.8, 5)
    })

    it('should return empty stats for empty graph', () => {
      const stats = store.getGraphStats('empty-project')
      
      expect(stats.nodeCount).toBe(0)
      expect(stats.edgeCount).toBe(0)
      expect(stats.clusterCount).toBe(0)
      expect(stats.topCentrality).toHaveLength(0)
    })
  })

  describe('Store search methods return centrality and supersededBy', () => {
    let tmpDir: string
    let dbPath: string
    let store: Store

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-search-fields-test-'))
      dbPath = path.join(tmpDir, 'test.db')
      store = createStore(dbPath)
    })

    afterEach(() => {
      store.close()
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('should return centrality in FTS results', () => {
      const hash = 'abc123'
      store.insertContent(hash, 'test content with searchable keywords')
      store.insertDocument({
        collection: 'codebase',
        path: '/src/test.ts',
        title: 'test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      store.updateCentralityScores('test-project', new Map([['/src/test.ts', 0.75]]))
      
      const results = store.searchFTS('searchable', { projectHash: 'test-project' })
      
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].centrality).toBeCloseTo(0.75, 5)
    })

    it('should return supersededBy in FTS results', () => {
      const hash = 'abc123'
      store.insertContent(hash, 'test content with searchable keywords')
      const docId = store.insertDocument({
        collection: 'codebase',
        path: '/src/test.ts',
        title: 'test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test-project',
      })
      store.supersedeDocument(docId, 999)
      
      const results = store.searchFTS('searchable', { projectHash: 'test-project' })
      
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].supersededBy).toBe(999)
    })
  })
})
