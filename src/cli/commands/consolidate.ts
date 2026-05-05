import { createStore } from '../../store.js';
import { loadCollectionConfig } from '../../collections.js';
import { createLLMProvider } from '../../llm-provider.js';
import { ConsolidationAgent } from '../../consolidation.js';
import type { ConsolidationConfig } from '../../types.js';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleConsolidate(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'consolidate');
  const store = await createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);

  if (!config?.consolidation?.enabled) {
    cliOutput('Consolidation is not enabled. Set consolidation.enabled=true in config.yml');
    store.close();
    return;
  }

  try {
    const consolidationConfig = config.consolidation as ConsolidationConfig;
    const provider = createLLMProvider(consolidationConfig);

    if (!provider) {
      cliOutput('No API key configured. Set consolidation.apiKey in config.yml or CONSOLIDATION_API_KEY env var');
      return;
    }

    const agent = new ConsolidationAgent(store, {
      llmProvider: provider,
      maxMemoriesPerCycle: consolidationConfig.max_memories_per_cycle,
      minMemoriesThreshold: consolidationConfig.min_memories_threshold,
      confidenceThreshold: consolidationConfig.confidence_threshold,
    });

    const results = await agent.runConsolidationCycle();

    if (results.length === 0) {
      cliOutput('No memories to consolidate');
    } else {
      cliOutput(`Consolidation complete: ${results.length} consolidation(s) created`);
    }
  } catch (err) {
    cliError('Consolidation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    store.close();
  }
}
