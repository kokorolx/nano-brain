import { loadCollectionConfig, addCollection, removeCollection, renameCollection, listCollections } from '../../collections.js';
import { cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleCollection(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing collection subcommand (add, remove, list, rename)');
    process.exit(1);
  }

  switch (subcommand) {
    case 'add': {
      const name = commandArgs[1];
      const collectionPath = commandArgs[2];
      let pattern = '**/*.md';

      for (const arg of commandArgs.slice(3)) {
        if (arg.startsWith('--pattern=')) {
          pattern = arg.substring(10);
        }
      }

      if (!name || !collectionPath) {
        cliError('Usage: collection add <name> <path> [--pattern=<glob>]');
        process.exit(1);
      }

      addCollection(globalOpts.configPath, name, collectionPath, pattern);
      cliOutput(`✅ Added collection "${name}"`);
      break;
    }

    case 'remove': {
      const name = commandArgs[1];
      if (!name) {
        cliError('Usage: collection remove <name>');
        process.exit(1);
      }

      removeCollection(globalOpts.configPath, name);
      cliOutput(`✅ Removed collection "${name}"`);
      break;
    }

    case 'list': {
      const config = loadCollectionConfig(globalOpts.configPath);
      if (!config) {
        cliOutput('No collections configured');
        return;
      }

      const names = listCollections(config);
      if (names.length === 0) {
        cliOutput('No collections configured');
      } else {
        cliOutput('Collections:');
        for (const name of names) {
          const coll = config.collections?.[name];
          cliOutput(`  ${name}: ${coll?.path} (${coll?.pattern || '**/*.md'})`);
        }
      }
      break;
    }

    case 'rename': {
      const oldName = commandArgs[1];
      const newName = commandArgs[2];

      if (!oldName || !newName) {
        cliError('Usage: collection rename <old> <new>');
        process.exit(1);
      }

      renameCollection(globalOpts.configPath, oldName, newName);
      cliOutput(`✅ Renamed collection "${oldName}" to "${newName}"`);
      break;
    }

    default:
      cliError(`Unknown collection subcommand: ${subcommand}`);
      process.exit(1);
  }
}
