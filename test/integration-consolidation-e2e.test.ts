import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsolidationAgent, type LLMProvider } from '../src/consolidation.js';
import { createStore, computeHash } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const createMockLLMProvider = (response: string): LLMProvider => ({
  complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 150 }),
  model: 'test-model',
});

describe('Consolidation E2E Integration', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-consolidation-e2e-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function insertTestMemory(title: string, body: string): number {
    const hash = computeHash(body);
    store.insertContent(hash, body);
    return store.insertDocument({
      collection: 'memory',
      path: `memory/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
      title,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
  }

  it('should complete full consolidation cycle with mock LLM', async () => {
    insertTestMemory('Auth Decision', 'We decided to use JWT tokens for authentication');
    insertTestMemory('Token Expiry', 'JWT tokens should expire after 24 hours');
    insertTestMemory('Refresh Tokens', 'Implement refresh token rotation for security');

    const llmResponse = JSON.stringify([{
      sourceIds: [1, 2, 3],
      summary: 'Authentication strategy using JWT with 24h expiry and refresh token rotation',
      insight: 'Comprehensive JWT auth with security best practices',
      connections: [
        { fromId: 1, toId: 2, relationship: 'configures', confidence: 0.9 },
        { fromId: 2, toId: 3, relationship: 'requires', confidence: 0.85 },
      ],
      overallConfidence: 0.88,
    }]);

    const mockProvider = createMockLLMProvider(llmResponse);
    const agent = new ConsolidationAgent(store, {
      llmProvider: mockProvider,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    const results = await agent.runConsolidationCycle();

    expect(results.length).toBe(1);
    expect(results[0].sourceIds).toEqual([1, 2, 3]);
    expect(results[0].summary).toContain('JWT');
    expect(mockProvider.complete).toHaveBeenCalledTimes(1);

    const db = store.getDb();
    const consolidations = db.prepare('SELECT * FROM consolidations').all() as Array<{
      id: number;
      source_ids: string;
      summary: string;
      insight: string;
      confidence: number;
    }>;
    expect(consolidations.length).toBe(1);
    expect(JSON.parse(consolidations[0].source_ids)).toEqual([1, 2, 3]);
  });

  it('should exclude already-consolidated docs on second cycle', async () => {
    insertTestMemory('Memory A', 'First memory content');
    insertTestMemory('Memory B', 'Second memory content');
    insertTestMemory('Memory C', 'Third memory content');
    insertTestMemory('Memory D', 'Fourth memory content');

    const firstResponse = JSON.stringify([{
      sourceIds: [1, 2],
      summary: 'First consolidation',
      insight: 'Insight from A and B',
      connections: [],
      overallConfidence: 0.8,
    }]);

    const mockProvider1 = createMockLLMProvider(firstResponse);
    const agent1 = new ConsolidationAgent(store, {
      llmProvider: mockProvider1,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    const results1 = await agent1.runConsolidationCycle();
    expect(results1.length).toBe(1);
    expect(results1[0].sourceIds).toEqual([1, 2]);

    const secondResponse = JSON.stringify([{
      sourceIds: [3, 4],
      summary: 'Second consolidation',
      insight: 'Insight from C and D',
      connections: [],
      overallConfidence: 0.75,
    }]);

    const mockProvider2 = createMockLLMProvider(secondResponse);
    const agent2 = new ConsolidationAgent(store, {
      llmProvider: mockProvider2,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    const results2 = await agent2.runConsolidationCycle();
    expect(results2.length).toBe(1);
    expect(results2[0].sourceIds).toEqual([3, 4]);

    const db = store.getDb();
    const consolidations = db.prepare('SELECT * FROM consolidations').all();
    expect(consolidations.length).toBe(2);
  });

  it('should record token usage', async () => {
    insertTestMemory('Test Memory 1', 'Content one');
    insertTestMemory('Test Memory 2', 'Content two');

    const llmResponse = JSON.stringify([{
      sourceIds: [1, 2],
      summary: 'Test summary',
      insight: 'Test insight',
      connections: [],
      overallConfidence: 0.7,
    }]);

    const mockProvider = createMockLLMProvider(llmResponse);
    const agent = new ConsolidationAgent(store, {
      llmProvider: mockProvider,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    await agent.runConsolidationCycle();

    const db = store.getDb();
    const tokenUsage = db.prepare('SELECT * FROM token_usage WHERE model LIKE ?').all('consolidation:%') as Array<{
      model: string;
      total_tokens: number;
    }>;

    expect(tokenUsage.length).toBe(1);
    expect(tokenUsage[0].model).toBe('consolidation:test-model');
    expect(tokenUsage[0].total_tokens).toBe(150);
  });

  it('should skip consolidation when not enough memories', async () => {
    insertTestMemory('Single Memory', 'Only one memory');

    const mockProvider = createMockLLMProvider('[]');
    const agent = new ConsolidationAgent(store, {
      llmProvider: mockProvider,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    const results = await agent.runConsolidationCycle();

    expect(results).toEqual([]);
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it('should filter low-confidence consolidations', async () => {
    insertTestMemory('Memory X', 'Content X');
    insertTestMemory('Memory Y', 'Content Y');

    const llmResponse = JSON.stringify([{
      sourceIds: [1, 2],
      summary: 'Low confidence result',
      insight: 'Uncertain connection',
      connections: [],
      overallConfidence: 0.3,
    }]);

    const mockProvider = createMockLLMProvider(llmResponse);
    const agent = new ConsolidationAgent(store, {
      llmProvider: mockProvider,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    const results = await agent.runConsolidationCycle();

    expect(results).toEqual([]);

    const db = store.getDb();
    const consolidations = db.prepare('SELECT COUNT(*) as count FROM consolidations').get() as { count: number };
    expect(consolidations.count).toBe(0);
  });

  it('should handle LLM errors gracefully', async () => {
    insertTestMemory('Error Test 1', 'Content 1');
    insertTestMemory('Error Test 2', 'Content 2');

    const mockProvider: LLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
      model: 'test-model',
    };

    const agent = new ConsolidationAgent(store, {
      llmProvider: mockProvider,
      minMemoriesThreshold: 2,
      confidenceThreshold: 0.6,
    });

    await expect(agent.runConsolidationCycle()).rejects.toThrow('LLM service unavailable');
  });
});
