import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createEmbeddingProvider,
  parseModelURI,
  formatQueryPrompt,
  formatDocumentPrompt,
} from '../src/embeddings.js';
import { createReranker } from '../src/reranker.js';
import { createQueryExpander } from '../src/expansion.js';

vi.mock('node-llama-cpp', () => {
  const mockEmbeddingContext = {
    getEmbeddingFor: vi.fn().mockResolvedValue({
      vector: new Array(384).fill(0.1),
    }),
  };
  
  const mockContext = {
    evaluate: vi.fn().mockResolvedValue({
      logits: [0.5],
      text: '1. alternative query one\n2. alternative query two',
    }),
  };
  
  const mockModel = {
    createEmbeddingContext: vi.fn().mockResolvedValue(mockEmbeddingContext),
    createContext: vi.fn().mockResolvedValue(mockContext),
  };
  
  const mockLlama = {
    loadModel: vi.fn().mockResolvedValue(mockModel),
  };
  
  return {
    getLlama: vi.fn().mockResolvedValue(mockLlama),
  };
});

vi.mock('fs', () => ({
  promises: {
    access: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Model URI Parsing', () => {
  it('should parse valid HuggingFace model URI', () => {
    const uri = 'hf:nicoboss/EmbeddingGemma-300M-GGUF/EmbeddingGemma-300M-Q8_0.gguf';
    const parsed = parseModelURI(uri);
    
    expect(parsed).toEqual({
      org: 'nicoboss',
      repo: 'EmbeddingGemma-300M-GGUF',
      file: 'EmbeddingGemma-300M-Q8_0.gguf',
    });
  });
  
  it('should return null for invalid URI format', () => {
    const uri = 'invalid-uri';
    const parsed = parseModelURI(uri);
    
    expect(parsed).toBeNull();
  });
  
  it('should parse reranker model URI', () => {
    const uri = 'hf:nicoboss/Qwen3-Reranker-0.6B-GGUF/Qwen3-Reranker-0.6B-Q8_0.gguf';
    const parsed = parseModelURI(uri);
    
    expect(parsed).toEqual({
      org: 'nicoboss',
      repo: 'Qwen3-Reranker-0.6B-GGUF',
      file: 'Qwen3-Reranker-0.6B-Q8_0.gguf',
    });
  });
  
  it('should parse query expander model URI', () => {
    const uri = 'hf:tobi/qmd-query-expansion-1.7B-GGUF/qmd-query-expansion-1.7B-Q8_0.gguf';
    const parsed = parseModelURI(uri);
    
    expect(parsed).toEqual({
      org: 'tobi',
      repo: 'qmd-query-expansion-1.7B-GGUF',
      file: 'qmd-query-expansion-1.7B-Q8_0.gguf',
    });
  });
});

describe('Prompt Formatting', () => {
  it('should format query prompt correctly', () => {
    const query = 'test search query';
    const formatted = formatQueryPrompt(query);
    
    expect(formatted).toBe('task: search result | query: test search query');
  });
  
  it('should format document prompt correctly', () => {
    const title = 'Document Title';
    const content = 'Document content here';
    const formatted = formatDocumentPrompt(title, content);
    
    expect(formatted).toBe('title: Document Title | text: Document content here');
  });
});

describe('EmbeddingProvider', () => {
  it('should create embedding provider successfully', async () => {
    const provider = await createEmbeddingProvider();
    
    expect(provider).not.toBeNull();
    expect(provider?.getDimensions()).toBe(384);
    expect(provider?.getModel()).toBe('EmbeddingGemma-300M');
  });
  
  it('should embed single text', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).not.toBeNull();
    
    if (provider) {
      const result = await provider.embed('test text');
      
      expect(result).toHaveProperty('embedding');
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('dimensions');
      expect(result.embedding).toHaveLength(384);
      expect(result.model).toBe('EmbeddingGemma-300M');
      expect(result.dimensions).toBe(384);
    }
  });
  
  it('should embed batch of texts', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).not.toBeNull();
    
    if (provider) {
      const texts = ['text 1', 'text 2', 'text 3'];
      const results = await provider.embedBatch(texts);
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.embedding).toHaveLength(384);
        expect(result.model).toBe('EmbeddingGemma-300M');
        expect(result.dimensions).toBe(384);
      });
    }
  });
  
  it('should return correct dimensions', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).not.toBeNull();
    
    if (provider) {
      expect(provider.getDimensions()).toBe(384);
    }
  });
  
  it('should return correct model name', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).not.toBeNull();
    
    if (provider) {
      expect(provider.getModel()).toBe('EmbeddingGemma-300M');
    }
  });
  
  it('should have dispose method', async () => {
    const provider = await createEmbeddingProvider();
    expect(provider).not.toBeNull();
    
    if (provider) {
      expect(provider.dispose).toBeDefined();
      expect(typeof provider.dispose).toBe('function');
      provider.dispose();
    }
  });
});

