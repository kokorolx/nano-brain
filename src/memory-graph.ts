import Database from 'better-sqlite3'
import type { MemoryEntity, MemoryEdge } from './types.js'

export interface TraversalResult {
  entities: MemoryEntity[]
  edges: MemoryEdge[]
  paths: Map<number, number[]>
}

export interface MemoryGraphStats {
  entityCount: number
  edgeCount: number
  entityTypes: Record<string, number>
}

export class MemoryGraph {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  insertEntity(entity: Omit<MemoryEntity, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO memory_entities (name, type, description, project_hash, first_learned_at, last_confirmed_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(name COLLATE NOCASE, type, project_hash) DO UPDATE SET
        description = COALESCE(excluded.description, memory_entities.description),
        last_confirmed_at = datetime('now')
    `)
    stmt.run(entity.name, entity.type, entity.description ?? null, entity.projectHash)
    const row = this.db.prepare(`
      SELECT id FROM memory_entities 
      WHERE name COLLATE NOCASE = ? AND type = ? AND project_hash = ?
    `).get(entity.name, entity.type, entity.projectHash) as { id: number } | undefined
    return row?.id ?? 0
  }

  insertEdge(edge: Omit<MemoryEdge, 'id' | 'createdAt'>): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_edges (source_id, target_id, edge_type, project_hash)
      VALUES (?, ?, ?, ?)
    `)
    const result = stmt.run(edge.sourceId, edge.targetId, edge.edgeType, edge.projectHash)
    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT id FROM memory_edges 
        WHERE source_id = ? AND target_id = ? AND edge_type = ? AND project_hash = ?
      `).get(edge.sourceId, edge.targetId, edge.edgeType, edge.projectHash) as { id: number } | undefined
      return existing?.id ?? 0
    }
    return Number(result.lastInsertRowid)
  }

  traverse(
    startEntityId: number,
    maxDepth: number = 3,
    relationshipTypes?: string[]
  ): TraversalResult {
    const effectiveMaxDepth = Math.min(maxDepth, 10)
    const visited = new Set<number>()
    const entities: MemoryEntity[] = []
    const edges: MemoryEdge[] = []
    const paths = new Map<number, number[]>()
    const queue: Array<{ entityId: number; depth: number; path: number[] }> = []

    const startEntity = this.getEntityById(startEntityId)
    if (!startEntity) {
      return { entities: [], edges: [], paths: new Map() }
    }

    visited.add(startEntityId)
    entities.push(startEntity)
    paths.set(startEntityId, [startEntityId])
    queue.push({ entityId: startEntityId, depth: 0, path: [startEntityId] })

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.depth >= effectiveMaxDepth) continue

      const neighborEdges = this.getEdgesForEntity(current.entityId, relationshipTypes)
      for (const edge of neighborEdges) {
        const neighborId = edge.sourceId === current.entityId ? edge.targetId : edge.sourceId
        if (visited.has(neighborId)) continue

        visited.add(neighborId)
        const neighborEntity = this.getEntityById(neighborId)
        if (neighborEntity) {
          entities.push(neighborEntity)
          edges.push(edge)
          const newPath = [...current.path, neighborId]
          paths.set(neighborId, newPath)
          queue.push({ entityId: neighborId, depth: current.depth + 1, path: newPath })
        }
      }
    }

    return { entities, edges, paths }
  }

  findSimilarEntities(name: string, projectHash: string, limit: number = 10): MemoryEntity[] {
    const stmt = this.db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities
      WHERE project_hash = ? AND name LIKE ? AND pruned_at IS NULL
      ORDER BY last_confirmed_at DESC
      LIMIT ?
    `)
    const likePattern = `%${name}%`
    const rows = stmt.all(projectHash, likePattern, limit) as Array<Record<string, unknown>>
    return rows.map(row => this.rowToEntity(row))
  }

  getStats(projectHash: string): MemoryGraphStats {
    const entityCountRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_entities WHERE project_hash = ? AND pruned_at IS NULL
    `).get(projectHash) as { count: number }

    const edgeCountRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM memory_edges WHERE project_hash = ?
    `).get(projectHash) as { count: number }

    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM memory_entities 
      WHERE project_hash = ? AND pruned_at IS NULL GROUP BY type
    `).all(projectHash) as Array<{ type: string; count: number }>

    const entityTypes: Record<string, number> = {}
    for (const row of typeRows) {
      entityTypes[row.type] = row.count
    }

    return {
      entityCount: entityCountRow.count,
      edgeCount: edgeCountRow.count,
      entityTypes,
    }
  }

  private getEntityById(id: number): MemoryEntity | null {
    const row = this.db.prepare(`
      SELECT id, name, type, description, project_hash as projectHash,
             first_learned_at as firstLearnedAt, last_confirmed_at as lastConfirmedAt,
             contradicted_at as contradictedAt, contradicted_by_memory_id as contradictedByMemoryId
      FROM memory_entities WHERE id = ? AND pruned_at IS NULL
    `).get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return this.rowToEntity(row)
  }

  private getEdgesForEntity(entityId: number, relationshipTypes?: string[]): MemoryEdge[] {
    let sql = `
      SELECT id, source_id as sourceId, target_id as targetId, edge_type as edgeType,
             project_hash as projectHash, created_at as createdAt
      FROM memory_edges
      WHERE source_id = ? OR target_id = ?
    `
    const params: (number | string)[] = [entityId, entityId]

    if (relationshipTypes && relationshipTypes.length > 0) {
      const placeholders = relationshipTypes.map(() => '?').join(',')
      sql += ` AND edge_type IN (${placeholders})`
      params.push(...relationshipTypes)
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: row.id as number,
      sourceId: row.sourceId as number,
      targetId: row.targetId as number,
      edgeType: row.edgeType as MemoryEdge['edgeType'],
      projectHash: row.projectHash as string,
      createdAt: row.createdAt as string,
    }))
  }

  private rowToEntity(row: Record<string, unknown>): MemoryEntity {
    return {
      id: row.id as number,
      name: row.name as string,
      type: row.type as MemoryEntity['type'],
      description: row.description as string | undefined,
      projectHash: row.projectHash as string,
      firstLearnedAt: row.firstLearnedAt as string,
      lastConfirmedAt: row.lastConfirmedAt as string,
      contradictedAt: row.contradictedAt as string | null | undefined,
      contradictedByMemoryId: row.contradictedByMemoryId as number | null | undefined,
    }
  }
}
