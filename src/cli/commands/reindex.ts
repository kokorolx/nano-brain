import { createStore, openDatabase } from '../../store.js';
import { loadCollectionConfig, getWorkspaceConfig } from '../../collections.js';
import { indexCodebase } from '../../codebase.js';
import { isTreeSitterAvailable } from '../../treesitter.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import {
  DEFAULT_HTTP_PORT,
  detectRunningServerContainer,
  proxyPostContainer,
  isRunningInContainer,
  getHttpHost,
  getHttpPort,
  resolveDbPath,
} from '../utils.js';

export async function handleReindex(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let root = process.cwd();

  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--root' && commandArgs[i + 1]) {
      root = commandArgs[++i];
    }
  }

  log('cli', 'reindex root=' + root);

  if (isRunningInContainer()) {
    const serverRunning = await detectRunningServerContainer(DEFAULT_HTTP_PORT);
    if (!serverRunning) {
      cliError(`Error: nano-brain server not reachable at ${getHttpHost()}:${getHttpPort()}. Ensure the Docker container is running:`);
      cliError('  docker start nano-brain');
      process.exit(1);
    }
    try {
      const result = await proxyPostContainer(DEFAULT_HTTP_PORT, '/api/reindex', { root });
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput(`✅ Reindex started in background on daemon for ${result.root}`);
      return;
    } catch (err) {
      cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, root);
  const store = await createStore(resolvedDbPath);
  const projectHash = crypto.createHash('sha256').update(root).digest('hex').substring(0, 12);

  const config = loadCollectionConfig(globalOpts.configPath);
  const wsConfig = getWorkspaceConfig(config, root);
  const codebaseConfig = wsConfig?.codebase ?? { enabled: true };

  cliOutput(`Reindexing codebase: ${root}`);
  const db = openDatabase(resolvedDbPath);
  const stats = await indexCodebase(store, root, codebaseConfig, projectHash, undefined, db);
  cliOutput(`  Files: ${stats.filesIndexed} indexed, ${stats.filesSkippedUnchanged} unchanged`);

  const symbolCount = (db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  cliOutput(`  Symbols: ${symbolCount}, Edges: ${edgeCount}`);

  if (symbolCount === 0 && isTreeSitterAvailable()) {
    cliOutput('  ⚠️  No symbols indexed. Check if your files contain supported languages.');
  } else if (!isTreeSitterAvailable()) {
    cliOutput('  ⚠️  Tree-sitter not available — symbol graph skipped.');
  }

  db.close();
  store.close();
  cliOutput('✅ Reindex complete.');
}
