import { createStore } from '../../store.js';
import { loadCollectionConfig } from '../../collections.js';
import { createLLMProvider } from '../../llm-provider.js';
import type { ConsolidationConfig } from '../../types.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleCategorizeBackfill(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let batchSize = 50;
  let rateLimit = 10;
  let dryRun = false;
  let workspace: string | undefined;

  for (const arg of commandArgs) {
    if (arg.startsWith('--batch-size=')) {
      batchSize = parseInt(arg.substring(13), 10);
    } else if (arg.startsWith('--rate-limit=')) {
      rateLimit = parseInt(arg.substring(13), 10);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.substring(12);
    }
  }

  log('cli', 'categorize-backfill batch=' + batchSize + ' rate=' + rateLimit + ' dry=' + dryRun);

  const config = loadCollectionConfig(globalOpts.configPath);
  if (!config?.consolidation) {
    cliError('No consolidation config found. Set consolidation section in config.yml');
    process.exit(1);
  }

  const consolidationConfig = config.consolidation as ConsolidationConfig;
  const llmProvider = createLLMProvider(consolidationConfig);
  if (!llmProvider) {
    cliError('No LLM provider configured. Set consolidation.apiKey in config.yml or CONSOLIDATION_API_KEY env var');
    process.exit(1);
  }

  const categorizationConfig = {
    llm_enabled: config?.categorization?.llm_enabled ?? true,
    confidence_threshold: config?.categorization?.confidence_threshold ?? 0.6,
    max_content_length: config?.categorization?.max_content_length ?? 2000,
  };

  const store = await createStore(globalOpts.dbPath);
  const projectHash = workspace
    ? crypto.createHash('sha256').update(workspace).digest('hex').substring(0, 12)
    : undefined;

  const uncategorized = store.getUncategorizedDocuments(batchSize, projectHash);
  const total = uncategorized.length;

  if (total === 0) {
    cliOutput('No uncategorized documents found.');
    store.close();
    return;
  }

  cliOutput(`Found ${total} uncategorized document(s)${dryRun ? ' (dry run)' : ''}`);

  const tagCounts = new Map<string, number>();
  let processed = 0;
  let categorized = 0;
  const delayMs = Math.ceil(1000 / rateLimit);

  for (const doc of uncategorized) {
    processed++;
    const truncatedContent = doc.body.slice(0, categorizationConfig.max_content_length);

    if (dryRun) {
      cliOutput(`[${processed}/${total}] Would categorize: ${doc.path}`);
      continue;
    }

    try {
      const { categorizeMemory } = await import('../../llm-categorizer.js');
      const tags = await categorizeMemory(truncatedContent, llmProvider, categorizationConfig);

      if (tags.length > 0) {
        store.insertTags(doc.id, tags);
        categorized++;
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      const tagStr = tags.length > 0 ? tags.join(', ') : '(no tags)';
      cliOutput(`[${processed}/${total}] ${doc.path}: ${tagStr}`);

      if (processed < total) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      cliError(`[${processed}/${total}] Error categorizing ${doc.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  store.close();

  cliOutput('');
  if (dryRun) {
    cliOutput(`Dry run complete. Would process ${total} document(s).`);
  } else {
    cliOutput(`Categorization complete: ${categorized}/${processed} documents tagged`);
    if (tagCounts.size > 0) {
      cliOutput('Tag distribution:');
      const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [tag, count] of sorted) {
        cliOutput(`  ${tag}: ${count}`);
      }
    }
  }
}
