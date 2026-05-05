import { createStore, resolveProjectLabel } from '../../store.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleCache(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing cache subcommand (clear, stats)');
    process.exit(1);
  }

  log('cli', 'cache subcommand=' + subcommand);
  const store = await createStore(globalOpts.dbPath);

  switch (subcommand) {
    case 'clear': {
      let all = false;
      let type: string | undefined;

      for (const arg of commandArgs.slice(1)) {
        if (arg === '--all') {
          all = true;
        } else if (arg.startsWith('--type=')) {
          type = arg.substring(7);
        }
      }

      if (type) {
        const typeMap: Record<string, string> = { embed: 'qembed', expand: 'expand', rerank: 'rerank' };
        if (!typeMap[type]) {
          cliError(`Invalid cache type "${type}". Valid types: embed, expand, rerank`);
          store.close();
          process.exit(1);
        }
        type = typeMap[type];
      }

      let deleted: number;
      if (all) {
        deleted = store.clearCache(undefined, type);
        cliOutput(`Cleared all cache entries${type ? ` of type ${type}` : ''} (${deleted} total)`);
      } else {
        const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12);
        deleted = store.clearCache(projectHash, type);
        cliOutput(`Cleared ${deleted} cache entries for workspace ${resolveProjectLabel(projectHash)}${type ? ` (type: ${type})` : ''}`);
      }
      break;
    }

    case 'stats': {
      const stats = store.getCacheStats();
      if (stats.length === 0) {
        cliOutput('No cache entries');
      } else {
        cliOutput('Cache Statistics:');
        cliOutput('  Type        Project                         Count');
        cliOutput('  ──────────  ──────────────────────────────  ─────');
        for (const row of stats) {
          cliOutput(`  ${row.type.padEnd(10)}  ${resolveProjectLabel(row.projectHash).padEnd(30)}  ${row.count}`);
        }
      }
      break;
    }

    default:
      cliError(`Unknown cache subcommand: ${subcommand}`);
      store.close();
      process.exit(1);
  }

  store.close();
}
