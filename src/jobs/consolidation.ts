import { log } from '../logger.js';
import type { Store, ConsolidationConfig } from '../types.js';
import { DEFAULT_CONSOLIDATION_CONFIG } from '../types.js';

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

export interface UnconsolidatedMemory {
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
  private failedDocIds: Set<number> = new Set();
  private failureCounts: Map<number, number> = new Map();
  private static MAX_RETRIES = 3;

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
    const db = this.store.getDb();
    
    const excludeIds = Array.from(this.failedDocIds);
    const excludePlaceholders = excludeIds.length > 0 
      ? `AND d.id NOT IN (${excludeIds.map(() => '?').join(',')})` 
      : '';
    
    const stmt = db.prepare(`
      SELECT d.id, d.title, d.path, d.hash, c.body 
      FROM documents d 
      JOIN content c ON d.hash = c.hash 
      WHERE d.collection = 'memory' 
        AND d.active = 1 
        AND d.superseded_by IS NULL 
        AND d.id NOT IN (
          SELECT json_each.value FROM consolidations, json_each(consolidations.source_ids)
        )
        ${excludePlaceholders}
      ORDER BY d.modified_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(...excludeIds, this.maxMemoriesPerCycle) as Array<{
      id: number;
      title: string;
      path: string;
      hash: string;
      body: string;
    }>;
    return rows;
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
    const db = this.store.getDb();
    const stmt = db.prepare(`
      INSERT INTO consolidations (source_ids, summary, insight, connections, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      JSON.stringify(result.sourceIds),
      result.summary,
      result.insight,
      JSON.stringify(result.connections),
      result.overallConfidence,
      new Date().toISOString()
    );

    if (result.connections.length > 0) {
      const projectHashRow = result.sourceIds.length > 0
        ? db.prepare('SELECT project_hash FROM documents WHERE id = ?').get(result.sourceIds[0]) as { project_hash: string } | undefined
        : undefined;
      const projectHash = projectHashRow?.project_hash ?? 'global';
      let created = 0;
      for (const conn of result.connections) {
        if (!conn.fromId || !conn.toId || !conn.relationship) continue;
        try {
          if (this.store.getConnectionCount(conn.fromId) >= 50) continue;
          this.store.insertConnection({
            fromDocId: conn.fromId,
            toDocId: conn.toId,
            relationshipType: conn.relationship as any,
            description: null,
            strength: typeof conn.confidence === 'number' ? conn.confidence : result.overallConfidence,
            createdBy: 'consolidation',
            projectHash,
          });
          created++;
        } catch (err) {
          log('consolidation', 'Failed to create connection ' + conn.fromId + '->' + conn.toId + ': ' + (err instanceof Error ? err.message : String(err)), 'warn');
        }
      }
      if (created > 0) {
        log('consolidation', 'Created ' + created + ' memory connections from consolidation');
      }
    }

    log('consolidation', 'Applied consolidation for ' + result.sourceIds.length + ' memories, confidence=' + result.overallConfidence.toFixed(2));
  }

  private recordFailedBatch(docIds: number[]): void {
    for (const id of docIds) {
      const count = (this.failureCounts.get(id) ?? 0) + 1;
      this.failureCounts.set(id, count);
      if (count >= ConsolidationAgent.MAX_RETRIES) {
        this.failedDocIds.add(id);
        log('consolidation', 'Document ' + id + ' failed ' + count + ' times, skipping permanently until restart', 'warn');
      }
    }
    log('consolidation', 'Recording failed batch: ' + docIds.length + ' documents, ids=[' + docIds.join(',') + '], permanently skipped=' + this.failedDocIds.size, 'warn');
  }

  async findConsolidationCandidates(documentId: number, maxCandidates: number = 5): Promise<UnconsolidatedMemory[]> {
    const db = this.store.getDb();
    const docRow = db.prepare(`
      SELECT d.id, d.title, d.path, d.hash, c.body
      FROM documents d
      JOIN content c ON d.hash = c.hash
      WHERE d.id = ? AND d.active = 1
    `).get(documentId) as UnconsolidatedMemory | undefined;

    if (!docRow) {
      log('consolidation', 'Document not found for consolidation: ' + documentId);
      return [];
    }

    const results = this.store.searchFTS(docRow.title + ' ' + docRow.body.substring(0, 200), {
      limit: maxCandidates + 1,
      collection: 'memory',
    });

    const candidates: UnconsolidatedMemory[] = [];
    for (const result of results) {
      if (String(result.id) === String(documentId)) continue;
      if (candidates.length >= maxCandidates) break;

      const candidateRow = db.prepare(`
        SELECT d.id, d.title, d.path, d.hash, c.body
        FROM documents d
        JOIN content c ON d.hash = c.hash
        WHERE d.id = ? AND d.active = 1
      `).get(result.id) as UnconsolidatedMemory | undefined;

      if (candidateRow) {
        candidates.push(candidateRow);
      }
    }

    log('consolidation', 'Found ' + candidates.length + ' candidates for document ' + documentId);
    return candidates;
  }

