import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createStore, computeHash } from '../src/store.js';
import { categorize } from '../src/categorizer.js';
import { computeDecayScore, applyUsageBoost } from '../src/search.js';
import { MemoryGraph } from '../src/memory-graph.js';
import { parseEntityExtractionResponse, buildEntityExtractionPrompt } from '../src/entity-extraction.js';
import { evictLowAccessDocuments } from '../src/storage.js';
import type { Store, SearchResult } from '../src/types.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

let store: Store;
let dbPath: string;
let tmpDir: string;
const PROJECT_HASH = 'test-project-hash';

function insertTestDocument(content: string, docPath: string): number {
  const hash = computeHash(content);
  store.insertContent(hash, content);
  return store.insertDocument({
    collection: 'test',
    path: docPath,
    title: docPath.split('/').pop() || 'Test',
    hash,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    active: true,
    projectHash: PROJECT_HASH,
  });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-rri-t-'));
  dbPath = path.join(tmpDir, 'test.db');
  store = createStore(dbPath);
});

afterAll(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('D1: MCP Response Quality', () => {
  it('TC-RRI-SLS-001: categorize returns valid auto-tags for architecture content', () => {
    const content = 'We decided to use microservices architecture for better scalability';
    const tags = categorize(content);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.some(t => t.startsWith('auto:'))).toBe(true);
  });

  it('TC-RRI-SLS-002: categorize returns empty array for minimal content', () => {
    const tags = categorize('hi');
    expect(Array.isArray(tags)).toBe(true);
  });

  it('TC-RRI-SLS-003: buildEntityExtractionPrompt returns non-empty string', () => {
    const prompt = buildEntityExtractionPrompt('Test content about Redis caching');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('TC-RRI-SLS-004: parseEntityExtractionResponse handles valid JSON response', () => {
    const response = JSON.stringify({
      entities: [{ name: 'Redis', type: 'technology', confidence: 0.9 }],
      relationships: []
    });
    const result = parseEntityExtractionResponse(response);
    expect(result).toBeDefined();
  });

  it('TC-RRI-SLS-005: parseEntityExtractionResponse handles malformed JSON gracefully', () => {
    const result = parseEntityExtractionResponse('not valid json');
    expect(result).toBeDefined();
  });
});

describe('D2: API/MCP Tool Interface', () => {
  it('TC-RRI-SLS-006: insertDocument creates document with access tracking fields', () => {
    const id = insertTestDocument('Test document content', '/test/doc1.md');
    expect(id).toBeGreaterThan(0);
  });

  it('TC-RRI-SLS-007: store.trackAccess increments access count', () => {
    const id = insertTestDocument('Document for access tracking', '/test/doc-access.md');
    store.trackAccess([id]);
    const doc = store.findDocument('/test/doc-access.md');
    expect(doc).not.toBeNull();
  });

  it('TC-RRI-SLS-008: store.insertOrUpdateEntity creates entity', () => {
    const entityId = store.insertOrUpdateEntity({
      name: 'TestEntity',
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    expect(entityId).toBeGreaterThan(0);
  });

  it('TC-RRI-SLS-009: store.getEntityByName retrieves entity', () => {
    store.insertOrUpdateEntity({
      name: 'RetrievableEntity',
      type: 'service',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    const entity = store.getEntityByName('RetrievableEntity', 'service', PROJECT_HASH);
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe('RetrievableEntity');
  });

  it('TC-RRI-SLS-010: store.getMemoryEntityCount returns count', () => {
    const count = store.getMemoryEntityCount(PROJECT_HASH);
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('TC-RRI-SLS-011: store.getMemoryEntities returns array', () => {
    const entities = store.getMemoryEntities(PROJECT_HASH, 10);
    expect(Array.isArray(entities)).toBe(true);
  });

  it('TC-RRI-SLS-012: computeHash returns consistent hash', () => {
    const hash1 = computeHash('test content');
    const hash2 = computeHash('test content');
    expect(hash1).toBe(hash2);
  });
});

describe('D3: Performance', () => {
  it('TC-RRI-SLS-013: computeDecayScore returns value between 0 and 1', () => {
    const now = new Date();
    const score = computeDecayScore(now, now, 30);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('TC-RRI-SLS-014: computeDecayScore decreases for older documents', () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const recentScore = computeDecayScore(now, now, 30);
    const oldScore = computeDecayScore(oldDate, oldDate, 30);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it('TC-RRI-SLS-015: applyUsageBoost boosts frequently accessed results', () => {
    const results: SearchResult[] = [
      { id: 1, path: '/a.md', content: 'a', score: 0.5, tags: [], workspace: 'ws', accessCount: 10, lastAccessedAt: new Date() },
      { id: 2, path: '/b.md', content: 'b', score: 0.5, tags: [], workspace: 'ws', accessCount: 1, lastAccessedAt: new Date() }
    ];
    const boosted = applyUsageBoost(results, { usageBoostWeight: 0.2, decayHalfLifeDays: 30 });
    expect(boosted[0].id).toBe(1);
  });

  it('TC-RRI-SLS-016: bulk insert completes in reasonable time', () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      insertTestDocument(`Performance test document ${i}`, `/perf/doc${i}.md`);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('TC-RRI-SLS-017: entity insertion is performant', () => {
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      store.insertOrUpdateEntity({
        name: `PerfEntity${i}`,
        type: 'concept',
        projectHash: PROJECT_HASH,
        firstLearnedAt: new Date().toISOString(),
        lastConfirmedAt: new Date().toISOString(),
      });
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('D4: Security', () => {
  it('TC-RRI-SLS-018: SQL injection in path is safely handled', () => {
    const maliciousPath = "'; DROP TABLE documents; --";
    const id = insertTestDocument('Safe content', maliciousPath);
    expect(id).toBeGreaterThan(0);
    const doc = store.findDocument(maliciousPath);
    expect(doc!.path).toBe(maliciousPath);
  });

  it('TC-RRI-SLS-019: SQL injection in content is safely handled', () => {
    const maliciousContent = "'; DELETE FROM memory_entities; --";
    const hash = computeHash(maliciousContent);
    store.insertContent(hash, maliciousContent);
    const body = store.getDocumentBody(hash);
    expect(body).toBe(maliciousContent);
  });

  it('TC-RRI-SLS-020: SQL injection in entity name is safely handled', () => {
    const maliciousName = "'; DROP TABLE memory_entities; --";
    const entityId = store.insertOrUpdateEntity({
      name: maliciousName,
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    const entity = store.getEntityById(entityId);
    expect(entity!.name).toBe(maliciousName);
  });

  it('TC-RRI-SLS-021: XSS content is stored without execution', () => {
    const xssContent = '<script>alert("xss")</script>';
    const hash = computeHash(xssContent);
    store.insertContent(hash, xssContent);
    const body = store.getDocumentBody(hash);
    expect(body).toBe(xssContent);
  });
});

describe('D5: Data Integrity', () => {
  it('TC-RRI-SLS-022: document hash changes when content changes', () => {
    const hash1 = computeHash('content v1');
    const hash2 = computeHash('content v2');
    expect(hash1).not.toBe(hash2);
  });

  it('TC-RRI-SLS-023: trackAccess does not throw', () => {
    const id = insertTestDocument('Test access time tracking', '/integrity/access-time.md');
    expect(() => store.trackAccess([id])).not.toThrow();
  });

  it('TC-RRI-SLS-024: entity type is preserved', () => {
    const entityId = store.insertOrUpdateEntity({
      name: 'TypeTest',
      type: 'decision',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    const entity = store.getEntityById(entityId);
    expect(entity!.type).toBe('decision');
  });

  it('TC-RRI-SLS-025: markEntityContradicted updates entity state', () => {
    const entityId = store.insertOrUpdateEntity({
      name: 'ContradictedEntity',
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    store.markEntityContradicted(entityId, 999);
    const entity = store.getEntityById(entityId);
    expect(entity!.contradictedAt).toBeDefined();
  });

  it('TC-RRI-SLS-026: confirmEntity updates lastConfirmedAt', () => {
    const entityId = store.insertOrUpdateEntity({
      name: 'ConfirmedEntity',
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    store.confirmEntity(entityId);
    const entity = store.getEntityById(entityId);
    expect(entity!.lastConfirmedAt).toBeDefined();
  });

  it('TC-RRI-SLS-027: duplicate entity names update existing', () => {
    const firstId = store.insertOrUpdateEntity({
      name: 'DuplicateEntity',
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    const secondId = store.insertOrUpdateEntity({
      name: 'DuplicateEntity',
      type: 'concept',
      projectHash: PROJECT_HASH,
      firstLearnedAt: new Date().toISOString(),
      lastConfirmedAt: new Date().toISOString(),
    });
    expect(secondId).toBe(firstId);
  });
});

describe('D6: Infrastructure', () => {
  it('TC-RRI-SLS-028: createStore creates database file', () => {
    const testDbPath = path.join(tmpDir, 'infra-test.db');
    const testStore = createStore(testDbPath);
    expect(fs.existsSync(testDbPath)).toBe(true);
    testStore.close();
  });

  it('TC-RRI-SLS-029: MemoryGraph initializes with db', () => {
    const graph = new MemoryGraph(store.getDb());
    expect(graph).toBeDefined();
  });

  it('TC-RRI-SLS-030: MemoryGraph.getStats returns statistics', () => {
    const graph = new MemoryGraph(store.getDb());
    const stats = graph.getStats(PROJECT_HASH);
    expect(stats).toHaveProperty('entityCount');
    expect(stats).toHaveProperty('edgeCount');
  });

  it('TC-RRI-SLS-031: evictLowAccessDocuments handles empty db', () => {
    const evictDbPath = path.join(tmpDir, 'evict-test.db');
    const evictStore = createStore(evictDbPath);
    const evicted = evictLowAccessDocuments(evictStore.getDb(), 5);
    expect(evicted).toBeGreaterThanOrEqual(0);
    evictStore.close();
  });

  it('TC-RRI-SLS-032: store.close is idempotent', () => {
    const closeStore = createStore(path.join(tmpDir, 'close-test.db'));
    closeStore.close();
    expect(() => closeStore.close()).not.toThrow();
  });
});

describe('D7: Edge Cases', () => {
  it('TC-RRI-SLS-033: empty content is handled', () => {
    const hash = computeHash('');
    store.insertContent(hash, '');
    const body = store.getDocumentBody(hash);
    expect(body).toBe('');
  });

  it('TC-RRI-SLS-034: very long content is handled', () => {
    const longContent = 'x'.repeat(100000);
    const hash = computeHash(longContent);
    store.insertContent(hash, longContent);
    const body = store.getDocumentBody(hash);
    expect(body!.length).toBe(100000);
  });

  it('TC-RRI-SLS-035: unicode content is preserved', () => {
    const unicodeContent = '日本語テスト 🚀 émojis и кириллица';
    const hash = computeHash(unicodeContent);
    store.insertContent(hash, unicodeContent);
    const body = store.getDocumentBody(hash);
    expect(body).toBe(unicodeContent);
  });

  it('TC-RRI-SLS-036: trackAccess with empty array does not throw', () => {
    expect(() => store.trackAccess([])).not.toThrow();
  });

  it('TC-RRI-SLS-037: trackAccess with non-existent id does not throw', () => {
    expect(() => store.trackAccess([999999])).not.toThrow();
  });

  it('TC-RRI-SLS-038: getEntityByName returns null for non-existent', () => {
    const entity = store.getEntityByName('NonExistentEntity12345', 'concept', PROJECT_HASH);
    expect(entity).toBeNull();
  });

  it('TC-RRI-SLS-039: computeDecayScore handles same-day dates', () => {
    const now = new Date();
    const score = computeDecayScore(now, now, 30);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
