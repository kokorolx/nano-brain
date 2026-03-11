import { describe, it, expect } from 'vitest';
import { IntentClassifier, type IntentType } from '../src/intent-classifier.js';
import { DEFAULT_INTENT_CONFIG } from '../src/types.js';

describe('IntentClassifier', () => {
  describe('constructor', () => {
    it('should initialize with default config', () => {
      const classifier = new IntentClassifier();
      expect(classifier.isEnabled()).toBe(false);
    });

    it('should accept custom config', () => {
      const classifier = new IntentClassifier({ enabled: true });
      expect(classifier.isEnabled()).toBe(true);
    });
  });

  describe('classify', () => {
    it('should classify lookup intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result = classifier.classify('where is the auth module');
      expect(result.intent).toBe('lookup');
      expect(result.confidence).toBe(0.9);
      expect(result.matchedKeyword).toBeDefined();
    });

    it('should classify explanation intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result = classifier.classify('how does the cache work');
      expect(result.intent).toBe('explanation');
      expect(result.confidence).toBe(0.9);
    });

    it('should classify architecture intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result = classifier.classify('describe the system design');
      expect(result.intent).toBe('architecture');
      expect(result.confidence).toBe(0.9);
    });

    it('should classify recall intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result = classifier.classify('what did we decide about the API');
      expect(result.intent).toBe('recall');
      expect(result.confidence).toBe(0.9);
    });

    it('should return unclassified for unknown queries', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result = classifier.classify('random query without keywords');
      expect(result.intent).toBe('unclassified');
      expect(result.confidence).toBe(0.0);
      expect(result.matchedKeyword).toBeUndefined();
    });

    it('should be case insensitive', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const result1 = classifier.classify('WHERE IS the module');
      const result2 = classifier.classify('where is the module');
      expect(result1.intent).toBe(result2.intent);
    });
  });

  describe('getConfigOverrides', () => {
    it('should return overrides for lookup intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const overrides = classifier.getConfigOverrides('lookup');
      expect(overrides.centrality_weight).toBe(0.2);
    });

    it('should return overrides for explanation intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const overrides = classifier.getConfigOverrides('explanation');
      expect(overrides.rrf_k).toBe(45);
    });

    it('should return overrides for architecture intent', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const overrides = classifier.getConfigOverrides('architecture');
      expect(overrides.centrality_weight).toBe(0.3);
    });

    it('should return empty object for unclassified', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const overrides = classifier.getConfigOverrides('unclassified');
      expect(overrides).toEqual({});
    });

    it('should return empty object for recall (no overrides defined)', () => {
      const classifier = new IntentClassifier({ enabled: true });
      const overrides = classifier.getConfigOverrides('recall');
      expect(overrides).toEqual({});
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const classifier = new IntentClassifier({ enabled: false });
      expect(classifier.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      const classifier = new IntentClassifier({ enabled: true });
      expect(classifier.isEnabled()).toBe(true);
    });
  });
});