  async processConsolidationJob(jobId: number, documentId: number): Promise<void> {
    if (!this.llmProvider) {
      throw new Error('No LLM provider configured');
    }

    const db = this.store.getDb();
    const docRow = db.prepare(`
      SELECT d.id, d.title, d.path, d.hash, c.body
      FROM documents d
      JOIN content c ON d.hash = c.hash
      WHERE d.id = ? AND d.active = 1
    `).get(documentId) as UnconsolidatedMemory | undefined;

    if (!docRow) {
      this.store.updateJobStatus(jobId, 'failed', undefined, 'Document not found');
      this.store.addConsolidationLog({
        documentId,
        action: 'FAILED',
        reason: 'Document not found',
        model: this.llmProvider.model ?? 'unknown',
        tokensUsed: 0,
      });
      return;
    }

    const candidates = await this.findConsolidationCandidates(documentId, this.maxMemoriesPerCycle);

    const prompt = this.buildSingleDocConsolidationPrompt(docRow, candidates);
    
    try {
      const response = await this.llmProvider.complete(prompt);
      this.store.recordTokenUsage('consolidation:' + (this.llmProvider.model ?? 'unknown'), response.tokensUsed);

      const decision = this.parseSingleDocResponse(response.text);

      if (decision.contradictedEntities.length > 0) {
        this.markContradictedEntities(decision.contradictedEntities, documentId);
        log('consolidation', 'Detected ' + decision.contradictedEntities.length + ' contradicted entities for document ' + documentId);
      }

      const reasonWithContradictions = decision.contradictedEntities.length > 0
        ? decision.reason + ' [Contradicted: ' + decision.contradictedEntities.join(', ') + ']'
        : decision.reason;

      this.store.addConsolidationLog({
        documentId,
        action: decision.action,
        reason: reasonWithContradictions,
        targetDocId: decision.targetDocId ?? undefined,
        model: this.llmProvider.model ?? 'unknown',
        tokensUsed: response.tokensUsed,
      });

      this.store.updateJobStatus(jobId, 'completed', JSON.stringify(decision));
      log('consolidation', 'Processed job ' + jobId + ' for document ' + documentId + ': ' + decision.action);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.updateJobStatus(jobId, 'failed', undefined, errorMsg);
      this.store.addConsolidationLog({
        documentId,
        action: 'FAILED',
        reason: errorMsg,
        model: this.llmProvider.model ?? 'unknown',
        tokensUsed: 0,
      });
      throw err;
    }
  }

  private buildSingleDocConsolidationPrompt(doc: UnconsolidatedMemory, candidates: UnconsolidatedMemory[]): string {
    let prompt = `You are a memory consolidation agent. Analyze the following new memory and determine the best action.

New Memory (ID: ${doc.id}):
Title: ${doc.title}
Content:
${doc.body.substring(0, 1000)}

`;

    if (candidates.length > 0) {
      prompt += `Existing similar memories:\n`;
      for (const c of candidates) {
        prompt += `\n[ID: ${c.id}] ${c.title}\n${c.body.substring(0, 300)}\n---\n`;
      }
    } else {
      prompt += `No similar existing memories found.\n`;
    }

    prompt += `
Decide the best action:
- ADD: Keep the new memory as-is (no duplicates found)
- UPDATE: Merge with an existing memory (specify targetDocId and provide mergedContent)
- DELETE: Remove as duplicate (specify targetDocId of the better version)
- NOOP: No action needed

Also detect contradictions:
- If the new memory contradicts facts in existing memories, list the contradicted entity names

Examples:
- ADD: When the new memory introduces entirely new information not covered by any existing memory.
- UPDATE: When the new memory refines, corrects, or adds detail to an existing memory. Return mergedContent with the combined information.
- DELETE: When the new memory explicitly contradicts or supersedes an existing memory.
- NOOP: When the new memory is already fully covered by existing memories.

Respond with ONLY a JSON object:
{
  "action": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "reason": "brief explanation",
  "targetDocId": null or number (for UPDATE/DELETE),
  "contradictedEntities": ["entity1", "entity2"] or [] if no contradictions
}`;

    return prompt;
  }

  private parseSingleDocResponse(text: string): { action: string; reason: string; targetDocId: number | null; contradictedEntities: string[] } {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: 'NOOP', reason: 'Failed to parse response', targetDocId: null, contradictedEntities: [] };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const contradictedEntities: string[] = [];
      if (Array.isArray(parsed.contradictedEntities)) {
        for (const e of parsed.contradictedEntities) {
          if (typeof e === 'string' && e.trim()) {
            contradictedEntities.push(e.trim());
          }
        }
      }
      return {
        action: String(parsed.action ?? 'NOOP').toUpperCase(),
        reason: String(parsed.reason ?? ''),
        targetDocId: typeof parsed.targetDocId === 'number' ? parsed.targetDocId : null,
        contradictedEntities,
      };
    } catch {
      log('consolidation', 'Failed to parse single doc consolidation response');
      return { action: 'NOOP', reason: 'Parse error', targetDocId: null, contradictedEntities: [] };
    }
  }

  private markContradictedEntities(entityNames: string[], memoryId: number): void {
    if (entityNames.length === 0) return;

    const db = this.store.getDb();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT,
          project_hash TEXT NOT NULL,
          first_learned_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
          contradicted_at TEXT,
          contradicted_by_memory_id INTEGER,
          UNIQUE(name, project_hash)
        )
      `);
    } catch {
    }

    const updateStmt = db.prepare(`
      UPDATE memory_entities
      SET contradicted_at = datetime('now'), contradicted_by_memory_id = ?
      WHERE name = ? AND contradicted_at IS NULL
    `);

    for (const name of entityNames) {
      try {
        updateStmt.run(memoryId, name);
        log('consolidation', 'Marked entity as contradicted: ' + name);
      } catch (err) {
        log('consolidation', 'Failed to mark entity as contradicted: ' + name + ' - ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  }
}
