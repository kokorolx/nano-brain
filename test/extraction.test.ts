import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseExtractionResponse,
  computeFactHash,
  storeExtractedFact,
  extractFactsFromSession,
  validateExtractionConfig,
  type ExtractedFact,
} from '../src/extraction.js';
import type { LLMProvider } from '../src/consolidation.js';
import { createStore } from '../src/store.js';
import type { Store, ExtractionConfig } from '../src/types.js';
import { DEFAULT_EXTRACTION_CONFIG } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const createMockLLMProvider = (response: string): LLMProvider => ({
  complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 50 }),
  model: 'test-model',
});

describe('Extraction', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-extraction-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('validateExtractionConfig', () => {
    it('should pass for disabled config', () => {
      const result = validateExtractionConfig({ enabled: false });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when enabled without model', () => {
      const result = validateExtractionConfig({ enabled: true, model: '', apiKey: 'key' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('model must be non-empty when extraction is enabled');
    });

    it('should fail when enabled without apiKey', () => {
      const result = validateExtractionConfig({ enabled: true, model: 'test-model' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('apiKey must be set (or CONSOLIDATION_API_KEY env var) when extraction is enabled');
    });

    it('should pass when enabled with model and apiKey', () => {
      const result = validateExtractionConfig({ enabled: true, model: 'test-model', apiKey: 'key' });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass when enabled with CONSOLIDATION_API_KEY env var', () => {
      const originalEnv = process.env.CONSOLIDATION_API_KEY;
      process.env.CONSOLIDATION_API_KEY = 'env-key';
      try {
        const result = validateExtractionConfig({ enabled: true, model: 'test-model' });
        expect(result.valid).toBe(true);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CONSOLIDATION_API_KEY;
        } else {
          process.env.CONSOLIDATION_API_KEY = originalEnv;
        }
      }
    });

    it('should fail when maxFactsPerSession is 0', () => {
      const result = validateExtractionConfig({ maxFactsPerSession: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxFactsPerSession must be > 0');
    });

    it('should fail when maxFactsPerSession is negative', () => {
      const result = validateExtractionConfig({ maxFactsPerSession: -5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('maxFactsPerSession must be > 0');
    });
  });

  describe('parseExtractionResponse', () => {
    it('should parse valid JSON array', () => {
      const response = JSON.stringify([
        { content: 'Use Redis for caching', category: 'technology-choice' },
        { content: 'Always use Result types', category: 'coding-pattern' },
      ]);
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(2);
      expect(facts[0].content).toBe('Use Redis for caching');
      expect(facts[0].category).toBe('technology-choice');
      expect(facts[1].content).toBe('Always use Result types');
      expect(facts[1].category).toBe('coding-pattern');
    });

    it('should handle JSON with surrounding text', () => {
      const response = 'Here are the facts:\n[{"content": "Test fact", "category": "preference"}]\nEnd of facts.';
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('Test fact');
    });

    it('should return empty array for malformed JSON', () => {
      const facts = parseExtractionResponse('not valid json');
      expect(facts).toHaveLength(0);
    });

    it('should return empty array for non-array JSON', () => {
      const facts = parseExtractionResponse('{"content": "test"}');
      expect(facts).toHaveLength(0);
    });

    it('should filter out invalid categories', () => {
      const response = JSON.stringify([
        { content: 'Valid fact', category: 'preference' },
        { content: 'Invalid category', category: 'invalid-category' },
      ]);
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(1);
      expect(facts[0].category).toBe('preference');
    });

    it('should filter out empty content', () => {
      const response = JSON.stringify([
        { content: '', category: 'preference' },
        { content: '   ', category: 'preference' },
        { content: 'Valid', category: 'preference' },
      ]);
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(1);
      expect(facts[0].content).toBe('Valid');
    });

    it('should filter out non-string content', () => {
      const response = JSON.stringify([
        { content: 123, category: 'preference' },
        { content: null, category: 'preference' },
        { content: 'Valid', category: 'preference' },
      ]);
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(1);
    });

    it('should accept all valid categories', () => {
      const categories = [
        'architecture-decision',
        'technology-choice',
        'coding-pattern',
        'preference',
        'debugging-insight',
        'config-detail',
      ];
      const response = JSON.stringify(
        categories.map((cat, i) => ({ content: `Fact ${i}`, category: cat }))
      );
      const facts = parseExtractionResponse(response);
      expect(facts).toHaveLength(6);
    });
  });

  describe('computeFactHash', () => {
    it('should produce consistent hashes', () => {
      const hash1 = computeFactHash('Use Redis for caching');
      const hash2 = computeFactHash('Use Redis for caching');
      expect(hash1).toBe(hash2);
    });

    it('should normalize content (trim and lowercase)', () => {
      const hash1 = computeFactHash('Use Redis');
      const hash2 = computeFactHash('  USE REDIS  ');
      expect(hash1).toBe(hash2);
    });

    it('should return 16 character hex string', () => {
      const hash = computeFactHash('test content');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = computeFactHash('content one');
      const hash2 = computeFactHash('content two');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('storeExtractedFact', () => {
    it('should insert new fact and return true', () => {
      const fact: ExtractedFact = {
        content: 'Use Redis for caching',
        category: 'technology-choice',
      };
      const result = storeExtractedFact(store, fact, 'session-123', 'project-abc');
      expect(result).toBe(true);

      const hash = computeFactHash(fact.content);
      const doc = store.findDocument('auto:extracted-fact:' + hash);
      expect(doc).not.toBeNull();
      expect(doc?.collection).toBe('memory');
      expect(doc?.title).toContain('technology-choice');
    });

    it('should detect duplicate and return false', () => {
      const fact: ExtractedFact = {
        content: 'Use Redis for caching',
        category: 'technology-choice',
      };
      const result1 = storeExtractedFact(store, fact, 'session-123', 'project-abc');
      const result2 = storeExtractedFact(store, fact, 'session-456', 'project-abc');
      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('should add correct tags', () => {
      const fact: ExtractedFact = {
        content: 'Always use Result types',
        category: 'coding-pattern',
      };
      storeExtractedFact(store, fact, 'session-789', 'project-xyz');

      const hash = computeFactHash(fact.content);
      const doc = store.findDocument('auto:extracted-fact:' + hash);
      expect(doc).not.toBeNull();

      const tags = store.getDocumentTags(doc!.id);
      expect(tags).toContain('auto:extracted-fact');
      expect(tags).toContain('category:coding-pattern');
      expect(tags).toContain('source:session:session-789');
    });
  });

  describe('extractFactsFromSession', () => {
    it('should call LLM provider and parse response', async () => {
      const llmResponse = JSON.stringify([
        { content: 'Fact 1', category: 'preference' },
        { content: 'Fact 2', category: 'debugging-insight' },
      ]);
      const provider = createMockLLMProvider(llmResponse);
      const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, maxFactsPerSession: 10 };

      const result = await extractFactsFromSession('Session content here', provider, config);

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(result.facts).toHaveLength(2);
      expect(result.tokensUsed).toBe(50);
    });

    it('should limit facts to maxFactsPerSession', async () => {
      const llmResponse = JSON.stringify([
        { content: 'Fact 1', category: 'preference' },
        { content: 'Fact 2', category: 'preference' },
        { content: 'Fact 3', category: 'preference' },
        { content: 'Fact 4', category: 'preference' },
        { content: 'Fact 5', category: 'preference' },
      ]);
      const provider = createMockLLMProvider(llmResponse);
      const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, maxFactsPerSession: 3 };

      const result = await extractFactsFromSession('Session content', provider, config);

      expect(result.facts).toHaveLength(3);
    });

    it('should handle empty response', async () => {
      const provider = createMockLLMProvider('[]');
      const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

      const result = await extractFactsFromSession('Session content', provider, config);

      expect(result.facts).toHaveLength(0);
    });

    it('should handle malformed response', async () => {
      const provider = createMockLLMProvider('not json');
      const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

      const result = await extractFactsFromSession('Session content', provider, config);

      expect(result.facts).toHaveLength(0);
    });
  });
});
