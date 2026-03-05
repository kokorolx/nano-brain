import { getLlama } from 'node-llama-cpp';
import { promises as fs, accessSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, cpus } from 'os';
import type { EmbeddingResult, EmbeddingConfig } from './types.js';
import { log } from './logger.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
  getMaxChars(): number;
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
  
  const baseDir = cacheDir || join(homedir(), '.nano-brain', 'models');
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


export function detectOllamaUrl(): string {
  const isDocker = (() => {
    try {
      accessSync('/.dockerenv');
      return true;
    } catch {
      try {
        const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
        return cgroup.includes('docker') || cgroup.includes('containerd');
      } catch {
        return false;
      }
    }
  })();
  return isDocker ? 'http://host.docker.internal:11434' : 'http://localhost:11434';
}

export async function checkOllamaHealth(url: string): Promise<{ reachable: boolean; models?: string[]; error?: string }> {
  try {
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (resp.ok) {
      const data = await resp.json() as { models?: Array<{ name: string }> };
      return { reachable: true, models: data.models?.map(m => m.name) || [] };
    }
    return { reachable: false, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkOpenAIHealth(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<{ reachable: boolean; model?: string; error?: string }> {
  const url = baseUrl.replace(/\/$/, '');
  try {
    const resp = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: ['test'],
        input_type: 'query',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      return { reachable: true, model };
    }
    const errorText = await resp.text();
    return { reachable: false, error: errorText || `HTTP ${resp.status}` };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  private url: string;
  private model: string;
  private dimensions: number = DIMENSIONS;
  private maxChars: number = 6000;
  private contextTokens: number = 0;

  constructor(url: string, model: string) {
    this.url = url.replace(/\/$/, '');
    this.model = model;
  }

  async detectModelContext(): Promise<void> {
    try {
      const resp = await fetch(`${this.url}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return;

      const data = await resp.json() as { model_info?: Record<string, any> };
      const modelInfo = data.model_info;
      if (!modelInfo) return;

      const arch = modelInfo['general.architecture'] as string | undefined;
      if (arch) {
        const ctxLen = modelInfo[`${arch}.context_length`] as number | undefined;
        if (ctxLen && ctxLen > 0) {
          this.contextTokens = ctxLen;
          const bufferTokens = 128;
          // BERT WordPiece: ~2 chars/token for code-heavy content (empirically tested)
          this.maxChars = Math.floor((ctxLen - bufferTokens) * 2);
          log('embedding', 'detectModelContext model=' + this.model + ' context=' + ctxLen);
          console.error(`[embedding] Detected ${this.model} context: ${ctxLen} tokens → ${this.maxChars} max chars`);
        }

        const embLen = modelInfo[`${arch}.embedding_length`] as number | undefined;
        if (embLen && embLen > 0) {
          this.dimensions = embLen;
        }
      }
    } catch {
    }
  }

  private truncate(text: string): string {
    if (text.length <= this.maxChars) return text;
    return text.substring(0, this.maxChars);
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: [this.truncate(text)],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    this.dimensions = data.embeddings[0].length;
    return {
      embedding: data.embeddings[0],
      model: this.model,
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts.map(t => this.truncate(t)),
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedBatch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    if (data.embeddings.length > 0) {
      this.dimensions = data.embeddings[0].length;
    }
    return data.embeddings.map(emb => ({
      embedding: emb,
      model: this.model,
      dimensions: emb.length,
    }));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  getMaxChars(): number {
    return this.maxChars;
  }

  dispose(): void {
  }
}

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
};

class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private dimensions: number | null = null;
  private maxChars: number;
  private requestTimestamps: number[] = [];
  private rpmLimit: number;

  constructor(baseUrl: string, model: string, apiKey: string, maxChars?: number, rpmLimit?: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.maxChars = maxChars ?? 8000;
    this.rpmLimit = rpmLimit ?? 40;
  }

  private truncate(text: string): string {
    if (text.length <= this.maxChars) return text;
    return text.substring(0, this.maxChars);
  }

  private setDimensions(embedding: number[]): void {
    if (this.dimensions === null) {
      this.dimensions = embedding.length;
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const windowMs = 60_000;
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < windowMs);
    if (this.requestTimestamps.length >= this.rpmLimit) {
      const oldest = this.requestTimestamps[0];
      const waitMs = windowMs - (now - oldest) + 100;
      log('embedding', 'throttle waiting ms=' + waitMs);
      console.error(`[embedding] Rate limit (${this.rpmLimit} rpm), waiting ${(waitMs / 1000).toFixed(1)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.requestTimestamps.push(Date.now());
  }

  private async fetchWithRetry(body: Record<string, unknown>, timeoutMs: number): Promise<OpenAIEmbeddingResponse> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.throttle();
      const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
        const waitMs = (retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1));
        log('embedding', 'fetchWithRetry 429 retry attempt=' + (attempt + 1) + ' waitMs=' + waitMs);
        console.error(`[embedding] 429 rate limited, retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!response.ok) {
        throw new Error(`OpenAI-compatible embed failed: ${response.status} ${response.statusText}`);
      }

      return await response.json() as OpenAIEmbeddingResponse;
    }
    throw new Error('OpenAI-compatible embed failed: max retries exceeded (429)');
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const data = await this.fetchWithRetry({
      model: this.model,
      input: [this.truncate(text)],
      input_type: 'query',
    }, 30000);

    const embedding = data.data[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI-compatible embed failed: missing embedding');
    }
    this.setDimensions(embedding);
    return {
      embedding,
      model: this.model,
      dimensions: this.dimensions ?? embedding.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const truncated = texts.map(text => this.truncate(text));

    // Sub-batch to stay under API token limits (~100K token budget, ~3 chars/token)
    const maxCharsPerBatch = 200_000;
    const subBatches: string[][] = [];
    let currentBatch: string[] = [];
    let currentChars = 0;

    for (const text of truncated) {
      if (currentBatch.length > 0 && currentChars + text.length > maxCharsPerBatch) {
        subBatches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push(text);
      currentChars += text.length;
    }
    if (currentBatch.length > 0) {
      subBatches.push(currentBatch);
    }

    const allResults: EmbeddingResult[] = [];
    for (const batch of subBatches) {
      const data = await this.fetchWithRetry({
        model: this.model,
        input: batch,
        input_type: 'document',
      }, 120000);

      const batchResults = new Map<number, EmbeddingResult>();
      for (const item of data.data) {
        const embedding = item.embedding;
        if (!embedding) continue;
        this.setDimensions(embedding);
        batchResults.set(item.index, {
          embedding,
          model: this.model,
          dimensions: this.dimensions ?? embedding.length,
        });
      }

      if (batchResults.size !== batch.length) {
        throw new Error('OpenAI-compatible embedBatch failed: missing embeddings');
      }

      for (let i = 0; i < batch.length; i++) {
        const result = batchResults.get(i);
        if (!result) {
          throw new Error('OpenAI-compatible embedBatch failed: missing embedding index');
        }
        allResults.push(result);
      }
    }

    return allResults;
  }

  getDimensions(): number {
    return this.dimensions ?? 0;
  }

  getModel(): string {
    return this.model;
  }

  getMaxChars(): number {
    return this.maxChars;
  }

  getRpmLimit(): number {
    return this.rpmLimit;
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

  getMaxChars(): number {
    return 6000;
  }
  
  dispose(): void {
    this.contexts = [];
  }
}

export async function createEmbeddingProvider(
  options?: EmbeddingProviderOptions
): Promise<EmbeddingProvider | null> {
  const config = options?.embeddingConfig;

  if (config?.provider === 'openai') {
    const url = config.url;
    const apiKey = config.apiKey;
    const model = config.model || 'text-embedding-3-small';

    if (!url || !apiKey) {
      console.error('[embedding] OpenAI-compatible provider requires url and apiKey');
      return null;
    }

    try {
      const provider = new OpenAICompatibleEmbeddingProvider(url, model, apiKey, config.maxChars, config.rpmLimit);
      await provider.embed('test');
      log('embedding', 'createEmbeddingProvider selected=openai model=' + model);
      console.error(`[embedding] Using OpenAI-compatible provider: ${model} at ${url} (${provider.getRpmLimit()} rpm)`);
      return provider;
    } catch (err) {
      log('embedding', 'createEmbeddingProvider openai failed');
      console.error(`[embedding] OpenAI-compatible provider error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Try Ollama if configured (or by default)
  if (!config || config.provider !== 'local') {
    const url = config?.url || detectOllamaUrl();
    const model = config?.model || 'nomic-embed-text';

    try {
      // Health check — verify Ollama is reachable
      const healthResp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10000) });
      if (healthResp.ok) {
        const provider = new OllamaEmbeddingProvider(url, model);
        await provider.detectModelContext();
        await provider.embed('test');
        log('embedding', 'createEmbeddingProvider selected=ollama model=' + model);
        console.error(`[embedding] Using Ollama provider: ${model} at ${url}`);
        return provider;
      }
    } catch (err) {
      console.warn(`[embedding] Ollama not reachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
      if (config?.provider === 'ollama') {
        // Explicitly configured Ollama but it's not available
        log('embedding', 'createEmbeddingProvider ollama failed no-fallback');
        console.error('[embedding] Ollama explicitly configured but not reachable, no fallback');
        return null;
      }
      log('embedding', 'createEmbeddingProvider ollama unreachable fallback=local');
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
    log('embedding', 'createEmbeddingProvider selected=local model=' + MODEL_NAME);
    console.error(`[embedding] Using local provider: ${MODEL_NAME}`);
    return provider;
  } catch (error) {
    log('embedding', 'createEmbeddingProvider local failed');
    console.warn('Failed to load embedding model:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export { formatQueryPrompt, formatDocumentPrompt, parseModelURI };
