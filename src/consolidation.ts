import { log } from './logger.js';
import type { Store, ConsolidationConfig } from './types.js';
import { DEFAULT_CONSOLIDATION_CONFIG } from './types.js';

export interface ConsolidationResult {
  sourceIds: number[];
  summary: string;
  insight: string;
  connections: Array<{ fromId: number; toId: number; relationship: string; confidence: number }>;
  overallConfidence: number;
}

export interface LLMProvider {
  complete(prompt: string): Promise<{ text: string; tokensUsed: number }>;
  model?: string;
}

export interface ConsolidationAgentOptions {
  llmProvider?: LLMProvider;
  maxMemoriesPerCycle?: number;
  minMemoriesThreshold?: number;
  confidenceThreshold?: number;
}

interface UnconsolidatedMemory {
  id: number;
  title: string;
  path: string;
  hash: string;
  body: string;
}

export class ConsolidationAgent {
  private store: Store;
  private llmProvider: LLMProvider | null;
  private maxMemoriesPerCycle: number;
  private minMemoriesThreshold: number;
  private confidenceThreshold: number;

  constructor(store: Store, options: ConsolidationAgentOptions = {}) {
    this.store = store;
    this.llmProvider = options.llmProvider ?? null;
    this.maxMemoriesPerCycle = options.maxMemoriesPerCycle ?? DEFAULT_CONSOLIDATION_CONFIG.max_memories_per_cycle;
    this.minMemoriesThreshold = options.minMemoriesThreshold ?? DEFAULT_CONSOLIDATION_CONFIG.min_memories_threshold;
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONSOLIDATION_CONFIG.confidence_threshold;
  }

  async runConsolidationCycle(): Promise<ConsolidationResult[]> {
    if (!this.llmProvider) {
      log('consolidation', 'No LLM provider configured, skipping consolidation');
      return [];
    }

    const recentDocs = this.getUnconsolidatedMemories();
    
    if (recentDocs.length < this.minMemoriesThreshold) {
      log('consolidation', 'Not enough unconsolidated memories (' + recentDocs.length + ' < ' + this.minMemoriesThreshold + '), skipping');
      return [];
    }

    const batch = recentDocs.slice(0, this.maxMemoriesPerCycle);
    log('consolidation', 'Processing ' + batch.length + ' memories for consolidation');

    try {
      const prompt = this.buildConsolidationPrompt(batch);
      const response = await this.llmProvider.complete(prompt);
      
      this.store.recordTokenUsage('consolidation:' + (this.llmProvider.model ?? 'unknown'), response.tokensUsed);
      
      const results = this.parseConsolidationResponse(response.text, batch);
      const filtered = results.filter(r => r.overallConfidence >= this.confidenceThreshold);
      
      for (const result of filtered) {
        this.applyConsolidation(result);
      }
      
      return filtered;
    } catch (err) {
      log('consolidation', 'Consolidation cycle failed: ' + (err instanceof Error ? err.message : String(err)));
      this.recordFailedBatch(batch.map(d => d.id));
      throw err;
    }
  }

  private getUnconsolidatedMemories(): UnconsolidatedMemory[] {
    return [];
  }

  private buildConsolidationPrompt(memories: UnconsolidatedMemory[]): string {
    return `You are a memory consolidation agent. Analyze the following memories and find connections between them.

For each group of related memories, output a JSON object with:
- sourceIds: array of memory IDs that are related
- summary: a concise summary of the related memories
- insight: a new insight derived from connecting these memories
- connections: array of {fromId, toId, relationship, confidence} objects
- overallConfidence: 0.0-1.0 rating of how confident you are in this consolidation

Output a JSON array of consolidation objects. Only include consolidations with confidence >= ${this.confidenceThreshold}.

Memories:
${memories.map(m => `[ID: ${m.id}] ${m.title}\n${m.body.substring(0, 500)}`).join('\n\n---\n\n')}

Respond with ONLY a JSON array, no other text.`;
  }

  private parseConsolidationResponse(text: string, _batch: UnconsolidatedMemory[]): ConsolidationResult[] {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item: any) => ({
        sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds.filter((id: any) => typeof id === 'number') : [],
        summary: String(item.summary ?? ''),
        insight: String(item.insight ?? ''),
        connections: Array.isArray(item.connections) ? item.connections : [],
        overallConfidence: typeof item.overallConfidence === 'number' ? item.overallConfidence : 0,
      }));
    } catch {
      log('consolidation', 'Failed to parse consolidation response');
      return [];
    }
  }

  private applyConsolidation(result: ConsolidationResult): void {
    log('consolidation', 'Applied consolidation for ' + result.sourceIds.length + ' memories, confidence=' + result.overallConfidence.toFixed(2));
  }

  private recordFailedBatch(docIds: number[]): void {
    log('consolidation', 'Recording failed batch for retry: ' + docIds.length + ' documents');
  }
}
