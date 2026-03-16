import type { Store } from './types.js'
import { log } from './logger.js'

export interface PruningConfig {
  enabled: boolean
  interval_ms: number
  contradicted_ttl_days: number
  orphan_ttl_days: number
  batch_size: number
  hard_delete_after_days: number
}

export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  enabled: true,
  interval_ms: 21600000,
  contradicted_ttl_days: 30,
  orphan_ttl_days: 90,
  batch_size: 100,
  hard_delete_after_days: 30,
}

export interface PruningResult {
  contradictedPruned: number
  orphansPruned: number
  hardDeleted: number
}

export function parsePruningConfig(raw?: Partial<PruningConfig>): PruningConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_PRUNING_CONFIG.enabled,
    interval_ms: raw?.interval_ms ?? DEFAULT_PRUNING_CONFIG.interval_ms,
    contradicted_ttl_days: raw?.contradicted_ttl_days ?? DEFAULT_PRUNING_CONFIG.contradicted_ttl_days,
    orphan_ttl_days: raw?.orphan_ttl_days ?? DEFAULT_PRUNING_CONFIG.orphan_ttl_days,
    batch_size: raw?.batch_size ?? DEFAULT_PRUNING_CONFIG.batch_size,
    hard_delete_after_days: raw?.hard_delete_after_days ?? DEFAULT_PRUNING_CONFIG.hard_delete_after_days,
  }
}

export function softDeleteContradictedEntities(store: Store, config: PruningConfig, projectHash?: string): number {
  const ids = store.getContradictedEntitiesForPruning(
    config.contradicted_ttl_days,
    config.batch_size,
    projectHash
  )
  if (ids.length === 0) return 0
  store.softDeleteEntities(ids)
  log('pruning', `Soft-deleted ${ids.length} contradicted entities`)
  return ids.length
}

export function softDeleteOrphanEntities(store: Store, config: PruningConfig, projectHash?: string): number {
  const ids = store.getOrphanEntitiesForPruning(
    config.orphan_ttl_days,
    config.batch_size,
    projectHash
  )
  if (ids.length === 0) return 0
  store.softDeleteEntities(ids)
  log('pruning', `Soft-deleted ${ids.length} orphan entities`)
  return ids.length
}

export function hardDeletePrunedEntities(store: Store, config: PruningConfig, projectHash?: string): number {
  const ids = store.getPrunedEntitiesForHardDelete(
    config.hard_delete_after_days,
    config.batch_size,
    projectHash
  )
  if (ids.length === 0) return 0
  store.hardDeleteEntities(ids)
  log('pruning', `Hard-deleted ${ids.length} pruned entities`)
  return ids.length
}

export function runPruningCycle(store: Store, config: PruningConfig, projectHash?: string): PruningResult {
  const contradictedPruned = softDeleteContradictedEntities(store, config, projectHash)
  const orphansPruned = softDeleteOrphanEntities(store, config, projectHash)
  const total = contradictedPruned + orphansPruned
  if (total > 0) {
    log('pruning', `Pruning cycle complete: ${contradictedPruned} contradicted, ${orphansPruned} orphans soft-deleted`)
  }
  return { contradictedPruned, orphansPruned, hardDeleted: 0 }
}
