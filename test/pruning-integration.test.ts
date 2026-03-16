import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStore } from '../src/store.js'
import {
  runPruningCycle,
  softDeleteContradictedEntities,
  softDeleteOrphanEntities,
  hardDeletePrunedEntities,
  DEFAULT_PRUNING_CONFIG,
  type PruningConfig,
} from '../src/pruning.js'
import type { Store } from '../src/types.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('Pruning Integration', () => {
  let store: Store
  let tmpDir: string
  let dbPath: string
  const PROJECT_HASH = 'test-pruning'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-pruning-test-'))
    dbPath = path.join(tmpDir, 'test.sqlite')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmpDir, { recursive: true })
  })

  function insertEntity(name: string, type: string = 'concept'): number {
    return store.insertOrUpdateEntity({
      name,
      type,
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    })
  }

  function insertEdge(sourceId: number, targetId: number): number {
    return store.insertEdge({
      sourceId,
      targetId,
      edgeType: 'related_to',
      projectHash: PROJECT_HASH,
    })
  }

  describe('softDeleteContradictedEntities', () => {
    it('should soft-delete entities contradicted beyond TTL', () => {
      const entityId = insertEntity('OldContradicted')
      store.markEntityContradicted(entityId, 999)

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET contradicted_at = datetime('now', '-60 days')
        WHERE id = ?
      `).run(entityId)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, contradicted_ttl_days: 30 }
      const pruned = softDeleteContradictedEntities(store, config)

      expect(pruned).toBe(1)
      const entity = store.getEntityById(entityId)
      expect(entity).not.toBeNull()
    })

    it('should NOT soft-delete recently contradicted entities', () => {
      const entityId = insertEntity('RecentContradicted')
      store.markEntityContradicted(entityId, 999)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, contradicted_ttl_days: 30 }
      const pruned = softDeleteContradictedEntities(store, config)

      expect(pruned).toBe(0)
    })

    it('should NOT soft-delete healthy entities', () => {
      insertEntity('HealthyEntity')

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, contradicted_ttl_days: 30 }
      const pruned = softDeleteContradictedEntities(store, config)

      expect(pruned).toBe(0)
    })
  })

  describe('softDeleteOrphanEntities', () => {
    it('should soft-delete orphan entities beyond TTL', () => {
      const orphanId = insertEntity('OldOrphan')

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET last_confirmed_at = datetime('now', '-120 days')
        WHERE id = ?
      `).run(orphanId)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, orphan_ttl_days: 90 }
      const pruned = softDeleteOrphanEntities(store, config)

      expect(pruned).toBe(1)
    })

    it('should NOT soft-delete orphan entities within TTL', () => {
      insertEntity('RecentOrphan')

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, orphan_ttl_days: 90 }
      const pruned = softDeleteOrphanEntities(store, config)

      expect(pruned).toBe(0)
    })

    it('should NOT soft-delete entities with edges', () => {
      const entityA = insertEntity('EntityA')
      const entityB = insertEntity('EntityB')
      insertEdge(entityA, entityB)

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET last_confirmed_at = datetime('now', '-120 days')
        WHERE id IN (?, ?)
      `).run(entityA, entityB)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, orphan_ttl_days: 90 }
      const pruned = softDeleteOrphanEntities(store, config)

      expect(pruned).toBe(0)
    })
  })

  describe('hardDeletePrunedEntities', () => {
    it('should hard-delete entities pruned beyond retention period', () => {
      const entityId = insertEntity('ToBeHardDeleted')

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET pruned_at = datetime('now', '-60 days')
        WHERE id = ?
      `).run(entityId)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, hard_delete_after_days: 30 }
      const deleted = hardDeletePrunedEntities(store, config)

      expect(deleted).toBe(1)
      const entity = store.getEntityById(entityId)
      expect(entity).toBeNull()
    })

    it('should NOT hard-delete recently pruned entities', () => {
      const entityId = insertEntity('RecentlyPruned')

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET pruned_at = datetime('now', '-5 days')
        WHERE id = ?
      `).run(entityId)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, hard_delete_after_days: 30 }
      const deleted = hardDeletePrunedEntities(store, config)

      expect(deleted).toBe(0)
      const entity = store.getEntityById(entityId)
      expect(entity).not.toBeNull()
    })

    it('should hard-delete entities without edges', () => {
      const entityA = insertEntity('EntityToDeleteA')
      const entityB = insertEntity('EntityToDeleteB')

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET pruned_at = datetime('now', '-60 days')
        WHERE id IN (?, ?)
      `).run(entityA, entityB)

      const config: PruningConfig = { ...DEFAULT_PRUNING_CONFIG, hard_delete_after_days: 30 }
      const deleted = hardDeletePrunedEntities(store, config)

      expect(deleted).toBe(2)
      expect(store.getEntityById(entityA)).toBeNull()
      expect(store.getEntityById(entityB)).toBeNull()
    })
  })

  describe('runPruningCycle', () => {
    it('should prune both contradicted and orphan entities', () => {
      const contradictedId = insertEntity('Contradicted')
      store.markEntityContradicted(contradictedId, 999)

      const orphanId = insertEntity('Orphan')

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET contradicted_at = datetime('now', '-60 days')
        WHERE id = ?
      `).run(contradictedId)

      db.prepare(`
        UPDATE memory_entities 
        SET last_confirmed_at = datetime('now', '-120 days')
        WHERE id = ?
      `).run(orphanId)

      const config: PruningConfig = {
        ...DEFAULT_PRUNING_CONFIG,
        contradicted_ttl_days: 30,
        orphan_ttl_days: 90,
      }

      const result = runPruningCycle(store, config)

      expect(result.contradictedPruned).toBe(1)
      expect(result.orphansPruned).toBe(1)
      expect(result.hardDeleted).toBe(0)
    })

    it('should leave healthy entities untouched', () => {
      const healthyId = insertEntity('Healthy')
      const connectedA = insertEntity('ConnectedA')
      const connectedB = insertEntity('ConnectedB')
      insertEdge(connectedA, connectedB)

      const config: PruningConfig = {
        ...DEFAULT_PRUNING_CONFIG,
        contradicted_ttl_days: 30,
        orphan_ttl_days: 90,
      }

      const result = runPruningCycle(store, config)

      expect(result.contradictedPruned).toBe(0)
      expect(result.orphansPruned).toBe(0)

      const healthy = store.getEntityById(healthyId)
      expect(healthy).not.toBeNull()
      const cA = store.getEntityById(connectedA)
      expect(cA).not.toBeNull()
    })
  })

  describe('batch limiting', () => {
    it('should respect batch_size limit', () => {
      for (let i = 0; i < 200; i++) {
        const id = insertEntity(`Orphan${i}`)
        const db = store.getDb()
        db.prepare(`
          UPDATE memory_entities 
          SET last_confirmed_at = datetime('now', '-120 days')
          WHERE id = ?
        `).run(id)
      }

      const config: PruningConfig = {
        ...DEFAULT_PRUNING_CONFIG,
        orphan_ttl_days: 90,
        batch_size: 50,
      }

      const result = runPruningCycle(store, config)

      expect(result.orphansPruned).toBe(50)
    })
  })

  describe('project hash filtering', () => {
    it('should only prune entities from specified project', () => {
      const otherProject = 'other-project'

      const entityInProject = insertEntity('InProject')
      const entityInOther = store.insertOrUpdateEntity({
        name: 'InOther',
        type: 'concept',
        projectHash: otherProject,
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const db = store.getDb()
      db.prepare(`
        UPDATE memory_entities 
        SET last_confirmed_at = datetime('now', '-120 days')
        WHERE id IN (?, ?)
      `).run(entityInProject, entityInOther)

      const config: PruningConfig = {
        ...DEFAULT_PRUNING_CONFIG,
        orphan_ttl_days: 90,
      }

      const result = runPruningCycle(store, config, PROJECT_HASH)

      expect(result.orphansPruned).toBe(1)

      const otherEntity = store.getEntityById(entityInOther)
      expect(otherEntity).not.toBeNull()
    })
  })
})
