import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsolidationAgent, type LLMProvider, type ConsolidationResult } from '../src/consolidation.js';
import { createStore, computeHash } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const createMockLLMProvider = (response: string): LLMProvider => ({
  complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 100 }),
  model: 'test-model',
});

describe('ConsolidationAgent', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-consolidation-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const agent = new ConsolidationAgent(store);
      expect(agent).toBeDefined();
    });

    it('should accept custom options', () => {
      const agent = new ConsolidationAgent(store, {
        maxMemoriesPerCycle: 10,
        minMemoriesThreshold: 3,
        confidenceThreshold: 0.8,
      });
      expect(agent).toBeDefined();
    });
  });

  describe('runConsolidationCycle', () => {
    it('should return empty array when no LLM provider', async () => {
      const agent = new ConsolidationAgent(store);
      const results = await agent.runConsolidationCycle();
      expect(results).toEqual([]);
    });

    it('should return empty array when not enough memories', async () => {
      const llm = createMockLLMProvider('[]');
      const agent = new ConsolidationAgent(store, { llmProvider: llm });
      const results = await agent.runConsolidationCycle();
      expect(results).toEqual([]);
    });
  });

  describe('getUnconsolidatedMemories', () => {
    it('should return docs from memory collection', async () => {
      const body1 = 'Memory content 1';
      const body2 = 'Memory content 2';
      const hash1 = computeHash(body1);
      const hash2 = computeHash(body2);

      store.insertContent(hash1, body1);
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc1.md',
        title: 'Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc2.md',
        title: 'Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const llmResponse = JSON.stringify([{
        sourceIds: [1, 2],
        summary: 'Test summary',
        insight: 'Test insight',
        connections: [],
        overallConfidence: 0.8,
      }]);
      const llm = createMockLLMProvider(llmResponse);
      const agent = new ConsolidationAgent(store, { 
        llmProvider: llm,
        minMemoriesThreshold: 2,
      });

      const results = await agent.runConsolidationCycle();
      expect(llm.complete).toHaveBeenCalled();
      expect(results.length).toBe(1);
      expect(results[0].sourceIds).toEqual([1, 2]);
    });

    it('should exclude already-consolidated docs', async () => {
      const body1 = 'Memory content 1';
      const body2 = 'Memory content 2';
      const body3 = 'Memory content 3';
      const hash1 = computeHash(body1);
      const hash2 = computeHash(body2);
      const hash3 = computeHash(body3);

      store.insertContent(hash1, body1);
      store.insertContent(hash2, body2);
      store.insertContent(hash3, body3);
      
      const id1 = store.insertDocument({
        collection: 'memory',
        path: 'memory/doc1.md',
        title: 'Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc2.md',
        title: 'Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc3.md',
        title: 'Doc 3',
        hash: hash3,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const db = store.getDb();
      db.prepare(`
        INSERT INTO consolidations (source_ids, summary, insight, connections, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(JSON.stringify([id1]), 'Old summary', 'Old insight', '[]', 0.9, new Date().toISOString());

      const llmResponse = JSON.stringify([{
        sourceIds: [2, 3],
        summary: 'New summary',
        insight: 'New insight',
        connections: [],
        overallConfidence: 0.7,
      }]);
      const llm = createMockLLMProvider(llmResponse);
      const agent = new ConsolidationAgent(store, { 
        llmProvider: llm,
        minMemoriesThreshold: 2,
      });

      const results = await agent.runConsolidationCycle();
      expect(results.length).toBe(1);
      expect(results[0].sourceIds).toEqual([2, 3]);
    });
  });

  describe('applyConsolidation', () => {
    it('should persist to consolidations table', async () => {
      const body1 = 'Memory content 1';
      const body2 = 'Memory content 2';
      const hash1 = computeHash(body1);
      const hash2 = computeHash(body2);

      store.insertContent(hash1, body1);
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc1.md',
        title: 'Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/doc2.md',
        title: 'Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const llmResponse = JSON.stringify([{
        sourceIds: [1, 2],
        summary: 'Consolidated summary',
        insight: 'Consolidated insight',
        connections: [{ fromId: 1, toId: 2, relationship: 'related', confidence: 0.9 }],
        overallConfidence: 0.85,
      }]);
      const llm = createMockLLMProvider(llmResponse);
      const agent = new ConsolidationAgent(store, { 
        llmProvider: llm,
        minMemoriesThreshold: 2,
      });

      await agent.runConsolidationCycle();

      const db = store.getDb();
      const rows = db.prepare('SELECT * FROM consolidations').all() as Array<{
        id: number;
        source_ids: string;
        summary: string;
        insight: string;
        connections: string;
        confidence: number;
      }>;

      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0].source_ids)).toEqual([1, 2]);
      expect(rows[0].summary).toBe('Consolidated summary');
      expect(rows[0].insight).toBe('Consolidated insight');
      expect(JSON.parse(rows[0].connections)).toEqual([{ fromId: 1, toId: 2, relationship: 'related', confidence: 0.9 }]);
      expect(rows[0].confidence).toBe(0.85);
    });
  });

  describe('full cycle with mock LLM', () => {
    it('should complete full consolidation cycle', async () => {
      const body1 = 'Decision: Use Redis for caching';
      const body2 = 'Decision: Cache TTL should be 1 hour';
      const hash1 = computeHash(body1);
      const hash2 = computeHash(body2);

      store.insertContent(hash1, body1);
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'memory',
        path: 'memory/redis-decision.md',
        title: 'Redis Decision',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/cache-ttl.md',
        title: 'Cache TTL',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const llmResponse = JSON.stringify([{
        sourceIds: [1, 2],
        summary: 'Caching strategy using Redis with 1 hour TTL',
        insight: 'Redis caching with appropriate TTL improves performance',
        connections: [{ fromId: 1, toId: 2, relationship: 'configures', confidence: 0.95 }],
        overallConfidence: 0.9,
      }]);
      const llm = createMockLLMProvider(llmResponse);
      const agent = new ConsolidationAgent(store, { 
        llmProvider: llm,
        minMemoriesThreshold: 2,
        confidenceThreshold: 0.6,
      });

      const results = await agent.runConsolidationCycle();

      expect(results.length).toBe(1);
      expect(results[0].summary).toBe('Caching strategy using Redis with 1 hour TTL');
      expect(store.recordTokenUsage).not.toHaveBeenCalled;

      const db = store.getDb();
      const consolidations = db.prepare('SELECT COUNT(*) as count FROM consolidations').get() as { count: number };
      expect(consolidations.count).toBe(1);

      const tokenUsage = db.prepare('SELECT * FROM token_usage WHERE model LIKE ?').all('consolidation:%') as Array<{ model: string; total_tokens: number }>;
      expect(tokenUsage.length).toBe(1);
      expect(tokenUsage[0].total_tokens).toBe(100);
    });

    it('should filter results below confidence threshold', async () => {
      const body1 = 'Memory 1';
      const body2 = 'Memory 2';
      const hash1 = computeHash(body1);
      const hash2 = computeHash(body2);

      store.insertContent(hash1, body1);
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'memory',
        path: 'memory/m1.md',
        title: 'M1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      store.insertDocument({
        collection: 'memory',
        path: 'memory/m2.md',
        title: 'M2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const llmResponse = JSON.stringify([{
        sourceIds: [1, 2],
        summary: 'Low confidence result',
        insight: 'Not sure about this',
        connections: [],
        overallConfidence: 0.3,
      }]);
      const llm = createMockLLMProvider(llmResponse);
      const agent = new ConsolidationAgent(store, { 
        llmProvider: llm,
        minMemoriesThreshold: 2,
        confidenceThreshold: 0.6,
      });

      const results = await agent.runConsolidationCycle();
      expect(results.length).toBe(0);

      const db = store.getDb();
      const consolidations = db.prepare('SELECT COUNT(*) as count FROM consolidations').get() as { count: number };
      expect(consolidations.count).toBe(0);
    });
  });
});
