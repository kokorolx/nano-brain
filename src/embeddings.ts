import { getLlama } from 'node-llama-cpp';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir, cpus } from 'os';
import type { EmbeddingResult, EmbeddingConfig } from './types.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
  dispose(): void;
}

export interface EmbeddingProviderOptions {
  modelPath?: string;
  cacheDir?: string;
  embeddingConfig?: EmbeddingConfig;
}

const DEFAULT_MODEL_URI = 'hf:nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf';
const MODEL_NAME = 'nomic-embed-text-v1.5';
const DIMENSIONS = 768;

interface ParsedModelURI {
  org: string;
  repo: string;
  file: string;
}

function parseModelURI(uri: string): ParsedModelURI | null {
  const match = uri.match(/^hf:([^/]+)\/([^/]+)\/(.+\.gguf)$/);
  if (!match) return null;
  return {
    org: match[1],
    repo: match[2],
    file: match[3],
  };
}

async function downloadModel(url: string, destPath: string): Promise<void> {
  console.log(`Downloading model from ${url}...`);
  
  await fs.mkdir(dirname(destPath), { recursive: true });
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.statusText}`);
  }
  
  const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
  let downloadedSize = 0;
  
  const tempPath = `${destPath}.tmp`;
  const fileHandle = await fs.open(tempPath, 'w');
  
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      await fileHandle.write(value);
      downloadedSize += value.length;
      
      if (totalSize > 0) {
        const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
        process.stdout.write(`\rDownload progress: ${percent}%`);
      }
    }
    
    console.log('\nDownload complete');
  } finally {
    await fileHandle.close();
  }
  
  await fs.rename(tempPath, destPath);
}

export async function resolveModelPath(
  uri: string,
  cacheDir?: string
): Promise<string> {
  const parsed = parseModelURI(uri);
  if (!parsed) {
    throw new Error(`Invalid model URI format: ${uri}`);
  }
  
  const baseDir = cacheDir || join(homedir(), '.cache', 'opencode-memory', 'models');
  const modelPath = join(baseDir, parsed.org, parsed.repo, parsed.file);
  
  try {
    await fs.access(modelPath);
    return modelPath;
  } catch {
    const url = `https://huggingface.co/${parsed.org}/${parsed.repo}/resolve/main/${parsed.file}`;
    await downloadModel(url, modelPath);
    return modelPath;
  }
}

function formatQueryPrompt(query: string): string {
  return `search_query: ${query}`;
}

function formatDocumentPrompt(title: string, content: string): string {
  return `search_document: ${content}`;
}

// Ollama's truncate:true is broken (github.com/ollama/ollama/issues/14186)
// Client-side truncation: 1800 chars ≈ ~450 tokens, safe for 2048 context
const OLLAMA_MAX_CHARS = 1800;

function truncateForOllama(text: string): string {
  if (text.length <= OLLAMA_MAX_CHARS) return text;
  return text.substring(0, OLLAMA_MAX_CHARS);
}
class OllamaEmbeddingProvider implements EmbeddingProvider {
  private url: string;
  private model: string;
  constructor(url: string, model: string) {
    this.url = url.replace(/\/$/, '');
    this.model = model;
  }
  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: [truncateForOllama(text)],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return {
      embedding: data.embeddings[0],
      model: this.model,
      dimensions: data.embeddings[0].length,
    };
  }
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts.map(truncateForOllama),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedBatch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings.map(emb => ({
      embedding: emb,
      model: this.model,
      dimensions: emb.length,
    }));
  }
  getDimensions(): number {
    return DIMENSIONS;
  }
  getModel(): string {
    return this.model;
  }
  dispose(): void {
  }
}

class EmbeddingProviderImpl implements EmbeddingProvider {
  private contexts: any[] = [];
  private currentContextIndex = 0;
  
  constructor(
    private model: any,
    private parallelism: number
  ) {}
  
  async initialize(): Promise<void> {
    for (let i = 0; i < this.parallelism; i++) {
      const context = await this.model.createEmbeddingContext();
      this.contexts.push(context);
    }
  }
  
  async embed(text: string): Promise<EmbeddingResult> {
    const context = this.contexts[0];
    const result = await context.getEmbeddingFor(text);
    
    return {
      embedding: Array.from(result.vector),
      model: MODEL_NAME,
      dimensions: DIMENSIONS,
    };
  }
  
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    const batchSize = Math.min(4, this.parallelism);
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(async (text, idx) => {
        const contextIdx = idx % this.contexts.length;
        const context = this.contexts[contextIdx];
        const result = await context.getEmbeddingFor(text);
        
        return {
          embedding: Array.from(result.vector) as number[],
          model: MODEL_NAME,
          dimensions: DIMENSIONS,
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }
  
  getDimensions(): number {
    return DIMENSIONS;
  }
  
  getModel(): string {
    return MODEL_NAME;
  }
  
  dispose(): void {
    this.contexts = [];
  }
}

export async function createEmbeddingProvider(
  options?: EmbeddingProviderOptions
): Promise<EmbeddingProvider | null> {
  const config = options?.embeddingConfig;

  // Try Ollama if configured (or by default)
  if (!config || config.provider !== 'local') {
    const url = config?.url || 'http://host.docker.internal:11434';
    const model = config?.model || 'nomic-embed-text';

    try {
      // Health check — verify Ollama is reachable
      const healthResp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (healthResp.ok) {
        const provider = new OllamaEmbeddingProvider(url, model);
        // Verify the model works with a test embed
        await provider.embed('test');
        console.error(`[embedding] Using Ollama provider: ${model} at ${url}`);
        return provider;
      }
    } catch (err) {
      console.warn(`[embedding] Ollama not reachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      if (config?.provider === 'ollama') {
        // Explicitly configured Ollama but it's not available
        console.error('[embedding] Ollama explicitly configured but not reachable, no fallback');
        return null;
      }
      console.warn('[embedding] Falling back to local node-llama-cpp...');
    }
  }

  // Fallback to local node-llama-cpp
  try {
    const modelUri = options?.modelPath || DEFAULT_MODEL_URI;
    const modelPath = await resolveModelPath(modelUri, options?.cacheDir);
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const cpuCount = cpus().length;
    const parallelism = Math.max(1, Math.min(4, Math.floor(cpuCount / 4)));
    const provider = new EmbeddingProviderImpl(model, parallelism);
    await provider.initialize();
    console.error(`[embedding] Using local provider: ${MODEL_NAME}`);
    return provider;
  } catch (error) {
    console.warn('Failed to load embedding model:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export { formatQueryPrompt, formatDocumentPrompt, parseModelURI };
