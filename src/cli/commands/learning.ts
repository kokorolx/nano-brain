import { createStore } from '../../store.js';
import { cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleLearning(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (subcommand === 'rollback') {
    const versionId = commandArgs[1] ? parseInt(commandArgs[1], 10) : undefined;
    const store = await createStore(globalOpts.dbPath);
    try {
      if (versionId) {
        const version = store.getConfigVersion(versionId);
        if (!version) {
          cliError('Config version ' + versionId + ' not found');
          process.exit(1);
        }
        cliOutput('Config version ' + versionId + ' (created ' + version.created_at + ')');
        cliOutput('Config:', version.config_json);
      } else {
        const latest = store.getLatestConfigVersion();
        if (!latest) {
          cliOutput('No config versions found. Learning has not been active.');
        } else {
          cliOutput('Latest config version: ' + latest.version_id + ' (created ' + latest.created_at + ')');
          cliOutput('Config:', latest.config_json);
          cliOutput('\nUse: nano-brain learning rollback <version_id>');
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  cliError('Usage: nano-brain learning rollback [version_id]');
  cliError('');
  cliError('Commands:');
  cliError('  rollback [version_id]  View or rollback to a previous config version');
  process.exit(1);
}
