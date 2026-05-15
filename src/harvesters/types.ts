import type { HarvestedSession, ExtractionConfig, Store } from '../types.js';

export interface HarvestStats {
  processed: number;
  skipped: number;
  incremental: number;
  errors: number;
  extractionStats?: {
    factsExtracted: number;
    duplicatesSkipped: number;
    errors: number;
    limitReached?: boolean;
  };
}

export interface AdapterResult {
  sessions: HarvestedSession[];
  stateChanged: boolean;
  stats: HarvestStats;
}

export interface SessionSourceAdapter {
  readonly name: string;
  isAvailable(): boolean;
  readNewSessions(
    state: Record<string, { mtime: number; retries?: number; skipped?: boolean; messageCount?: number }>,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult>;
}
