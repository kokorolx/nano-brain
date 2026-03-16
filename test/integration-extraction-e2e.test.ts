import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractFactsFromSession,
  storeExtractedFact,
  extractAndStoreFacts,
  computeFactHash,
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
  complete: vi.fn().mockResolvedValue({ text: response, tokensUsed: 100 }),
  model: 'test-model',
});

describe('Integration: Extraction E2E Flow', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-extraction-e2e-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should extract facts from session and store them', async () => {
    const llmResponse = JSON.stringify([
      { content: 'Use Redis Streams for job queues', category: 'technology-choice' },
      { content: 'Always wrap DB calls in retry logic', category: 'coding-pattern' },
      { content: 'ECONNREFUSED means container not started', category: 'debugging-insight' },
    ]);
    const provider = createMockLLMProvider(llmResponse);
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, maxFactsPerSession: 10 };

    const sessionContent = `
User: How should we handle job processing?
Assistant: I recommend using Redis Streams instead of Bull queues for better reliability.

User: What about database errors?
Assistant: Always wrap database calls in retry logic with exponential backoff.

User: I'm getting ECONNREFUSED on port 6379
Assistant: That usually means the Redis container hasn't started yet.
`;

    const result = await extractAndStoreFacts(
      sessionContent,
      'session-abc123',
      'project-xyz',
      provider,
      config,
      store
    );

    expect(result.facts).toHaveLength(3);
    expect(result.stored).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.tokensUsed).toBe(100);

    const hash1 = computeFactHash('Use Redis Streams for job queues');
    const doc1 = store.findDocument('auto:extracted-fact:' + hash1);
    expect(doc1).not.toBeNull();
    expect(doc1?.collection).toBe('memory');

    const tags1 = store.getDocumentTags(doc1!.id);
    expect(tags1).toContain('auto:extracted-fact');
    expect(tags1).toContain('category:technology-choice');
    expect(tags1).toContain('source:session:session-abc123');
  });

  it('should detect and skip duplicate facts', async () => {
    const llmResponse = JSON.stringify([
      { content: 'Use TypeScript strict mode', category: 'preference' },
    ]);
    const provider = createMockLLMProvider(llmResponse);
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

    const result1 = await extractAndStoreFacts(
      'Session 1 content',
      'session-001',
      'project-xyz',
      provider,
      config,
      store
    );

    expect(result1.stored).toBe(1);
    expect(result1.duplicates).toBe(0);

    const result2 = await extractAndStoreFacts(
      'Session 2 content',
      'session-002',
      'project-xyz',
      provider,
      config,
      store
    );

    expect(result2.stored).toBe(0);
    expect(result2.duplicates).toBe(1);
  });

  it('should handle case-insensitive duplicate detection', async () => {
    const fact1: ExtractedFact = { content: 'Use Redis for caching', category: 'technology-choice' };
    const fact2: ExtractedFact = { content: 'USE REDIS FOR CACHING', category: 'technology-choice' };

    const stored1 = storeExtractedFact(store, fact1, 'session-1', 'project-1');
    const stored2 = storeExtractedFact(store, fact2, 'session-2', 'project-1');

    expect(stored1).toBe(true);
    expect(stored2).toBe(false);
  });

  it('should store facts with correct tags for each category', async () => {
    const categories = [
      'architecture-decision',
      'technology-choice',
      'coding-pattern',
      'preference',
      'debugging-insight',
      'config-detail',
    ] as const;

    for (const category of categories) {
      const fact: ExtractedFact = { content: `Fact for ${category}`, category };
      storeExtractedFact(store, fact, 'session-test', 'project-test');

      const hash = computeFactHash(fact.content);
      const doc = store.findDocument('auto:extracted-fact:' + hash);
      expect(doc).not.toBeNull();

      const tags = store.getDocumentTags(doc!.id);
      expect(tags).toContain(`category:${category}`);
    }
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
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, maxFactsPerSession: 2 };

    const result = await extractAndStoreFacts(
      'Session content',
      'session-limit',
      'project-limit',
      provider,
      config,
      store
    );

    expect(result.facts).toHaveLength(2);
    expect(result.stored).toBe(2);
  });

  it('should handle LLM returning invalid JSON gracefully', async () => {
    const provider = createMockLLMProvider('This is not valid JSON');
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

    const result = await extractAndStoreFacts(
      'Session content',
      'session-invalid',
      'project-invalid',
      provider,
      config,
      store
    );

    expect(result.facts).toHaveLength(0);
    expect(result.stored).toBe(0);
    expect(result.duplicates).toBe(0);
  });

  it('should filter out facts with invalid categories', async () => {
    const llmResponse = JSON.stringify([
      { content: 'Valid fact', category: 'preference' },
      { content: 'Invalid category fact', category: 'not-a-real-category' },
      { content: 'Another valid fact', category: 'debugging-insight' },
    ]);
    const provider = createMockLLMProvider(llmResponse);
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

    const result = await extractAndStoreFacts(
      'Session content',
      'session-filter',
      'project-filter',
      provider,
      config,
      store
    );

    expect(result.facts).toHaveLength(2);
    expect(result.stored).toBe(2);
  });

  it('should verify facts are searchable via FTS', async () => {
    const llmResponse = JSON.stringify([
      { content: 'Use PostgreSQL for relational data', category: 'technology-choice' },
    ]);
    const provider = createMockLLMProvider(llmResponse);
    const config: ExtractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true };

    await extractAndStoreFacts(
      'Session content',
      'session-fts',
      'project-fts',
      provider,
      config,
      store
    );

    const results = store.searchFTS('PostgreSQL relational', { limit: 10, collection: 'memory' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('technology-choice');
  });
});
