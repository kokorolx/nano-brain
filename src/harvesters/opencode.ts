import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionSourceAdapter, AdapterResult } from './types.js';
import type { HarvestState } from './shared.js';
import type { ExtractionConfig, Store } from '../types.js';
import { harvestSessions } from '../harvester.js';

const DEFAULT_SESSION_DIR = join(homedir(), '.local/share/opencode/storage');

export class OpenCodeAdapter implements SessionSourceAdapter {
  readonly name = 'opencode';

  constructor(private sessionDir: string = DEFAULT_SESSION_DIR) {}

  isAvailable(): boolean {
    return existsSync(this.sessionDir);
  }

  async readNewSessions(
    _state: HarvestState,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult> {
    // Point harvestSessions at the orchestrator's state file to avoid dual tracking.
    // Return stateChanged: false — harvestSessions writes the file itself.
    const stateFile = join(outputDir, `.harvest-state-${this.name}.json`);
    const sessions = await harvestSessions({
      sessionDir: this.sessionDir,
      outputDir,
      extractionConfig,
      store,
      stateFile,
    });

    return {
      sessions,
      stateChanged: false,
      stats: {
        processed: sessions.length,
        skipped: 0,
        incremental: 0,
        errors: 0,
      },
    };
  }
}
