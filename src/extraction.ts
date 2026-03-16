import { log } from './logger.js';
import type { LLMProvider } from './consolidation.js';
import type { Store, ExtractionConfig } from './types.js';
import { DEFAULT_EXTRACTION_CONFIG } from './types.js';
import { createHash } from 'crypto';

export type FactCategory = 
  | 'architecture-decision'
  | 'technology-choice'
  | 'coding-pattern'
  | 'preference'
  | 'debugging-insight'
  | 'config-detail';

export interface ExtractedFact {
  content: string;
  category: FactCategory;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  stored: number;
  duplicates: number;
  tokensUsed: number;
}

const VALID_CATEGORIES: FactCategory[] = [
  'architecture-decision',
  'technology-choice',
  'coding-pattern',
  'preference',
  'debugging-insight',
  'config-detail',
];

export function validateExtractionConfig(config: Partial<ExtractionConfig>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const merged = { ...DEFAULT_EXTRACTION_CONFIG, ...config };

  if (merged.enabled) {
    if (!merged.model || merged.model.trim() === '') {
      errors.push('model must be non-empty when extraction is enabled');
    }
    const apiKey = merged.apiKey || process.env.CONSOLIDATION_API_KEY;
    if (!apiKey) {
      errors.push('apiKey must be set (or CONSOLIDATION_API_KEY env var) when extraction is enabled');
    }
  }

  if (merged.maxFactsPerSession <= 0) {
    errors.push('maxFactsPerSession must be > 0');
  }

  return { valid: errors.length === 0, errors };
}

function buildExtractionPrompt(sessionContent: string, maxFacts: number): string {
  return `You are a fact extraction agent. Analyze the following session transcript and extract discrete, reusable facts.

Extract up to ${maxFacts} facts. Each fact should be:
- Self-contained and understandable without context
- Specific and actionable
- Not duplicating information already in the session

Output a JSON array of objects with:
- content: the fact as a concise statement
- category: one of "architecture-decision", "technology-choice", "coding-pattern", "preference", "debugging-insight", "config-detail"

Category definitions and examples:
1. architecture-decision: High-level design choices about system structure
   - "Use event sourcing for the order service to enable audit trails"
   - "Separate read and write models using CQRS pattern"

2. technology-choice: Selection of specific tools, libraries, or frameworks
   - "Use Redis Streams instead of Bull queues for job processing"
   - "Prefer Zod over Joi for TypeScript schema validation"

3. coding-pattern: Recurring code structures or implementation approaches
   - "Always use Result<T, E> types instead of throwing exceptions"
   - "Wrap database calls in retry logic with exponential backoff"

4. preference: Personal or team conventions and style choices
   - "Use kebab-case for file names in this project"
   - "Prefer explicit imports over barrel files"

5. debugging-insight: Lessons learned from troubleshooting
   - "ECONNREFUSED on port 6379 usually means Redis container not started"
   - "Memory leaks in Node often caused by unclosed event listeners"

6. config-detail: Environment, build, or deployment configuration
   - "Set NODE_OPTIONS=--max-old-space-size=4096 for large builds"
   - "Use .nvmrc to pin Node version to 20.x"

Session transcript:
${sessionContent}

Respond with ONLY a JSON array, no other text.`;
}

export function parseExtractionResponse(text: string): ExtractedFact[] {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    
    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      
      const content = item.content;
      const category = item.category;
      
      if (typeof content !== 'string' || content.trim() === '') continue;
      if (!VALID_CATEGORIES.includes(category as FactCategory)) continue;
      
      facts.push({
        content: content.trim(),
        category: category as FactCategory,
      });
    }
    
    return facts;
  } catch {
    log('extraction', 'Failed to parse extraction response');
    return [];
  }
}

export function computeFactHash(content: string): string {
  const normalized = content.trim().toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.substring(0, 16);
}

export function storeExtractedFact(
  store: Store,
  fact: ExtractedFact,
  sessionId: string,
  projectHash: string
): boolean {
  const hash = computeFactHash(fact.content);
  const path = 'auto:extracted-fact:' + hash;
  
  const existing = store.findDocument(path);
  if (existing) {
    log('extraction', 'Duplicate fact detected hash=' + hash, 'debug');
    return false;
  }
  
  const title = fact.category + ': ' + fact.content.substring(0, 80);
  const now = new Date().toISOString();
  
  store.insertContent(hash, fact.content);
  
  const docId = store.insertDocument({
    collection: 'memory',
    path,
    title,
    hash,
    createdAt: now,
    modifiedAt: now,
    active: true,
    projectHash,
  });
  
  if (docId > 0) {
    store.insertTags(docId, [
      'auto:extracted-fact',
      'category:' + fact.category,
      'source:session:' + sessionId,
    ]);
    log('extraction', 'Stored fact hash=' + hash + ' category=' + fact.category);
    return true;
  }
  
  return false;
}

export async function extractFactsFromSession(
  sessionContent: string,
  provider: LLMProvider,
  config: ExtractionConfig
): Promise<ExtractionResult> {
  const prompt = buildExtractionPrompt(sessionContent, config.maxFactsPerSession);
  
  log('extraction', 'Extracting facts from session, maxFacts=' + config.maxFactsPerSession);
  
  const response = await provider.complete(prompt);
  const facts = parseExtractionResponse(response.text);
  const limited = facts.slice(0, config.maxFactsPerSession);
  
  log('extraction', 'Extracted ' + limited.length + ' facts, tokens=' + response.tokensUsed);
  
  return {
    facts: limited,
    stored: 0,
    duplicates: 0,
    tokensUsed: response.tokensUsed,
  };
}

export async function extractAndStoreFacts(
  sessionContent: string,
  sessionId: string,
  projectHash: string,
  provider: LLMProvider,
  config: ExtractionConfig,
  store: Store
): Promise<ExtractionResult> {
  const result = await extractFactsFromSession(sessionContent, provider, config);
  
  let stored = 0;
  let duplicates = 0;
  
  for (const fact of result.facts) {
    const wasStored = storeExtractedFact(store, fact, sessionId, projectHash);
    if (wasStored) {
      stored++;
    } else {
      duplicates++;
    }
  }
  
  log('extraction', 'Stored ' + stored + ' facts, ' + duplicates + ' duplicates');
  
  return {
    facts: result.facts,
    stored,
    duplicates,
    tokensUsed: result.tokensUsed,
  };
}
