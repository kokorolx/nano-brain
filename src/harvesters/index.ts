// src/harvesters/index.ts
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { SessionSourceAdapter } from './types.js';
import { loadHarvestState, saveHarvestState } from './shared.js';
import type { ExtractionConfig, Store, HarvestedSession } from '../types.js';
import { log } from '../logger.js';

export { OpenCodeAdapter } from './opencode.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export type { SessionSourceAdapter, AdapterResult, HarvestStats } from './types.js';

export async function runHarvestCycle(
  adapters: SessionSourceAdapter[],
  outputDir: string,
  options?: { extractionConfig?: ExtractionConfig; store?: Store },
): Promise<HarvestedSession[]> {
  mkdirSync(outputDir, { recursive: true });
  const allSessions: HarvestedSession[] = [];

  for (const adapter of adapters) {
    if (!adapter.isAvailable()) {
      log('harvester', `Adapter ${adapter.name}: source not available, skipping`);
      continue;
    }

    const stateFile = join(outputDir, `.harvest-state-${adapter.name}.json`);
    const state = loadHarvestState(stateFile);

    try {
      const result = await adapter.readNewSessions(
        state,
        outputDir,
        options?.extractionConfig,
        options?.store,
      );

      if (result.stateChanged) {
        saveHarvestState(stateFile, state);
      }

      if (result.sessions.length > 0) {
        log('harvester', `Adapter ${adapter.name}: ${result.sessions.length} session(s) harvested`);
      }

      allSessions.push(...result.sessions);
    } catch (err) {
      log('harvester', `Adapter ${adapter.name} failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }

  return allSessions;
}
