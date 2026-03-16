import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMQueryExpander } from '../src/expansion.js';
import type { LLMProvider } from '../src/consolidation.js';

describe('createLLMQueryExpander', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return query variants from valid JSON response', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: '["authentication flow", "login process"]',
        tokensUsed: 50,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('auth');

    expect(variants).toEqual(['authentication flow', 'login process']);
    expect(mockProvider.complete).toHaveBeenCalledOnce();
  });

  it('should extract JSON array from response with extra text', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: 'Here are the variants:\n["variant one", "variant two"]\nDone.',
        tokensUsed: 60,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('test query');

    expect(variants).toEqual(['variant one', 'variant two']);
  });

  it('should return empty array when LLM returns invalid JSON', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: 'not valid json at all',
        tokensUsed: 20,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('test');

    expect(variants).toEqual([]);
  });

  it('should return empty array when LLM throws error', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('test');

    expect(variants).toEqual([]);
  });

  it('should filter out variants that match original query (case-insensitive)', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: '["Auth", "authentication", "login"]',
        tokensUsed: 40,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('auth');

    expect(variants).toEqual(['authentication', 'login']);
    expect(variants).not.toContain('Auth');
  });

  it('should filter out non-string values from array', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: '["valid", 123, null, "also valid"]',
        tokensUsed: 30,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('test');

    expect(variants).toEqual(['valid', 'also valid']);
  });

  it('should extract array even when embedded in object', async () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn().mockResolvedValue({
        text: '{"variants": ["a", "b"]}',
        tokensUsed: 25,
      }),
    };

    const expander = createLLMQueryExpander(mockProvider);
    const variants = await expander.expand('test');

    expect(variants).toEqual(['a', 'b']);
  });

  it('dispose should be a no-op', () => {
    const mockProvider: LLMProvider = {
      model: 'test-model',
      complete: vi.fn(),
    };

    const expander = createLLMQueryExpander(mockProvider);
    expect(() => expander.dispose()).not.toThrow();
  });
});
