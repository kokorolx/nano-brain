import type { LLMProvider } from './consolidation.js';
import type { LLMCategorizationConfig } from './types.js';
import { log } from './logger.js';

export const VALID_CATEGORIES = [
  'architecture-decision',
  'debugging-insight',
  'tool-config',
  'pattern',
  'preference',
  'context',
  'workflow',
] as const;

export type ValidCategory = typeof VALID_CATEGORIES[number];

const VALID_CATEGORIES_SET = new Set<string>(VALID_CATEGORIES);

export interface CategoryResult {
  name: string;
  confidence: number;
}

export function categorizationPrompt(content: string, maxLength: number): string {
  const truncated = content.length > maxLength ? content.substring(0, maxLength) : content;
  return `Categorize this memory into 1-3 categories. Return JSON only.
Categories: architecture-decision, debugging-insight, tool-config, pattern, preference, context, workflow

Memory:
${truncated}

Response format: {"categories": [{"name": "...", "confidence": 0.0-1.0}]}`;
}

export function parseCategorizationResponse(text: string): CategoryResult[] {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log('llm-categorizer', 'No JSON found in response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.categories || !Array.isArray(parsed.categories)) {
      log('llm-categorizer', 'No categories array in response');
      return [];
    }

    const results: CategoryResult[] = [];
    for (const item of parsed.categories) {
      if (typeof item.name !== 'string' || typeof item.confidence !== 'number') {
        continue;
      }
      const name = item.name.toLowerCase().trim();
      if (!VALID_CATEGORIES_SET.has(name)) {
        log('llm-categorizer', 'Rejected unknown category: ' + name);
        continue;
      }
      const confidence = Math.max(0, Math.min(1, item.confidence));
      results.push({ name, confidence });
    }

    return results;
  } catch (err) {
    log('llm-categorizer', 'Failed to parse response: ' + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

export async function categorizeMemory(
  content: string,
  provider: LLMProvider,
  config: LLMCategorizationConfig
): Promise<string[]> {
  if (!content.trim()) {
    return [];
  }

  try {
    const prompt = categorizationPrompt(content, config.max_content_length);
    const response = await provider.complete(prompt);

    log('llm-categorizer', 'LLM response received, tokens=' + response.tokensUsed);

    const categories = parseCategorizationResponse(response.text);
    const filtered = categories.filter(c => c.confidence >= config.confidence_threshold);

    const llmTags = filtered.map(c => `llm:${c.name}`);

    if (llmTags.length > 0) {
      log('llm-categorizer', 'Assigned tags: ' + llmTags.join(', '));
    }

    return llmTags;
  } catch (err) {
    log('llm-categorizer', 'Categorization failed: ' + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}
