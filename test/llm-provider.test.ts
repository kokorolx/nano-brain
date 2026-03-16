import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitlabDuoLLMProvider, OllamaLLMProvider, createLLMProvider, checkLLMHealth } from '../src/llm-provider.js';
import type { ConsolidationConfig } from '../src/types.js';
import type { LLMProvider } from '../src/consolidation.js';

describe('OllamaLLMProvider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('complete', () => {
    it('should return text and tokensUsed on success', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          response: 'Hello from Ollama',
          eval_count: 30,
          prompt_eval_count: 12,
        }),
      });

      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434',
        model: 'llama3',
      });

      const result = await provider.complete('test prompt');

      expect(result.text).toBe('Hello from Ollama');
      expect(result.tokensUsed).toBe(42);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should handle endpoint with /api/generate suffix', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ response: 'ok', eval_count: 5, prompt_eval_count: 3 }),
      });

      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434/api/generate',
        model: 'llama3',
      });

      await provider.complete('test');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything()
      );
    });

    it('should throw on HTTP error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434',
        model: 'llama3',
      });

      await expect(provider.complete('test')).rejects.toThrow('HTTP 500');
    });

    it('should throw on timeout', async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        const error = new Error('Timeout');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      });

      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434',
        model: 'llama3',
      });

      await expect(provider.complete('test')).rejects.toThrow('Request timed out after 120 seconds');
    });

    it('should handle missing response field', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434',
        model: 'llama3',
      });

      const result = await provider.complete('test');
      expect(result.text).toBe('');
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe('model property', () => {
    it('should expose model as readonly property', () => {
      const provider = new OllamaLLMProvider({
        endpoint: 'http://localhost:11434',
        model: 'mistral',
      });

      expect(provider.model).toBe('mistral');
    });
  });
});

describe('GitlabDuoLLMProvider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('complete', () => {
    it('should return text and tokensUsed on success', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Hello world' } }],
          usage: { total_tokens: 42 },
        }),
      });

      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'test-model',
        apiKey: 'test-key',
      });

      const result = await provider.complete('test prompt');

      expect(result.text).toBe('Hello world');
      expect(result.tokensUsed).toBe(42);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.example.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('should throw on HTTP error with truncated body', async () => {
      const longBody = 'x'.repeat(300);
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(longBody),
      });

      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'test-model',
        apiKey: 'test-key',
      });

      await expect(provider.complete('test')).rejects.toThrow('HTTP 500');
    });

    it('should throw on timeout', async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        const error = new Error('Timeout');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      });

      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'test-model',
        apiKey: 'test-key',
      });

      await expect(provider.complete('test')).rejects.toThrow('Request timed out after 60 seconds');
    });

    it('should handle empty choices', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      });

      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'test-model',
        apiKey: 'test-key',
      });

      const result = await provider.complete('test');
      expect(result.text).toBe('');
      expect(result.tokensUsed).toBe(0);
    });

    it('should handle missing usage field', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'response' } }],
        }),
      });

      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'test-model',
        apiKey: 'test-key',
      });

      const result = await provider.complete('test');
      expect(result.text).toBe('response');
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe('model property', () => {
    it('should expose model as readonly property', () => {
      const provider = new GitlabDuoLLMProvider({
        endpoint: 'https://test.example.com',
        model: 'my-model',
        apiKey: 'test-key',
      });

      expect(provider.model).toBe('my-model');
    });
  });
});

describe('createLLMProvider', () => {
  const originalEnv = process.env.CONSOLIDATION_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CONSOLIDATION_API_KEY = originalEnv;
    } else {
      delete process.env.CONSOLIDATION_API_KEY;
    }
  });

  it('should return null when no apiKey', () => {
    delete process.env.CONSOLIDATION_API_KEY;
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'test-model',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).toBeNull();
  });

  it('should use env var for apiKey when not in config', () => {
    process.env.CONSOLIDATION_API_KEY = 'env-api-key';
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'test-model',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
    expect(provider?.model).toBe('test-model');
  });

  it('should use config apiKey over env var', () => {
    process.env.CONSOLIDATION_API_KEY = 'env-api-key';
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'config-model',
      apiKey: 'config-api-key',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
  });

  it('should use default endpoint and model when not specified', () => {
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: '',
      apiKey: 'test-key',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
    expect(provider?.model).toBe('litellm/claude-haiku-4-5');
  });

  it('should use custom endpoint and model from config', () => {
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'custom-model',
      endpoint: 'https://custom.example.com',
      apiKey: 'test-key',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
    expect(provider?.model).toBe('custom-model');
  });

  it('should create OllamaLLMProvider when provider is ollama', () => {
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'llama3',
      endpoint: 'http://localhost:11434',
      provider: 'ollama',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OllamaLLMProvider);
    expect(provider?.model).toBe('llama3');
  });

  it('should create OllamaLLMProvider when endpoint contains /api/generate', () => {
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'mistral',
      endpoint: 'http://localhost:11434/api/generate',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(OllamaLLMProvider);
  });

  it('should not require apiKey for Ollama provider', () => {
    delete process.env.CONSOLIDATION_API_KEY;
    const config: ConsolidationConfig = {
      enabled: true,
      interval_ms: 3600000,
      model: 'llama3',
      endpoint: 'http://localhost:11434',
      provider: 'ollama',
      max_memories_per_cycle: 20,
      min_memories_threshold: 2,
      confidence_threshold: 0.6,
    };

    const provider = createLLMProvider(config);
    expect(provider).not.toBeNull();
  });
});

describe('checkLLMHealth', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return ok: true when provider responds', async () => {
    const mockProvider: LLMProvider = {
      complete: vi.fn().mockResolvedValue({ text: 'ok', tokensUsed: 5 }),
      model: 'test-model',
    };

    const result = await checkLLMHealth(mockProvider);
    expect(result.ok).toBe(true);
    expect(result.model).toBe('test-model');
    expect(result.error).toBeUndefined();
  });

  it('should return ok: false when provider returns empty text', async () => {
    const mockProvider: LLMProvider = {
      complete: vi.fn().mockResolvedValue({ text: '', tokensUsed: 0 }),
      model: 'test-model',
    };

    const result = await checkLLMHealth(mockProvider);
    expect(result.ok).toBe(false);
    expect(result.model).toBe('test-model');
  });

  it('should return ok: false with error when provider throws', async () => {
    const mockProvider: LLMProvider = {
      complete: vi.fn().mockRejectedValue(new Error('Connection refused')),
      model: 'test-model',
    };

    const result = await checkLLMHealth(mockProvider);
    expect(result.ok).toBe(false);
    expect(result.model).toBe('test-model');
    expect(result.error).toBe('Connection refused');
  });

  it('should handle provider without model property', async () => {
    const mockProvider: LLMProvider = {
      complete: vi.fn().mockResolvedValue({ text: 'ok', tokensUsed: 5 }),
    };

    const result = await checkLLMHealth(mockProvider);
    expect(result.ok).toBe(true);
    expect(result.model).toBe('unknown');
  });
});
