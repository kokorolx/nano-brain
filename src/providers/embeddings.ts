import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { EmbeddingResult, EmbeddingConfig } from '../types.js';
import { log } from '../logger.js';
import { resolveHostUrl } from '../host.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
  getMaxChars(): number;
  dispose(): void;
}

export interface EmbeddingProviderOptions {
  embeddingConfig?: EmbeddingConfig;
  onTokenUsage?: (model: string, tokens: number) => void;
}

function formatQueryPrompt(query: string): string {
  return `search_query: ${query}`;
}

function formatDocumentPrompt(title: string, content: string): string {
  return `search_document: ${content}`;
}


export function detectOllamaUrl(): string {
  return resolveHostUrl('http://localhost:11434');
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
  private dimensions: number = 768;
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
          this.maxChars = Math.min(Math.floor((ctxLen - bufferTokens) * 2), 6000);
          log('embed', 'Detected ' + this.model + ' context: ' + ctxLen + ' tokens → ' + this.maxChars + ' max chars');
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
      signal: AbortSignal.timeout(90000),
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

  private async _sendBatch(inputs: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: inputs.map(t => this.truncate(t)),
      }),
      signal: AbortSignal.timeout(180000),
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

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const MAX_CHARS_PER_BATCH = 100_000; // ~25K tokens safety margin
    const MAX_ITEMS_PER_BATCH = 50;      // Also limit item count
    const results: EmbeddingResult[] = [];

    // Split into sub-batches by cumulative character count
    let currentBatch: string[] = [];
    let currentChars = 0;
    let batchCount = 0;

    for (const text of texts) {
      if (currentBatch.length > 0 &&
          (currentChars + text.length > MAX_CHARS_PER_BATCH ||
           currentBatch.length >= MAX_ITEMS_PER_BATCH)) {
        batchCount++;
        const embeddings = await this._sendBatch(currentBatch);
        results.push(...embeddings);
        currentBatch = [];
        currentChars = 0;
      }
      currentBatch.push(text);
      currentChars += text.length;
    }

    // Send remaining
    if (currentBatch.length > 0) {
      batchCount++;
      const embeddings = await this._sendBatch(currentBatch);
      results.push(...embeddings);
    }

    if (batchCount > 1) {
      log('embed', `Ollama sub-batching: ${texts.length} items into ${batchCount} batches`);
    }

    return results;
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
  private outputDimensions: number;
  private maxChars: number;
  private requestTimestamps: number[] = [];
  private rpmLimit: number;
  private onTokenUsage?: (model: string, tokens: number) => void;

  constructor(baseUrl: string, model: string, apiKey: string, maxChars?: number, rpmLimit?: number, onTokenUsage?: (model: string, tokens: number) => void, outputDimensions?: number) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.maxChars = maxChars ?? 8000;
    this.rpmLimit = rpmLimit ?? 40;
    this.onTokenUsage = onTokenUsage;
    this.outputDimensions = outputDimensions ?? 1024;
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
      log('embed', 'Rate limit (' + this.rpmLimit + ' rpm), waiting ' + (waitMs / 1000).toFixed(1) + 's...');
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
        log('embed', '429 rate limited, retrying in ' + (waitMs / 1000).toFixed(1) + 's (attempt ' + (attempt + 1) + '/' + maxRetries + ')');
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
      dimensions: this.outputDimensions,
    }, 10000);

    const embedding = data.data[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI-compatible embed failed: missing embedding');
    }
    this.setDimensions(embedding);
    if (data.usage?.total_tokens && this.onTokenUsage) {
      try { this.onTokenUsage(this.model, data.usage.total_tokens); } catch { /* ignore */ }
    }
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
      try {
        const data = await this.fetchWithRetry({
          model: this.model,
          input: batch,
          input_type: 'document',
          dimensions: this.outputDimensions,
        }, 120000);

        if (data.usage?.total_tokens && this.onTokenUsage) {
          try { this.onTokenUsage(this.model, data.usage.total_tokens); } catch { /* ignore */ }
        }
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

        for (let i = 0; i < batch.length; i++) {
          const result = batchResults.get(i);
          if (!result) {
            // Individual embedding missing — use zero vector as placeholder so other results aren't lost
            log('embeddings', `Sub-batch item ${i} missing embedding, using zero vector`, 'warn');
            allResults.push({
              embedding: new Array(this.dimensions ?? 1024).fill(0),
              model: this.model,
              dimensions: this.dimensions ?? 1024,
            });
          } else {
            allResults.push(result);
          }
        }
      } catch (err) {
        // Sub-batch failed entirely — fill with zero vectors so partial results from other sub-batches are preserved
        log('embeddings', `Sub-batch of ${batch.length} items failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        for (let i = 0; i < batch.length; i++) {
          allResults.push({
            embedding: new Array(this.dimensions ?? 1024).fill(0),
            model: this.model,
            dimensions: this.dimensions ?? 1024,
          });
        }
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

export async function createEmbeddingProvider(
  options?: EmbeddingProviderOptions
): Promise<EmbeddingProvider | null> {
  const config = options?.embeddingConfig;

  if (config?.provider === 'openai') {
    const url = config.url;
    const apiKey = config.apiKey;
    const model = config.model || 'text-embedding-3-small';

    if (!url || !apiKey) {
      log('embed', 'OpenAI-compatible provider requires url and apiKey', 'error');
      return null;
    }

    try {
      const provider = new OpenAICompatibleEmbeddingProvider(url, model, apiKey, config.maxChars, config.rpmLimit, options?.onTokenUsage, config.dimensions);
      await provider.embed('test');
      log('embed', 'Using OpenAI-compatible provider: ' + model + ' at ' + url + ' (' + provider.getRpmLimit() + ' rpm)');
      return provider;
    } catch (err) {
      log('embed', 'OpenAI-compatible provider error: ' + (err instanceof Error ? err.message : String(err)), 'error');
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
        log('embed', 'Using Ollama provider: ' + model + ' at ' + url);
        return provider;
      }
    } catch (err) {
      log('embed', 'Ollama not reachable at ' + url + ': ' + (err instanceof Error ? err.message : String(err)), 'warn');
      if (config?.provider === 'ollama') {
        log('embed', 'Ollama explicitly configured but not reachable, no fallback', 'error');
        return null;
      }
      log('embed', 'Ollama not reachable, no fallback available', 'warn');
    }
  }

  log('embed', 'No embedding provider available. Configure openai or ollama in config.yml', 'error');
  return null;
}

export { formatQueryPrompt, formatDocumentPrompt };
