import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsolidationAgent, type LLMProvider, type ConsolidationResult } from '../src/consolidation.js';
import type { Store } from '../src/types.js';

const createMockStore = (): Store => ({
  recordTokenUsage: vi.fn(),
  supersedeDocument: vi.fn(),
  close: vi.fn(),
} as unknown as Store);

const createMockLLMProvider = (response: string): LLMProvider => ({
  complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 100 }),
  model: 'test-model',
});

describe('ConsolidationAgent', () => {
  let store: Store;

  beforeEach(() => {
    store = createMockStore();
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
});
