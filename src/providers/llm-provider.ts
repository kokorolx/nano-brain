import { log } from '../logger.js';
import type { LLMProvider } from '../consolidation.js';
import type { ConsolidationConfig } from '../types.js';

export class OllamaLLMProvider implements LLMProvider {
  public readonly model: string;
  private endpoint: string;

  constructor(options: { endpoint: string; model: string }) {
    this.endpoint = options.endpoint;
    this.model = options.model;
  }

  async complete(prompt: string): Promise<{ text: string; tokensUsed: number }> {
    const url = this.endpoint.endsWith('/api/generate')
      ? this.endpoint
      : `${this.endpoint}/api/generate`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const body = await response.text();
        const truncatedBody = body.length > 200 ? body.substring(0, 200) + '...' : body;
        throw new Error(`HTTP ${response.status}: ${truncatedBody}`);
      }

      const data = await response.json() as {
        response?: string;
        eval_count?: number;
        prompt_eval_count?: number;
      };

      return {
        text: data.response ?? '',
        tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('Request timed out after 120 seconds');
      }
      throw err;
    }
  }
}

export class GitlabDuoLLMProvider implements LLMProvider {
  public readonly model: string;
  private endpoint: string;
  private apiKey: string;

  constructor(options: { endpoint: string; model: string; apiKey: string }) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.apiKey = options.apiKey;
  }

  async complete(prompt: string): Promise<{ text: string; tokensUsed: number }> {
    const url = `${this.endpoint}/v1/chat/completions`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          stream: false,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const body = await response.text();
        const truncatedBody = body.length > 200 ? body.substring(0, 200) + '...' : body;
        throw new Error(`HTTP ${response.status}: ${truncatedBody}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };

      return {
        text: data.choices?.[0]?.message?.content ?? '',
        tokensUsed: data.usage?.total_tokens ?? 0,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('Request timed out after 60 seconds');
      }
      throw err;
    }
  }
}

export function createLLMProvider(config: ConsolidationConfig): LLMProvider | null {
  const apiKey = config.apiKey || process.env.CONSOLIDATION_API_KEY;
  const endpoint = config.endpoint || 'https://ai-proxy.thnkandgrow.com';
  const model = config.model || 'gitlab/claude-haiku-4-5';
  const provider = config.provider;

  const isOllama = provider === 'ollama' || endpoint.includes('/api/generate');

  if (isOllama) {
    log('llm-provider', 'Ollama LLM provider created endpoint=' + endpoint + ' model=' + model);
    return new OllamaLLMProvider({ endpoint, model });
  }

  if (!apiKey) {
    return null;
  }

  log('llm-provider', 'LLM provider created endpoint=' + endpoint + ' model=' + model);
  return new GitlabDuoLLMProvider({ endpoint, model, apiKey });
}

export async function checkLLMHealth(provider: LLMProvider): Promise<{ ok: boolean; model: string; error?: string }> {
  try {
    const result = await provider.complete('Say "ok"');
    return { ok: result.text.length > 0, model: provider.model ?? 'unknown' };
  } catch (err) {
    return { ok: false, model: provider.model ?? 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}
