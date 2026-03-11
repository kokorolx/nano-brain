import { describe, it, expect } from 'vitest';
import { ThompsonSampler, DEFAULT_BANDIT_CONFIGS, type BanditConfig } from '../src/bandits.js';

describe('ThompsonSampler', () => {
  describe('constructor', () => {
    it('should initialize with default configs', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS);
      const state = sampler.getState();
      expect(state).toHaveLength(2);
      expect(state[0].parameterName).toBe('rrf_k');
      expect(state[1].parameterName).toBe('centrality_weight');
    });

    it('should accept deterministic seed', () => {
      const sampler1 = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 12345);
      const sampler2 = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 12345);
      const result1 = sampler1.selectSearchConfig();
      const result2 = sampler2.selectSearchConfig();
      expect(result1).toEqual(result2);
    });
  });

  describe('selectVariant', () => {
    it('should return valid variant value for known parameter', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 42);
      const value = sampler.selectVariant('rrf_k');
      expect([30, 60, 90]).toContain(value);
    });

    it('should throw for unknown parameter', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS);
      expect(() => sampler.selectVariant('unknown')).toThrow('Unknown parameter: unknown');
    });

    it('should use uniform random during exploration phase', () => {
      const configs: BanditConfig[] = [{
        parameterName: 'test',
        variants: [
          { value: 1, successes: 1, failures: 1 },
          { value: 2, successes: 1, failures: 1 },
        ],
        minObservations: 100,
        dampeningFactor: 0.1,
        bounds: { min: 0, max: 10 },
      }];
      const sampler = new ThompsonSampler(configs, 42);
      const value = sampler.selectVariant('test');
      expect([1, 2]).toContain(value);
    });

    it('should use Beta sampling during exploitation phase', () => {
      const configs: BanditConfig[] = [{
        parameterName: 'test',
        variants: [
          { value: 1, successes: 100, failures: 10 },
          { value: 2, successes: 10, failures: 100 },
        ],
        minObservations: 10,
        dampeningFactor: 0.1,
        bounds: { min: 0, max: 10 },
      }];
      const sampler = new ThompsonSampler(configs, 42);
      let count1 = 0;
      let count2 = 0;
      for (let i = 0; i < 100; i++) {
        const s = new ThompsonSampler(configs, i);
        const v = s.selectVariant('test');
        if (v === 1) count1++;
        else count2++;
      }
      expect(count1).toBeGreaterThan(count2);
    });
  });

  describe('recordReward', () => {
    it('should increment successes on positive reward', () => {
      const configs: BanditConfig[] = [{
        parameterName: 'test',
        variants: [{ value: 1, successes: 1, failures: 1 }],
        minObservations: 100,
        dampeningFactor: 0.1,
        bounds: { min: 0, max: 10 },
      }];
      const sampler = new ThompsonSampler(configs);
      sampler.recordReward('test', 1, true);
      const state = sampler.getState();
      expect(state[0].variants[0].successes).toBe(2);
      expect(state[0].variants[0].failures).toBe(1);
    });

    it('should increment failures on negative reward', () => {
      const configs: BanditConfig[] = [{
        parameterName: 'test',
        variants: [{ value: 1, successes: 1, failures: 1 }],
        minObservations: 100,
        dampeningFactor: 0.1,
        bounds: { min: 0, max: 10 },
      }];
      const sampler = new ThompsonSampler(configs);
      sampler.recordReward('test', 1, false);
      const state = sampler.getState();
      expect(state[0].variants[0].successes).toBe(1);
      expect(state[0].variants[0].failures).toBe(2);
    });

    it('should ignore unknown parameter', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS);
      sampler.recordReward('unknown', 1, true);
    });

    it('should ignore unknown variant value', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS);
      sampler.recordReward('rrf_k', 999, true);
    });
  });

  describe('selectSearchConfig', () => {
    it('should return config for all parameters', () => {
      const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 42);
      const config = sampler.selectSearchConfig();
      expect(config).toHaveProperty('rrf_k');
      expect(config).toHaveProperty('centrality_weight');
      expect([30, 60, 90]).toContain(config.rrf_k);
      expect([0.0, 0.05, 0.1, 0.2]).toContain(config.centrality_weight);
    });
  });

  describe('deterministic seed', () => {
    it('should produce consistent results with same seed', () => {
      const results: Record<string, number>[] = [];
      for (let i = 0; i < 5; i++) {
        const sampler = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 12345);
        results.push(sampler.selectSearchConfig());
      }
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toEqual(results[0]);
      }
    });

    it('should produce different results with different seeds', () => {
      const sampler1 = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 1);
      const sampler2 = new ThompsonSampler(DEFAULT_BANDIT_CONFIGS, 2);
      let different = false;
      for (let i = 0; i < 10; i++) {
        const r1 = sampler1.selectSearchConfig();
        const r2 = sampler2.selectSearchConfig();
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          different = true;
          break;
        }
      }
      expect(different).toBe(true);
    });
  });
});
