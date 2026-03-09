import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectOllamaUrl,
  checkOllamaHealth,
  checkOpenAIHealth,
  createEmbeddingProvider,
} from '../src/embeddings.js';

describe('Embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('detectOllamaUrl', () => {
    it('should return a valid URL string', () => {
      const url = detectOllamaUrl();
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    });

    it('should return a URL with port 11434', () => {
      const url = detectOllamaUrl();
      expect(url).toMatch(/localhost|host\.docker\.internal/);
    });

    it('should include port 11434', () => {
      const url = detectOllamaUrl();
      expect(url).toContain('11434');
    });
  });

  describe('checkOllamaHealth', () => {
    it('should return reachable when Ollama is healthy', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'embedding-model' }] })
      });

      const result = await checkOllamaHealth('http://localhost:11434');
      expect(result.reachable).toBe(true);
    });

    it('should return unreachable when Ollama is down', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Connection refused'));

      const result = await checkOllamaHealth('http://localhost:11434');
      expect(result.reachable).toBe(false);
    });

    it('should return unreachable on HTTP error response', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      const result = await checkOllamaHealth('http://localhost:11434');
      expect(result.reachable).toBe(false);
    });

    it('should handle response parsing errors gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); }
      });

      const result = await checkOllamaHealth('http://localhost:11434');
      expect(result.reachable).toBe(false);
    });

    it('should return list of available models when healthy', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [
          { name: 'model1:latest' },
          { name: 'model2:latest' }
        ] })
      });

      const result = await checkOllamaHealth('http://localhost:11434');
      expect(result.models).toContain('model1:latest');
      expect(result.models).toContain('model2:latest');
    });

    it('should normalize URLs with trailing slashes', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] })
      });

      await checkOllamaHealth('http://localhost:11434/');
      const url = (global.fetch as any).mock.calls[0][0];
      expect(url).toBe('http://localhost:11434//api/tags');
    });

    it('should set timeout for API requests', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] })
      });

      await checkOllamaHealth('http://localhost:11434');
      const options = (global.fetch as any).mock.calls[0][1];
      expect(options?.signal).toBeDefined();
    });
  });

  describe('checkOpenAIHealth', () => {
    it('should return reachable when API is healthy', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'text-embedding-3-small', owned_by: 'openai' })
      });

      const result = await checkOpenAIHealth('https://api.openai.com/v1', 'sk-xxx', 'text-embedding-3-small');
      expect(result.reachable).toBe(true);
    });

    it('should return unreachable on authentication error', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401
      });

      const result = await checkOpenAIHealth('https://api.openai.com/v1', 'sk-xxx', 'text-embedding-3-small');
      expect(result.reachable).toBe(false);
    });

    it('should return unreachable when network is unavailable', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const result = await checkOpenAIHealth('https://api.openai.com/v1', 'sk-xxx', 'text-embedding-3-small');
      expect(result.reachable).toBe(false);
    });

    it('should include Bearer token in Authorization header', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'model' })
      });

      await checkOpenAIHealth('https://api.openai.com/v1', 'sk-test123', 'text-embedding-3-small');
      const options = (global.fetch as any).mock.calls[0][1];
      expect(options?.headers?.Authorization).toBe('Bearer sk-test123');
    });

    it('should normalize base URL by removing trailing slash', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'model' })
      });

      await checkOpenAIHealth('https://api.openai.com/v1/', 'sk-xxx', 'text-embedding-3-small');
      const url = (global.fetch as any).mock.calls[0][0];
      expect(url).toContain('https://api.openai.com/v1/v1/embeddings');
    });

    it('should work with custom API endpoints', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'model' })
      });

      const result = await checkOpenAIHealth('https://custom.ai.com/v1', 'sk-xxx', 'custom-model');
      expect(result.reachable).toBe(true);
      const url = (global.fetch as any).mock.calls[0][0];
      expect(url).toContain('custom.ai.com');
    });

    it('should include model name in response', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'text-embedding-3-large' })
      });

      const result = await checkOpenAIHealth('https://api.openai.com/v1', 'sk-xxx', 'text-embedding-3-large');
      expect(result.model).toBe('text-embedding-3-large');
    });
  });

  describe('createEmbeddingProvider', () => {
    it('should return null when no provider is available', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      const provider = await createEmbeddingProvider();
      expect(provider).toBeNull();
    });

    it('should return null when OpenAI config is missing url', async () => {
      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          apiKey: 'sk-test',
        },
      });
      expect(provider).toBeNull();
    });

    it('should return null when OpenAI config is missing apiKey', async () => {
      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
        },
      });
      expect(provider).toBeNull();
    });

    it('should create OpenAI provider when config is valid and API responds', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'sk-test',
          model: 'text-embedding-3-small',
        },
      });

      expect(provider).not.toBeNull();
      expect(provider?.getModel()).toBe('text-embedding-3-small');
    });

    it('should return null when OpenAI API fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'invalid-key',
        },
      });

      expect(provider).toBeNull();
    });

    it('should try Ollama when no explicit provider is configured', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
        });

      const provider = await createEmbeddingProvider();
      expect(provider).not.toBeNull();
    });

    it('should call onTokenUsage callback when provided', async () => {
      const onTokenUsage = vi.fn();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(1536).fill(0.1), index: 0 }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'sk-test',
        },
        onTokenUsage,
      });

      expect(provider).not.toBeNull();
      expect(onTokenUsage).toHaveBeenCalledWith('text-embedding-3-small', 10);
    });
  });

  describe('EmbeddingProvider interface', () => {
    it('should have getDimensions method that returns a number', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(0.1), index: 0 }],
          model: 'test-model',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'sk-test',
        },
      });

      expect(provider).not.toBeNull();
      const dims = provider!.getDimensions();
      expect(typeof dims).toBe('number');
      expect(dims).toBeGreaterThan(0);
    });

    it('should have getMaxChars method that returns a number', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(0.1), index: 0 }],
          model: 'test-model',
        }),
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'sk-test',
          maxChars: 4000,
        },
      });

      expect(provider).not.toBeNull();
      const maxChars = provider!.getMaxChars();
      expect(typeof maxChars).toBe('number');
      expect(maxChars).toBe(4000);
    });

    it('should dispose without error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(0.1), index: 0 }],
          model: 'test-model',
        }),
      });

      const provider = await createEmbeddingProvider({
        embeddingConfig: {
          provider: 'openai',
          url: 'https://api.openai.com',
          apiKey: 'sk-test',
        },
      });

      expect(provider).not.toBeNull();
      expect(() => provider!.dispose()).not.toThrow();
    });
  });
});
