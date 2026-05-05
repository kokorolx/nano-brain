import { createStore } from '../../store.js';
import { loadCollectionConfig } from '../../collections.js';
import { createEmbeddingProvider } from '../../embeddings.js';
import { hybridSearch, parseSearchConfig } from '../../search.js';
import { createReranker } from '../../reranker.js';
import { createVectorStore } from '../../vector-store.js';
import { ResultCache } from '../../cache.js';
import { formatCompactResults } from '../../server.js';
import type { SearchResult } from '../../types.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { isInsideContainer } from '../../host.js';
import {
  DEFAULT_HTTP_PORT,
  detectRunningServer,
  proxyPost,
  getHttpHost,
  getHttpPort,
} from '../utils.js';
import { formatSearchOutput } from '../utils.js';

export async function handleSearch(
  globalOpts: GlobalOptions,
  commandArgs: string[],
  mode: 'fts' | 'vec' | 'hybrid'
): Promise<void> {
  log('cli', 'search mode=' + mode + ' query=' + (commandArgs[0] || ''));
  const query = commandArgs[0];

  if (!query) {
    cliError('Missing query argument');
    process.exit(1);
  }

  let limit = 10;
  let collection: string | undefined;
  let format: 'text' | 'json' | 'files' = 'text';
  let minScore = 0;
  let scope: 'workspace' | 'all' = 'workspace';
  let tags: string[] | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let compact = false;

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i];

    if (arg === '-n' && i + 1 < commandArgs.length) {
      limit = parseInt(commandArgs[++i], 10);
    } else if (arg === '-c' && i + 1 < commandArgs.length) {
      collection = commandArgs[++i];
    } else if (arg === '--json') {
      format = 'json';
    } else if (arg === '--files') {
      format = 'files';
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg.startsWith('--min-score=')) {
      minScore = parseFloat(arg.substring(12));
    } else if (arg === '--scope=all' || arg === '--scope' && commandArgs[i + 1] === 'all') {
      scope = 'all';
      if (arg === '--scope') i++;
    } else if (arg.startsWith('--tags=')) {
      tags = arg.substring(7).split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
    } else if (arg.startsWith('--since=')) {
      since = arg.substring(8);
    } else if (arg.startsWith('--until=')) {
      until = arg.substring(8);
    }
  }

  const inContainer = isInsideContainer();
  const serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);

  if (inContainer && !serverRunning) {
    cliError(`Error: nano-brain server not reachable at ${getHttpHost()}:${getHttpPort()}. Ensure the Docker container is running:`);
    cliError('  docker start nano-brain');
    process.exit(1);
  }

  if (serverRunning) {
    try {
      const endpoint = mode === 'fts' ? '/api/search' : '/api/query';
      const data = await proxyPost(DEFAULT_HTTP_PORT, endpoint, { query, limit, tags: tags?.join(','), scope });
      if (format === 'json') {
        cliOutput(JSON.stringify(data, null, 2));
      } else if (format === 'files') {
        cliOutput(data.results?.map((r: any) => r.path).join('\n') || '');
      } else if (compact) {
        const cache = new ResultCache();
        const cacheKey = cache.set(data.results || [], query);
        cliOutput(formatCompactResults(data.results || [], cacheKey));
      } else {
        cliOutput(formatSearchOutput(data.results || [], 'text'));
      }
      return;
    } catch (err) {
      if (inContainer) {
        cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log('cli', 'HTTP proxy failed, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const workspaceRoot = process.cwd();
  const projectHash = scope === 'all' ? 'all' : crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  const store = await createStore(globalOpts.dbPath);
  let results: SearchResult[];

  if (mode === 'fts') {
    results = store.searchFTS(query, { limit, collection, projectHash, tags, since, until });
  } else if (mode === 'vec') {
    const searchConfig = loadCollectionConfig(globalOpts.configPath);
    if (searchConfig?.vector?.provider === 'qdrant' && searchConfig.vector.url) {
      const vs = createVectorStore(searchConfig.vector);
      store.setVectorStore(vs);
    }
    const provider = await createEmbeddingProvider({ embeddingConfig: searchConfig?.embedding });
    if (!provider) {
      cliError('Vector search requires embedding model');
      store.close();
      process.exit(1);
    }

    const { embedding } = await provider.embed(query);
    results = await store.searchVecAsync(query, embedding, { limit, collection, projectHash, tags, since, until });
    provider.dispose();
  } else {
    const searchConfig = loadCollectionConfig(globalOpts.configPath);
    if (searchConfig?.vector?.provider === 'qdrant' && searchConfig.vector.url) {
      const vs = createVectorStore(searchConfig.vector);
      store.setVectorStore(vs);
    }
    const provider = await createEmbeddingProvider({ embeddingConfig: searchConfig?.embedding });
    const reranker = await createReranker({
      apiKey: searchConfig?.reranker?.apiKey || searchConfig?.embedding?.apiKey,
      model: searchConfig?.reranker?.model,
    });
    results = await hybridSearch(
      store,
      { query, limit, collection, minScore, projectHash, tags, since, until },
      { embedder: provider, reranker }
    );
    reranker?.dispose();
    provider?.dispose();
  }

  if (compact && format !== 'json') {
    const cache = new ResultCache();
    const cacheKey = cache.set(results, query);
    cliOutput(formatCompactResults(results, cacheKey));
  } else {
    cliOutput(formatSearchOutput(results, format));
  }
  store.close();
}
