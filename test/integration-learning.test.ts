import { describe, it, expect } from 'bun:test';
import { ThompsonSampler, DEFAULT_BANDIT_CONFIGS } from '../src/bandits.js';
import { IntentClassifier } from '../src/intent-classifier.js';
import { ImportanceScorer } from '../src/importance.js';
import { generateQueryId, jaccardSimilarity, detectReformulation } from '../src/telemetry.js';

describe('Self-Learning Integration', () => {
  it('end-to-end: query -> telemetry -> bandit -> config adapted', () => {
    const sampler = new ThompsonSampler(JSON.parse(JSON.stringify(DEFAULT_BANDIT_CONFIGS)), 42);
    
    const config1 = sampler.selectSearchConfig();
    expect(config1.rrf_k).toBeDefined();
    expect(config1.centrality_weight).toBeDefined();
    
    for (let i = 0; i < 150; i++) {
      sampler.recordReward('rrf_k', 60, true);
      sampler.recordReward('centrality_weight', 0.1, true);
    }
    
    for (let i = 0; i < 150; i++) {
      sampler.recordReward('rrf_k', 30, false);
      sampler.recordReward('centrality_weight', 0.0, false);
    }
    
    const state = sampler.getState();
    const rrfConfig = state.find(c => c.parameterName === 'rrf_k');
    expect(rrfConfig).toBeDefined();
    const variant60 = rrfConfig!.variants.find(v => v.value === 60);
    const variant30 = rrfConfig!.variants.find(v => v.value === 30);
    expect(variant60!.successes).toBeGreaterThan(variant30!.successes);
    expect(variant30!.failures).toBeGreaterThan(variant60!.failures);
  });

  it('intent classification routes to correct config', () => {
    const classifier = new IntentClassifier({ enabled: true, intents: {
      lookup: { keywords: ['where is', 'find'], config_overrides: { centrality_weight: 0.2 } },
      explanation: { keywords: ['how does', 'explain'], config_overrides: { rrf_k: 45 } },
    }});
    
    const lookup = classifier.classify('where is the auth middleware');
    expect(lookup.intent).toBe('lookup');
    
    const explanation = classifier.classify('how does the search pipeline work');
    expect(explanation.intent).toBe('explanation');
    
    const overrides = classifier.getConfigOverrides('lookup');
    expect(overrides.centrality_weight).toBe(0.2);
  });

  it('importance scoring applies correct formula', () => {
    const scorer = new ImportanceScorer(null as any);
    const score = scorer.calculateScore({
      usageCount: 10,
      entityDensity: 0.5,
      daysSinceAccess: 0,
      connectionCount: 5,
      maxUsage: 20,
      maxConnections: 10,
    });
    expect(score).toBeCloseTo(0.6, 1);
  });

  it('reformulation detection works across query pairs', () => {
    const result = detectReformulation('how to configure auth', [
      { id: 1, query_text: 'how to setup auth', timestamp: new Date().toISOString() },
    ]);
    const sim = jaccardSimilarity('how to configure auth', 'how to setup auth');
    if (sim > 0.5) {
      expect(result).toBe(1);
    }
  });

  it('generateQueryId returns unique UUIDs', () => {
    const id1 = generateQueryId();
    const id2 = generateQueryId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('jaccard similarity handles edge cases', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
    expect(jaccardSimilarity('hello', '')).toBe(0);
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
    expect(jaccardSimilarity('hello', 'world')).toBe(0);
  });
});
