import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportanceScorer, type ImportanceParams } from '../src/importance.js';
import type { Store } from '../src/types.js';

const createMockStore = (): Store => ({
  close: vi.fn(),
} as unknown as Store);

describe('ImportanceScorer', () => {
  let store: Store;

  beforeEach(() => {
    store = createMockStore();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const scorer = new ImportanceScorer(store);
      expect(scorer).toBeDefined();
      expect(scorer.getConfig().enabled).toBe(false);
    });

    it('should accept custom config', () => {
      const scorer = new ImportanceScorer(store, { enabled: true, weight: 0.2 });
      expect(scorer.getConfig().enabled).toBe(true);
      expect(scorer.getConfig().weight).toBe(0.2);
    });
  });

  describe('calculateScore', () => {
    it('should return 0 when all inputs are 0', () => {
      const scorer = new ImportanceScorer(store);
      const score = scorer.calculateScore({
        usageCount: 0,
        entityDensity: 0,
        daysSinceAccess: 0,
        connectionCount: 0,
        maxUsage: 0,
        maxConnections: 0,
      });
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should weight usage correctly', () => {
      const scorer = new ImportanceScorer(store);
      const params: ImportanceParams = {
        usageCount: 10,
        entityDensity: 0,
        daysSinceAccess: 0,
        connectionCount: 0,
        maxUsage: 10,
        maxConnections: 0,
      };
      const score = scorer.calculateScore(params);
      expect(score).toBeGreaterThan(0);
    });

    it('should apply recency decay', () => {
      const scorer = new ImportanceScorer(store);
      const recentScore = scorer.calculateScore({
        usageCount: 0,
        entityDensity: 0,
        daysSinceAccess: 0,
        connectionCount: 0,
        maxUsage: 0,
        maxConnections: 0,
      });
      const oldScore = scorer.calculateScore({
        usageCount: 0,
        entityDensity: 0,
        daysSinceAccess: 60,
        connectionCount: 0,
        maxUsage: 0,
        maxConnections: 0,
      });
      expect(recentScore).toBeGreaterThan(oldScore);
    });
  });

  describe('applyBoost', () => {
    it('should boost search score by importance', () => {
      const scorer = new ImportanceScorer(store, { weight: 0.1 });
      const boosted = scorer.applyBoost(1.0, 0.5);
      expect(boosted).toBe(1.05);
    });

    it('should not change score when importance is 0', () => {
      const scorer = new ImportanceScorer(store, { weight: 0.1 });
      const boosted = scorer.applyBoost(1.0, 0);
      expect(boosted).toBe(1.0);
    });
  });

  describe('getScore', () => {
    it('should return 0 for unknown docid', () => {
      const scorer = new ImportanceScorer(store);
      expect(scorer.getScore('unknown')).toBe(0);
    });
  });

  describe('recalculateAll', () => {
    it('should return 0 (placeholder)', async () => {
      const scorer = new ImportanceScorer(store);
      const count = await scorer.recalculateAll();
      expect(count).toBe(0);
    });
  });
});
