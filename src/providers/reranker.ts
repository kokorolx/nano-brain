import type { RerankResult, RerankDocument } from '../types.js';
import { log } from '../logger.js';

export interface Reranker {
  rerank(query: string, documents: RerankDocument[]): Promise<RerankResult>;
  dispose(): void;
}

export interface RerankerOptions {
  apiKey?: string;
  model?: string;
  onTokenUsage?: (model: string, tokens: number) => void;
}

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const DEFAULT_MODEL = 'rerank-2.5-lite';

class VoyageAIReranker implements Reranker {
  private apiKey: string;
  private model: string;
  private onTokenUsage?: (model: string, tokens: number) => void;

  constructor(apiKey: string, model: string, onTokenUsage?: (model: string, tokens: number) => void) {
    this.apiKey = apiKey;
    this.model = model;
    this.onTokenUsage = onTokenUsage;
  }

  async rerank(query: string, documents: RerankDocument[]): Promise<RerankResult> {
    if (documents.length === 0) {
      return { results: [], model: this.model };
    }

    try {
      const response = await fetch(VOYAGE_RERANK_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          documents: documents.map(d => d.text),
          model: this.model,
          top_k: documents.length,
          truncation: true,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log('reranker', `VoyageAI rerank failed: HTTP ${response.status} ${body}`, 'warn');
        return { results: [], model: this.model };
      }

      const data = await response.json() as {
        results: Array<{ index: number; relevance_score: number }>;
        total_tokens: number;
      };

      if (this.onTokenUsage && data.total_tokens) {
        this.onTokenUsage(this.model, data.total_tokens);
      }

      if (!data.results || !Array.isArray(data.results)) {
        log('reranker', `VoyageAI rerank returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`, 'warn');
        return { results: [], model: this.model };
      }

      const results = data.results
        .filter(r => r.index >= 0 && r.index < documents.length)
        .map(r => ({
          file: documents[r.index].file,
          score: r.relevance_score,
          index: r.index,
        }));

      log('reranker', `VoyageAI rerank model=${this.model} docs=${documents.length} tokens=${data.total_tokens}`, 'debug');

      return { results, model: this.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('reranker', `VoyageAI rerank error: ${msg}`, 'warn');
      return { results: [], model: this.model };
    }
  }

  dispose(): void {}
}

export async function createReranker(
  options?: RerankerOptions
): Promise<Reranker | null> {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    log('reranker', 'No API key configured — reranking disabled');
    return null;
  }

  const model = options?.model || DEFAULT_MODEL;
  log('reranker', `VoyageAI reranker initialized model=${model}`);
  return new VoyageAIReranker(apiKey, model, options?.onTokenUsage);
}
