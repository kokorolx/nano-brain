import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  computeCategoryWeights,
  updatePreferenceWeights,
  PreferenceConfig,
  DEFAULT_PREFERENCE_CONFIG,
} from '../src/preference-model.js'
import type { Store } from '../src/types.js'

function createMockStore(overrides: Partial<Store> = {}): Store {
  return {
    getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 0, expandCount: 0 }),
    getDb: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    }),
    findDocument: vi.fn().mockReturnValue(null),
    getDocumentTags: vi.fn().mockReturnValue([]),
    getWorkspaceProfile: vi.fn().mockReturnValue(null),
    saveWorkspaceProfile: vi.fn(),
    ...overrides,
  } as unknown as Store
}

describe('preference-model', () => {
  let mockStore: Store
  let config: PreferenceConfig
  const workspaceHash = 'test-workspace'

  beforeEach(() => {
    mockStore = createMockStore()
    config = { ...DEFAULT_PREFERENCE_CONFIG }
  })

  describe('computeCategoryWeights', () => {
    it('returns empty object when queryCount < min_queries (cold start)', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 5, expandCount: 2 }),
      })
      config.min_queries = 20

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      expect(result).toEqual({})
    })

    it('returns empty object when queryCount equals min_queries - 1', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 19, expandCount: 5 }),
      })
      config.min_queries = 20

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      expect(result).toEqual({})
    })

    it('computes weights when queryCount >= min_queries', () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            {
              result_docids: JSON.stringify(['doc1', 'doc2']),
              expanded_indices: JSON.stringify([0]),
            },
          ]),
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 25, expandCount: 10 }),
        getDb: vi.fn().mockReturnValue(mockDb),
        findDocument: vi.fn().mockImplementation((docid: string) => {
          if (docid === 'doc1') return { id: 1 }
          if (docid === 'doc2') return { id: 2 }
          return null
        }),
        getDocumentTags: vi.fn().mockImplementation((id: number) => {
          if (id === 1) return ['auto:architecture', 'llm:pattern']
          if (id === 2) return ['auto:debugging']
          return []
        }),
      })

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      expect(mockStore.getTelemetryStats).toHaveBeenCalledWith(workspaceHash)
    })

    it('clamps weights to weight_min', () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            {
              result_docids: JSON.stringify(['doc1']),
              expanded_indices: JSON.stringify([]),
            },
          ]),
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 25, expandCount: 10 }),
        getDb: vi.fn().mockReturnValue(mockDb),
        findDocument: vi.fn().mockReturnValue({ id: 1 }),
        getDocumentTags: vi.fn().mockReturnValue(['auto:test-category']),
      })

      config.weight_min = 0.5
      config.weight_max = 2.0
      config.baseline_expand_rate = 0.1

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      for (const weight of Object.values(result)) {
        expect(weight).toBeGreaterThanOrEqual(config.weight_min)
      }
    })

    it('clamps weights to weight_max', () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            {
              result_docids: JSON.stringify(['doc1']),
              expanded_indices: JSON.stringify([0]),
            },
          ]),
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 25, expandCount: 10 }),
        getDb: vi.fn().mockReturnValue(mockDb),
        findDocument: vi.fn().mockReturnValue({ id: 1 }),
        getDocumentTags: vi.fn().mockReturnValue(['auto:high-expand-category']),
      })

      config.weight_min = 0.5
      config.weight_max = 2.0
      config.baseline_expand_rate = 0.01

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      for (const weight of Object.values(result)) {
        expect(weight).toBeLessThanOrEqual(config.weight_max)
      }
    })

    it('handles empty telemetry data', () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([]),
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 25, expandCount: 10 }),
        getDb: vi.fn().mockReturnValue(mockDb),
      })

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      expect(result).toEqual({})
    })

    it('handles malformed JSON in telemetry rows', () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([
            {
              result_docids: 'not valid json',
              expanded_indices: '[0]',
            },
            {
              result_docids: '["doc1"]',
              expanded_indices: 'not valid json',
            },
          ]),
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 25, expandCount: 10 }),
        getDb: vi.fn().mockReturnValue(mockDb),
      })

      const result = computeCategoryWeights(mockStore, workspaceHash, config)
      expect(result).toEqual({})
    })
  })

  describe('updatePreferenceWeights', () => {
    it('saves weights to workspace profile', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 5, expandCount: 2 }),
        getWorkspaceProfile: vi.fn().mockReturnValue(null),
        saveWorkspaceProfile: vi.fn(),
      })

      updatePreferenceWeights(mockStore, workspaceHash, config)
      expect(mockStore.saveWorkspaceProfile).toHaveBeenCalled()
    })

    it('preserves existing profile data when updating', () => {
      const existingProfile = {
        profile_data: JSON.stringify({
          topTopics: [{ topic: 'redis', count: 5 }],
          topCollections: [{ collection: 'sessions', count: 10 }],
          queryCount: 100,
          expandCount: 20,
          expandRate: 0.2,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        }),
      }

      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 5, expandCount: 2 }),
        getWorkspaceProfile: vi.fn().mockReturnValue(existingProfile),
        saveWorkspaceProfile: vi.fn(),
      })

      updatePreferenceWeights(mockStore, workspaceHash, config)

      const saveCall = (mockStore.saveWorkspaceProfile as ReturnType<typeof vi.fn>).mock.calls[0]
      const savedData = JSON.parse(saveCall[1])
      expect(savedData.topTopics).toEqual([{ topic: 'redis', count: 5 }])
      expect(savedData.categoryWeights).toBeDefined()
      expect(savedData.lastCategoryUpdate).toBeDefined()
    })

    it('creates new profile when none exists', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 5, expandCount: 2 }),
        getWorkspaceProfile: vi.fn().mockReturnValue(null),
        saveWorkspaceProfile: vi.fn(),
      })

      updatePreferenceWeights(mockStore, workspaceHash, config)

      const saveCall = (mockStore.saveWorkspaceProfile as ReturnType<typeof vi.fn>).mock.calls[0]
      const savedData = JSON.parse(saveCall[1])
      expect(savedData.topTopics).toEqual([])
      expect(savedData.topCollections).toEqual([])
      expect(savedData.queryCount).toBe(0)
      expect(savedData.categoryWeights).toBeDefined()
    })

    it('handles errors gracefully', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockImplementation(() => {
          throw new Error('Database error')
        }),
      })

      expect(() => updatePreferenceWeights(mockStore, workspaceHash, config)).not.toThrow()
    })

    it('includes lastCategoryUpdate timestamp', () => {
      mockStore = createMockStore({
        getTelemetryStats: vi.fn().mockReturnValue({ queryCount: 5, expandCount: 2 }),
        getWorkspaceProfile: vi.fn().mockReturnValue(null),
        saveWorkspaceProfile: vi.fn(),
      })

      const before = new Date().toISOString()
      updatePreferenceWeights(mockStore, workspaceHash, config)
      const after = new Date().toISOString()

      const saveCall = (mockStore.saveWorkspaceProfile as ReturnType<typeof vi.fn>).mock.calls[0]
      const savedData = JSON.parse(saveCall[1])
      expect(savedData.lastCategoryUpdate).toBeDefined()
      expect(savedData.lastCategoryUpdate >= before).toBe(true)
      expect(savedData.lastCategoryUpdate <= after).toBe(true)
    })
  })
})
