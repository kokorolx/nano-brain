import Database from 'better-sqlite3';
import type { CorruptionRecoveryResult } from '../db/corruption-recovery.js';
import { log } from '../logger.js';
import type { Stmts } from './schema.js';

export { type CorruptionRecoveryResult };

let lastCorruptionRecovery: CorruptionRecoveryResult | null = null;

export function getLastCorruptionRecovery(): CorruptionRecoveryResult | null {
  return lastCorruptionRecovery;
}

export function clearCorruptionRecovery(): void {
  lastCorruptionRecovery = null;
}

export function setLastCorruptionRecovery(result: CorruptionRecoveryResult): void {
  lastCorruptionRecovery = result;
}

export function makeCacheMethods(
  db: Database.Database,
  stmts: Stmts
) {
  return {
    getCachedResult(hash: string, projectHash: string = 'global'): string | null {
      const row = stmts.getCachedResult.get(hash, projectHash) as { result: string } | undefined;
      return row?.result ?? null;
    },

    setCachedResult(hash: string, result: string, projectHash: string = 'global', type: string = 'general') {
      stmts.setCachedResult.run(hash, projectHash, type, result);
    },

    getCacheStats(): Array<{ type: string; projectHash: string; count: number }> {
      return db.prepare('SELECT type, project_hash as projectHash, COUNT(*) as count FROM llm_cache GROUP BY type, project_hash ORDER BY count DESC').all() as Array<{ type: string; projectHash: string; count: number }>;
    },

    clearCache(projectHash?: string, type?: string): number {
      let sql = 'DELETE FROM llm_cache';
      const conditions: string[] = [];
      const params: string[] = [];
      if (projectHash) {
        conditions.push('project_hash = ?');
        params.push(projectHash);
      }
      if (type) {
        conditions.push('type = ?');
        params.push(type);
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      const result = db.prepare(sql).run(...params);
      return result.changes;
    },

    logSearchQuery(queryId: string, queryText: string, tier: string, configVariant: string | null, resultDocids: string[], executionMs: number, sessionId: string | null, cacheKey: string | null, workspaceHash: string) {
      try {
        stmts.insertTelemetry.run(queryId, queryText, tier, configVariant, JSON.stringify(resultDocids), executionMs, sessionId, cacheKey, workspaceHash);
      } catch (err) {
        log('store', `Failed to log telemetry: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getTelemetryStats(workspaceHash: string): { queryCount: number; expandCount: number } {
      const row = stmts.getTelemetryStats.get(workspaceHash) as { queryCount: number; expandCount: number | null } | undefined;
      return {
        queryCount: row?.queryCount ?? 0,
        expandCount: row?.expandCount ?? 0,
      };
    },

    recordTokenUsage(model: string, tokens: number) {
      try {
        stmts.recordTokenUsage.run(model, tokens);
      } catch (err) {
        log('store', `Failed to record token usage: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getLastCorruptionRecovery,

    clearCorruptionRecovery,

    enqueueConsolidation(documentId: number): number {
      try {
        const result = stmts.enqueueConsolidation.run(documentId);
        return Number(result.lastInsertRowid);
      } catch (err) {
        log('store', `Failed to enqueue consolidation: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return 0;
      }
    },

    getNextPendingJob(): { id: number; document_id: number } | null {
      return stmts.getNextPendingJob.get() as { id: number; document_id: number } | null;
    },

    updateJobStatus(jobId: number, status: 'processing' | 'completed' | 'failed', result?: string, error?: string): void {
      try {
        stmts.updateJobStatus.run(status, result ?? null, error ?? null, jobId);
      } catch (err) {
        log('store', `Failed to update job status: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getRecentConsolidationLogs(limit: number = 10): Array<{ id: number; document_id: number; action: string; reason: string | null; target_doc_id: number | null; model: string | null; tokens_used: number; created_at: string }> {
      return stmts.getRecentConsolidationLogs.all(limit) as Array<{ id: number; document_id: number; action: string; reason: string | null; target_doc_id: number | null; model: string | null; tokens_used: number; created_at: string }>;
    },
  };
}
