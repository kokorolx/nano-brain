import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createStore } from '../src/store.js'
import { MemoryGraph } from '../src/memory-graph.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('MemoryGraph', () => {
  let store: ReturnType<typeof createStore>
  let graph: MemoryGraph
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-test-'))
    dbPath = path.join(tmpDir, 'test.sqlite')
    store = createStore(dbPath)
    graph = new MemoryGraph(store.getDb())
  })

  afterEach(() => {
    store.close()
    fs.rmSync(tmpDir, { recursive: true })
  })

  describe('entity operations', () => {
    it('should insert and retrieve entity', () => {
      const entityId = store.insertOrUpdateEntity({
        name: 'Redis',
        type: 'service',
        description: 'In-memory data store',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })
      expect(entityId).toBeGreaterThan(0)

      const entity = store.getEntityByName('redis', 'service', 'test123')
      expect(entity).not.toBeNull()
      expect(entity?.name).toBe('Redis')
      expect(entity?.type).toBe('service')
    })

    it('should handle case-insensitive deduplication', () => {
      const id1 = store.insertOrUpdateEntity({
        name: 'Redis',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const id2 = store.insertOrUpdateEntity({
        name: 'REDIS',
        type: 'service',
        description: 'Updated description',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      expect(id1).toBe(id2)
      const count = store.getMemoryEntityCount('test123')
      expect(count).toBe(1)
    })

    it('should mark entity as contradicted', () => {
      const entityId = store.insertOrUpdateEntity({
        name: 'OldDecision',
        type: 'decision',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      store.markEntityContradicted(entityId, 999)
      const entity = store.getEntityById(entityId)
      expect(entity?.contradictedAt).not.toBeNull()
      expect(entity?.contradictedByMemoryId).toBe(999)
    })

    it('should confirm entity', () => {
      const entityId = store.insertOrUpdateEntity({
        name: 'TestEntity',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      store.confirmEntity(entityId)
      const after = store.getEntityById(entityId)

      expect(after?.lastConfirmedAt).toBeDefined()
      expect(after?.contradictedAt).toBeNull()
    })
  })

  describe('edge operations', () => {
    it('should insert and retrieve edges', () => {
      const redisId = store.insertOrUpdateEntity({
        name: 'Redis',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const userServiceId = store.insertOrUpdateEntity({
        name: 'UserService',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const edgeId = store.insertEdge({
        sourceId: userServiceId,
        targetId: redisId,
        edgeType: 'uses',
        projectHash: 'test123',
      })
      expect(edgeId).toBeGreaterThan(0)

      const incomingEdges = store.getEntityEdges(redisId, 'incoming')
      expect(incomingEdges.length).toBe(1)
      expect(incomingEdges[0].sourceName).toBe('UserService')
      expect(incomingEdges[0].targetName).toBe('Redis')
    })
  })

  describe('MemoryGraph class', () => {
    it('should get stats', () => {
      graph.insertEntity({
        name: 'Entity1',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      graph.insertEntity({
        name: 'Entity2',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const stats = graph.getStats('test123')
      expect(stats.entityCount).toBe(2)
      expect(stats.entityTypes['concept']).toBe(1)
      expect(stats.entityTypes['service']).toBe(1)
    })

    it('should traverse graph with BFS', () => {
      const aId = graph.insertEntity({
        name: 'A',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const bId = graph.insertEntity({
        name: 'B',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const cId = graph.insertEntity({
        name: 'C',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      graph.insertEdge({ sourceId: aId, targetId: bId, edgeType: 'related_to', projectHash: 'test123' })
      graph.insertEdge({ sourceId: bId, targetId: cId, edgeType: 'related_to', projectHash: 'test123' })

      const result = graph.traverse(aId, 3)
      expect(result.entities.length).toBe(3)
      expect(result.edges.length).toBe(2)
      expect(result.paths.get(cId)?.length).toBe(3)
    })

    it('should respect maxDepth in traversal', () => {
      const aId = graph.insertEntity({
        name: 'A',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const bId = graph.insertEntity({
        name: 'B',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const cId = graph.insertEntity({
        name: 'C',
        type: 'concept',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      graph.insertEdge({ sourceId: aId, targetId: bId, edgeType: 'related_to', projectHash: 'test123' })
      graph.insertEdge({ sourceId: bId, targetId: cId, edgeType: 'related_to', projectHash: 'test123' })

      const result = graph.traverse(aId, 1)
      expect(result.entities.length).toBe(2)
      expect(result.entities.map(e => e.name)).toContain('A')
      expect(result.entities.map(e => e.name)).toContain('B')
      expect(result.entities.map(e => e.name)).not.toContain('C')
    })

    it('should find similar entities', () => {
      graph.insertEntity({
        name: 'UserService',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      graph.insertEntity({
        name: 'AuthService',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      graph.insertEntity({
        name: 'Redis',
        type: 'service',
        projectHash: 'test123',
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      })

      const similar = graph.findSimilarEntities('Service', 'test123')
      expect(similar.length).toBe(2)
      expect(similar.map(e => e.name)).toContain('UserService')
      expect(similar.map(e => e.name)).toContain('AuthService')
    })
  })
})
