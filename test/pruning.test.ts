import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  softDeleteContradictedEntities,
  softDeleteOrphanEntities,
  hardDeletePrunedEntities,
  runPruningCycle,
  PruningConfig,
  DEFAULT_PRUNING_CONFIG,
} from '../src/pruning.js'
import type { Store } from '../src/types.js'

function createMockStore(overrides: Partial<Store> = {}): Store {
  return {
    getContradictedEntitiesForPruning: vi.fn().mockReturnValue([]),
    getOrphanEntitiesForPruning: vi.fn().mockReturnValue([]),
    getPrunedEntitiesForHardDelete: vi.fn().mockReturnValue([]),
    softDeleteEntities: vi.fn(),
    hardDeleteEntities: vi.fn(),
    ...overrides,
  } as unknown as Store
}

describe('pruning', () => {
  let mockStore: Store
  let config: PruningConfig

  beforeEach(() => {
    mockStore = createMockStore()
    config = { ...DEFAULT_PRUNING_CONFIG }
  })

  describe('softDeleteContradictedEntities', () => {
    it('returns 0 when no contradicted entities found', () => {
      const result = softDeleteContradictedEntities(mockStore, config)
      expect(result).toBe(0)
      expect(mockStore.getContradictedEntitiesForPruning).toHaveBeenCalledWith(
        config.contradicted_ttl_days,
        config.batch_size,
        undefined
      )
      expect(mockStore.softDeleteEntities).not.toHaveBeenCalled()
    })

    it('soft deletes contradicted entities and returns count', () => {
      const entityIds = [1, 2, 3]
      mockStore = createMockStore({
        getContradictedEntitiesForPruning: vi.fn().mockReturnValue(entityIds),
        softDeleteEntities: vi.fn(),
      })

      const result = softDeleteContradictedEntities(mockStore, config)
      expect(result).toBe(3)
      expect(mockStore.softDeleteEntities).toHaveBeenCalledWith(entityIds)
    })

    it('passes projectHash when provided', () => {
      const projectHash = 'test-project'
      softDeleteContradictedEntities(mockStore, config, projectHash)
      expect(mockStore.getContradictedEntitiesForPruning).toHaveBeenCalledWith(
        config.contradicted_ttl_days,
        config.batch_size,
        projectHash
      )
    })

    it('respects batch_size from config', () => {
      config.batch_size = 50
      softDeleteContradictedEntities(mockStore, config)
      expect(mockStore.getContradictedEntitiesForPruning).toHaveBeenCalledWith(
        config.contradicted_ttl_days,
        50,
        undefined
      )
    })
  })

  describe('softDeleteOrphanEntities', () => {
    it('returns 0 when no orphan entities found', () => {
      const result = softDeleteOrphanEntities(mockStore, config)
      expect(result).toBe(0)
      expect(mockStore.getOrphanEntitiesForPruning).toHaveBeenCalledWith(
        config.orphan_ttl_days,
        config.batch_size,
        undefined
      )
      expect(mockStore.softDeleteEntities).not.toHaveBeenCalled()
    })

    it('soft deletes orphan entities and returns count', () => {
      const entityIds = [4, 5, 6, 7]
      mockStore = createMockStore({
        getOrphanEntitiesForPruning: vi.fn().mockReturnValue(entityIds),
        softDeleteEntities: vi.fn(),
      })

      const result = softDeleteOrphanEntities(mockStore, config)
      expect(result).toBe(4)
      expect(mockStore.softDeleteEntities).toHaveBeenCalledWith(entityIds)
    })

    it('passes projectHash when provided', () => {
      const projectHash = 'test-project'
      softDeleteOrphanEntities(mockStore, config, projectHash)
      expect(mockStore.getOrphanEntitiesForPruning).toHaveBeenCalledWith(
        config.orphan_ttl_days,
        config.batch_size,
        projectHash
      )
    })
  })

  describe('hardDeletePrunedEntities', () => {
    it('returns 0 when no pruned entities found', () => {
      const result = hardDeletePrunedEntities(mockStore, config)
      expect(result).toBe(0)
      expect(mockStore.getPrunedEntitiesForHardDelete).toHaveBeenCalledWith(
        config.hard_delete_after_days,
        config.batch_size,
        undefined
      )
      expect(mockStore.hardDeleteEntities).not.toHaveBeenCalled()
    })

    it('hard deletes pruned entities and returns count', () => {
      const entityIds = [10, 11]
      mockStore = createMockStore({
        getPrunedEntitiesForHardDelete: vi.fn().mockReturnValue(entityIds),
        hardDeleteEntities: vi.fn(),
      })

      const result = hardDeletePrunedEntities(mockStore, config)
      expect(result).toBe(2)
      expect(mockStore.hardDeleteEntities).toHaveBeenCalledWith(entityIds)
    })

    it('passes projectHash when provided', () => {
      const projectHash = 'test-project'
      hardDeletePrunedEntities(mockStore, config, projectHash)
      expect(mockStore.getPrunedEntitiesForHardDelete).toHaveBeenCalledWith(
        config.hard_delete_after_days,
        config.batch_size,
        projectHash
      )
    })
  })

  describe('runPruningCycle', () => {
    it('calls all pruning functions and returns combined result', () => {
      mockStore = createMockStore({
        getContradictedEntitiesForPruning: vi.fn().mockReturnValue([1, 2]),
        getOrphanEntitiesForPruning: vi.fn().mockReturnValue([3, 4, 5]),
        getPrunedEntitiesForHardDelete: vi.fn().mockReturnValue([]),
        softDeleteEntities: vi.fn(),
        hardDeleteEntities: vi.fn(),
      })

      const result = runPruningCycle(mockStore, config)
      expect(result.contradictedPruned).toBe(2)
      expect(result.orphansPruned).toBe(3)
      expect(result.hardDeleted).toBe(0)
    })

    it('returns zeros when nothing to prune', () => {
      const result = runPruningCycle(mockStore, config)
      expect(result.contradictedPruned).toBe(0)
      expect(result.orphansPruned).toBe(0)
      expect(result.hardDeleted).toBe(0)
    })

    it('passes projectHash to all functions', () => {
      const projectHash = 'test-project'
      runPruningCycle(mockStore, config, projectHash)
      expect(mockStore.getContradictedEntitiesForPruning).toHaveBeenCalledWith(
        config.contradicted_ttl_days,
        config.batch_size,
        projectHash
      )
      expect(mockStore.getOrphanEntitiesForPruning).toHaveBeenCalledWith(
        config.orphan_ttl_days,
        config.batch_size,
        projectHash
      )
    })

    it('respects batch_size limit', () => {
      config.batch_size = 10
      runPruningCycle(mockStore, config)
      expect(mockStore.getContradictedEntitiesForPruning).toHaveBeenCalledWith(
        expect.any(Number),
        10,
        undefined
      )
      expect(mockStore.getOrphanEntitiesForPruning).toHaveBeenCalledWith(
        expect.any(Number),
        10,
        undefined
      )
    })
  })
})
