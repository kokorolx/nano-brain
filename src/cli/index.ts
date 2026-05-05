import { loadCollectionConfig } from '../collections.js';
import { initLogger } from '../logger.js';
import { cliError } from '../logger.js';
import { setStdioMode } from '../logger.js';
import { handleBench } from '../bench.js';
import { parseGlobalOptions, resolveDbPath, showHelp, showVersion, formatSearchOutput } from './utils.js';
import { handleMcp } from './commands/mcp.js';
import { handleCollection } from './commands/collection.js';
import { handleStatus } from './commands/status.js';
import { handleInit } from './commands/init.js';
import { handleUpdate } from './commands/update.js';
import { handleEmbed } from './commands/embed.js';
import { handleSearch } from './commands/search.js';
import { handleGet } from './commands/get.js';
import { handleHarvest } from './commands/harvest.js';
import { handleWrite } from './commands/write.js';
import { handleTags } from './commands/tags.js';
import { handleWakeUp } from './commands/wake-up.js';
import { handleFocus } from './commands/focus.js';
import { handleGraphStats } from './commands/graph-stats.js';
import { handleSymbols } from './commands/symbols.js';
import { handleImpact } from './commands/impact.js';
import { handleContext } from './commands/context.js';
import { handleCodeImpact } from './commands/code-impact.js';
import { handleDetectChanges } from './commands/detect-changes.js';
import { handleReindex } from './commands/reindex.js';
import { handleCache } from './commands/cache.js';
import { handleLogs } from './commands/logs.js';
import { handleQdrant } from './commands/qdrant.js';
import { handleReset } from './commands/reset.js';
import { handleRm } from './commands/rm.js';
import { handleCategorizeBackfill } from './commands/categorize-backfill.js';
import { handleConsolidate } from './commands/consolidate.js';
import { handleLearning } from './commands/learning.js';
import { handleDocker } from './commands/docker.js';

export { parseGlobalOptions, resolveDbPath, showHelp, showVersion, formatSearchOutput };
export { handleMcp, handleCollection, handleStatus, handleInit, handleUpdate };
export { handleEmbed, handleSearch, handleGet, handleHarvest, handleWrite };
export { handleTags, handleWakeUp, handleFocus, handleGraphStats, handleSymbols };
export { handleImpact, handleContext, handleCodeImpact, handleDetectChanges, handleReindex };
export { handleCache, handleLogs, handleQdrant, handleReset, handleRm };
export { handleCategorizeBackfill, handleConsolidate, handleLearning, handleDocker };
export { resolveWorkspaceIdentifier } from './commands/rm.js';
export type { GlobalOptions } from './types.js';

export async function main() {
  const args = process.argv.slice(2);

  const globalOpts = parseGlobalOptions(args);

  const cliConfig = loadCollectionConfig(globalOpts.configPath);
  initLogger(cliConfig ?? undefined);

  const command = globalOpts.remaining[0] || 'mcp';
  const commandArgs = globalOpts.remaining.slice(1);

  if (command === 'mcp' && !commandArgs.includes('--http')) {
    setStdioMode(true);
  }

  const { log } = await import('../logger.js');
  log('cli', 'command=' + command);

  const isDaemonMode = command === 'mcp' && commandArgs.includes('--daemon');
  if (command !== 'init' && command !== 'docker' && !isDaemonMode) {
    globalOpts.dbPath = resolveDbPath(globalOpts.dbPath, process.cwd());
  }

  switch (command) {
    case 'mcp':
      return handleMcp(globalOpts, commandArgs);
    case 'init':
      return handleInit(globalOpts, commandArgs);
    case 'collection':
      return handleCollection(globalOpts, commandArgs);
    case 'status':
      return handleStatus(globalOpts, commandArgs);
    case 'update':
      return handleUpdate(globalOpts);
    case 'embed':
      return handleEmbed(globalOpts, commandArgs);
    case 'search':
      return handleSearch(globalOpts, commandArgs, 'fts');
    case 'vsearch':
      return handleSearch(globalOpts, commandArgs, 'vec');
    case 'query':
      return handleSearch(globalOpts, commandArgs, 'hybrid');
    case 'get':
      return handleGet(globalOpts, commandArgs);
    case 'harvest':
      return handleHarvest(globalOpts);
    case 'cache':
      return handleCache(globalOpts, commandArgs);
    case 'write':
      return handleWrite(globalOpts, commandArgs);
    case 'bench':
      return handleBench(globalOpts, commandArgs);
    case 'tags':
      return handleTags(globalOpts);
    case 'wake-up':
      return handleWakeUp(globalOpts, commandArgs);
    case 'focus':
      return handleFocus(globalOpts, commandArgs);
    case 'graph-stats':
      return handleGraphStats(globalOpts);
    case 'symbols':
      return handleSymbols(globalOpts, commandArgs);
    case 'impact':
      return handleImpact(globalOpts, commandArgs);
    case 'logs':
      return handleLogs(commandArgs);
    case 'docker':
      return handleDocker(globalOpts, commandArgs);
    case 'qdrant':
      return handleQdrant(globalOpts, commandArgs);
    case 'reset':
      return handleReset(globalOpts, commandArgs);
    case 'rm':
      return handleRm(globalOpts, commandArgs);
    case 'context':
      return handleContext(globalOpts, commandArgs);
    case 'code-impact':
      return handleCodeImpact(globalOpts, commandArgs);
    case 'detect-changes':
      return handleDetectChanges(globalOpts, commandArgs);
    case 'reindex':
      return handleReindex(globalOpts, commandArgs);
    case 'consolidate':
      return handleConsolidate(globalOpts, commandArgs);
    case 'categorize-backfill':
      return handleCategorizeBackfill(globalOpts, commandArgs);
    case 'learning':
      return handleLearning(globalOpts, commandArgs);
    default:
      cliError(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('cli.js') ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch(err => {
    cliError('Fatal error:', err);
    process.exit(1);
  });
}
