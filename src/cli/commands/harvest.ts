import { harvestSessions } from '../../harvester.js';
import { log, cliOutput } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { DEFAULT_OUTPUT_DIR, resolveOpenCodeStorageDir } from '../utils.js';

export async function handleHarvest(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'harvest start');
  const sessionDir = resolveOpenCodeStorageDir();
  const outputDir = DEFAULT_OUTPUT_DIR;

  cliOutput('Harvesting sessions...');
  const sessions = await harvestSessions({ sessionDir, outputDir });

  cliOutput(`✅ Harvested ${sessions.length} sessions to ${outputDir}`);
}
