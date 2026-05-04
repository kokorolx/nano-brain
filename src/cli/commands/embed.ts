import { createStore } from '../../store.js';
import { loadCollectionConfig } from '../../collections.js';
import { createEmbeddingProvider } from '../../embeddings.js';
import { embedPendingCodebase } from '../../codebase.js';
import { createVectorStore } from '../../vector-store.js';
import type { VectorStore } from '../../vector-store.js';
import * as fs from 'fs';
import * as path from 'path';
import { log, cliOutput, cliError } from '../../logger.js';
import { resolveWorkspaceDbPath } from '../../store.js';
import type { GlobalOptions } from '../types.js';
import {
  DEFAULT_HTTP_PORT,
  detectRunningServerContainer,
  proxyPostContainer,
  isRunningInContainer,
  getHttpHost,
  getHttpPort,
} from '../utils.js';

export async function handleEmbed(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let force = false;

  for (const arg of commandArgs) {
    if (arg === '--force') {
      force = true;
    }
  }

  log('cli', 'embed start force=' + force);

  if (isRunningInContainer()) {
    const serverRunning = await detectRunningServerContainer(DEFAULT_HTTP_PORT);
    if (!serverRunning) {
      cliError(`Error: nano-brain server not reachable at ${getHttpHost()}:${getHttpPort()}. Ensure the Docker container is running:`);
      cliError('  docker start nano-brain');
      process.exit(1);
    }
    try {
      const result = await proxyPostContainer(DEFAULT_HTTP_PORT, '/api/embed', {});
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput('✅ Embedding started in background on daemon');
      return;
    } catch (err) {
      cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const config = loadCollectionConfig(globalOpts.configPath);
  const provider = await createEmbeddingProvider({ embeddingConfig: config?.embedding });

  if (!provider) {
    cliError('Failed to load embedding provider');
    process.exit(1);
  }

  let qdrantStore: VectorStore | null = null;
  if (config?.vector?.provider === 'qdrant' && config.vector.url) {
    qdrantStore = createVectorStore(config.vector);
  }

  let totalEmbedded = 0;
  const dataDir = path.dirname(globalOpts.dbPath);

  try {
    const store = await createStore(globalOpts.dbPath);
    if (qdrantStore) store.setVectorStore(qdrantStore);
    const hashes = store.getHashesNeedingEmbedding();
    if (hashes.length > 0) {
      store.ensureVecTable(provider.getDimensions());
      cliOutput(`[${path.basename(process.cwd())}] ${hashes.length} chunks pending...`);
      const embedded = await embedPendingCodebase(store, provider, 50);
      totalEmbedded += embedded;
      cliOutput(`[${path.basename(process.cwd())}] Embedded ${embedded} documents`);
    }
    store.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('malformed') || msg.includes('corrupt')) {
      cliError(`[${path.basename(process.cwd())}] Database corrupted — skipping (delete and re-init to fix)`);
    } else {
      throw err;
    }
  }

  if (config?.workspaces) {
    for (const [wsPath, wsConfig] of Object.entries(config.workspaces)) {
      if (!wsConfig.codebase?.enabled) continue;
      const wsDbPath = resolveWorkspaceDbPath(dataDir, wsPath);
      if (!fs.existsSync(wsDbPath)) continue;
      try {
        const wsStore = await createStore(wsDbPath);
        if (qdrantStore) wsStore.setVectorStore(qdrantStore);
        const wsHashes = wsStore.getHashesNeedingEmbedding();
        if (wsHashes.length > 0) {
          wsStore.ensureVecTable(provider.getDimensions());
          cliOutput(`[${path.basename(wsPath)}] ${wsHashes.length} chunks pending...`);
          const embedded = await embedPendingCodebase(wsStore, provider, 50);
          totalEmbedded += embedded;
          cliOutput(`[${path.basename(wsPath)}] Embedded ${embedded} documents`);
        }
        wsStore.close();
      } catch (err) {
        cliError(`[${path.basename(wsPath)}] Embed failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (totalEmbedded === 0) {
    cliOutput('No chunks need embedding');
  } else {
    cliOutput(`✅ Embedded ${totalEmbedded} documents total`);
  }

  provider.dispose();
  if (qdrantStore) await qdrantStore.close();
}