describe('Reranker', () => {
  it('should create reranker successfully', async () => {
    const reranker = await createReranker();
    
    expect(reranker).not.toBeNull();
  });
  
  it('should rerank documents', async () => {
    const reranker = await createReranker();
    expect(reranker).not.toBeNull();
    
    if (reranker) {
      const query = 'test query';
      const documents = [
        { text: 'document 1', file: 'file1.ts', index: 0 },
        { text: 'document 2', file: 'file2.ts', index: 1 },
        { text: 'document 3', file: 'file3.ts', index: 2 },
      ];
      
      const result = await reranker.rerank(query, documents);
      
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('model');
      expect(result.model).toBe('Qwen3-Reranker-0.6B');
      expect(result.results).toHaveLength(3);
      
      result.results.forEach(item => {
        expect(item).toHaveProperty('file');
        expect(item).toHaveProperty('score');
        expect(item).toHaveProperty('index');
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.score).toBeLessThanOrEqual(1);
      });
    }
  });
  
  it('should sort results by score descending', async () => {
    const reranker = await createReranker();
    expect(reranker).not.toBeNull();
    
    if (reranker) {
      const query = 'test query';
      const documents = [
        { text: 'document 1', file: 'file1.ts', index: 0 },
        { text: 'document 2', file: 'file2.ts', index: 1 },
      ];
      
      const result = await reranker.rerank(query, documents);
      
      for (let i = 0; i < result.results.length - 1; i++) {
        expect(result.results[i].score).toBeGreaterThanOrEqual(result.results[i + 1].score);
      }
    }
  });
  
  it('should have dispose method', async () => {
    const reranker = await createReranker();
    expect(reranker).not.toBeNull();
    
    if (reranker) {
      expect(reranker.dispose).toBeDefined();
      expect(typeof reranker.dispose).toBe('function');
      reranker.dispose();
    }
  });
});

describe('QueryExpander', () => {
  it('should create query expander successfully', async () => {
    const expander = await createQueryExpander();
    
    expect(expander).not.toBeNull();
  });
  
  it('should expand query into variants', async () => {
    const expander = await createQueryExpander();
    expect(expander).not.toBeNull();
    
    if (expander) {
      const query = 'test query';
      const variants = await expander.expand(query);
      
      expect(Array.isArray(variants)).toBe(true);
      expect(variants.length).toBeGreaterThanOrEqual(1);
      expect(variants.length).toBeLessThanOrEqual(2);
    }
  });
  
  it('should return 2 variants when successful', async () => {
    const expander = await createQueryExpander();
    expect(expander).not.toBeNull();
    
    if (expander) {
      const query = 'search for something';
      const variants = await expander.expand(query);
      
      expect(variants.length).toBe(2);
      variants.forEach(variant => {
        expect(typeof variant).toBe('string');
        expect(variant.length).toBeGreaterThan(0);
      });
    }
  });
  
  it('should have dispose method', async () => {
    const expander = await createQueryExpander();
    expect(expander).not.toBeNull();
    
    if (expander) {
      expect(expander.dispose).toBeDefined();
      expect(typeof expander.dispose).toBe('function');
      expander.dispose();
    }
  });
});

describe('Graceful Fallback', () => {
  it('should return null when embedding model fails to load', async () => {
    const { getLlama } = await import('node-llama-cpp');
    vi.mocked(getLlama).mockRejectedValueOnce(new Error('Model not found'));
    
    const provider = await createEmbeddingProvider();
    expect(provider).toBeNull();
  });
  
  it('should return null when reranker model fails to load', async () => {
    const { getLlama } = await import('node-llama-cpp');
    vi.mocked(getLlama).mockRejectedValueOnce(new Error('Model not found'));
    
    const reranker = await createReranker();
    expect(reranker).toBeNull();
  });
  
  it('should return null when query expander model fails to load', async () => {
    const { getLlama } = await import('node-llama-cpp');
    vi.mocked(getLlama).mockRejectedValueOnce(new Error('Model not found'));
    
    const expander = await createQueryExpander();
    expect(expander).toBeNull();
  });
});
