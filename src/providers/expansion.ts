import { log } from '../logger.js';
import type { LLMProvider } from '../jobs/consolidation.js';

export interface QueryExpander {
  expand(query: string): Promise<string[]>;
  dispose(): void;
}

export interface QueryExpanderOptions {
  modelPath?: string;
  cacheDir?: string;
}

export async function createQueryExpander(
  _options?: QueryExpanderOptions
): Promise<QueryExpander | null> {
  return null;
}

export function createLLMQueryExpander(llmProvider: LLMProvider): QueryExpander {
  return {
    async expand(query: string): Promise<string[]> {
      const prompt = `Generate 2-3 alternative search queries for finding relevant documents.
Return a JSON array of strings only, no explanation.

Original query: ${query}

Response format: ["variant 1", "variant 2"]`;

      try {
        const response = await llmProvider.complete(prompt);
        const text = response.text.trim();
        
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          log('expansion', 'No JSON array found in LLM response');
          return [];
        }
        
        const variants = JSON.parse(jsonMatch[0]) as unknown;
        if (!Array.isArray(variants)) {
          log('expansion', 'LLM response is not an array');
          return [];
        }
        
        const filtered = variants
          .filter((v): v is string => typeof v === 'string')
          .filter(v => v.toLowerCase() !== query.toLowerCase());
        
        log('expansion', 'Generated ' + filtered.length + ' query variants for: ' + query);
        return filtered;
      } catch (err) {
        log('expansion', 'Query expansion failed: ' + (err instanceof Error ? err.message : String(err)));
        return [];
      }
    },
    
    dispose(): void {
    },
  };
}
