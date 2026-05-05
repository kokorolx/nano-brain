import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteEventStore } from '../event-store.js';
import type { ServerOptions, ServerDeps } from './types.js';
import { log, initLogger, setStdioMode } from '../logger.js';
import { loadCollectionConfig, getCollections, getWorkspaceConfig } from '../collections.js';
import { parseStorageConfig } from '../storage.js';
import { createStore, resolveWorkspaceDbPath, setProjectLabelDataDir, migrateToRelativePaths, cleanupDuplicatePaths, getLastCorruptionRecovery, closeAllCachedStores } from '../store.js';
import { backfillQdrantProjectHash } from '../store/vectors.js';
import { parseSearchConfig } from '../search.js';
import { createVectorStore, type VectorStore } from '../vector-store.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth } from '../embeddings.js';
import { createReranker } from '../reranker.js';
import { createLLMQueryExpander } from '../expansion.js';
import { startWatcher } from '../watcher.js';
import { initFTSWorker, shutdownFTSWorker } from '../fts-client.js';
import { ConsolidationWorker } from '../consolidation-worker.js';
import { createLLMProvider } from '../llm-provider.js';
import { createMcpServer } from '../mcp/index.js';
import { createHttpServer } from '../http/server.js';
import { handleRequest, type HttpContext } from '../http/routes.js';
import { sseSessions } from '../http/sse.js';
import type { WatcherConfig } from '../types.js';
import { ThompsonSampler, DEFAULT_BANDIT_CONFIGS } from '../bandits.js';

export function createRejectionThreshold(limit: number, windowMs: number): { handler: (err: unknown) => void; getCount: () => number; setOnExit: (fn: () => void) => void } {
  let count = 0;
  let onExit: (() => void) | null = null;
  const handler = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log('server', `Unhandled rejection: ${error.message}`, 'error');
    if (error.stack) log('server', error.stack, 'error');
    log('server', `Unhandled rejection: ${error.message}`);
    count++;
    setTimeout(() => { count = Math.max(0, count - 1); }, windowMs).unref();
    if (count >= limit) {
      log('server', `Rejection threshold exceeded (${count} in ${windowMs}ms) — exiting`, 'error');
      log('server', `Rejection threshold exceeded (${count} in ${windowMs}ms) — exiting`);
      if (onExit) onExit(); else process.exit(1);
    }
  };
  return { handler, getCount: () => count, setOnExit: (fn) => { onExit = fn; } };
}

export async function startServer(options: ServerOptions): Promise<void> {
  process.stdout?.on('error', () => {});
  process.stderr?.on('error', () => {});

  const { dbPath, configPath, httpPort, httpHost = '127.0.0.1', daemon, root } = options;
  const isStdioTransport = !httpPort;
  if (isStdioTransport) {
    setStdioMode(true);
  }

  let cleanupRef: (() => void) | null = null;

  process.on('uncaughtException', (err: Error) => {
    if ('code' in err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
      log('server', `Ignoring EPIPE: ${err.message}`);
      return;
    }
    try { log('server', `Uncaught exception: ${err.message}`, 'error'); } catch {}
    try { if (err.stack) log('server', err.stack, 'error'); } catch {}
    log('server', `Uncaught exception: ${err.message}\n${err.stack || ''}`);
    if (cleanupRef) cleanupRef(); else process.exit(1);
  });

  const rejectionThreshold = createRejectionThreshold(3, 60000);
  process.on('unhandledRejection', rejectionThreshold.handler);

  const homeDir = os.homedir();
  const nanoBrainHome = path.join(homeDir, '.nano-brain');
  const outputDir = nanoBrainHome;
  const finalConfigPath = configPath || path.join(outputDir, 'collections.yaml');
  const config = loadCollectionConfig(finalConfigPath);
  initLogger(config ?? undefined);
  const collections = config ? getCollections(config) : [];
  const storageConfig = parseStorageConfig(config?.storage);
  let resolvedWorkspaceRoot: string;
  if (daemon && config?.workspaces && Object.keys(config.workspaces).length > 0) {
    const configuredWorkspaces = Object.keys(config.workspaces);
    resolvedWorkspaceRoot = configuredWorkspaces[0];
    log('server', `Daemon mode: primary workspace = ${resolvedWorkspaceRoot}`);
  } else {
    resolvedWorkspaceRoot = root || process.cwd();
  }
  const wsConfig = getWorkspaceConfig(config, resolvedWorkspaceRoot);
  const resolvedCodebaseConfig = wsConfig.codebase;
  const currentProjectHash = crypto.createHash('sha256').update(resolvedWorkspaceRoot).digest('hex').substring(0, 12);
  const isDefaultDb = dbPath.endsWith('/default.sqlite') || dbPath.endsWith('\\default.sqlite');
  const effectiveDbPath = isDefaultDb ? resolveWorkspaceDbPath(path.dirname(dbPath), resolvedWorkspaceRoot) : dbPath;
  setProjectLabelDataDir(path.dirname(effectiveDbPath));
  log('server', 'Workspace path=' + resolvedWorkspaceRoot + ' hash=' + currentProjectHash);
  log('server', `Workspace: ${resolvedWorkspaceRoot} (${currentProjectHash})`);
  log('server', 'Database path=' + effectiveDbPath);
  log('server', `Database: ${effectiveDbPath}`);
  log('server', 'Config path=' + finalConfigPath);
  const store = createStore(effectiveDbPath);
  store.registerWorkspacePrefix(currentProjectHash, resolvedWorkspaceRoot);
  migrateToRelativePaths(store, currentProjectHash, resolvedWorkspaceRoot);
  cleanupDuplicatePaths(store, currentProjectHash, resolvedWorkspaceRoot);
  const symbolGraphDb = store.getDb();

  const validateInterval = (value: number | undefined, name: string, defaultVal: number): number => {
    if (value === undefined) return defaultVal;
    if (value <= 0 || value > 3600) {
      log('server', `Warning: intervals.${name}=${value} invalid (must be 1-3600), using default ${defaultVal}`, 'warn');
      return defaultVal;
    }
    return value;
  };
  const validatedIntervals = config?.intervals ? {
    embed: validateInterval(config.intervals.embed, 'embed', 60),
    sessionPoll: validateInterval(config.intervals.sessionPoll, 'sessionPoll', 120),
    reindexPoll: validateInterval(config.intervals.reindexPoll, 'reindexPoll', 120),
  } : undefined;

  let vectorStore: VectorStore | null = null;
  const configuredDimensions = config?.vector?.dimensions;
  if (config?.vector?.provider === 'qdrant') {
    try {
      vectorStore = createVectorStore(config.vector);
      vectorStore.health().then((health) => {
        log('server', '🗄️  Qdrant connected provider=' + health.provider + ' ok=' + health.ok + ' vectors=' + health.vectorCount);
        log('server', `🗄️  Qdrant connected: ${health.provider} (ok=${health.ok}, vectors=${health.vectorCount})`);
        if (health.dimensions && configuredDimensions && health.dimensions !== configuredDimensions) {
          log('server', 'vector dimension mismatch config=' + configuredDimensions + ' qdrant=' + health.dimensions);
          log('server', `Vector dimension mismatch: config=${configuredDimensions}, qdrant=${health.dimensions}`, 'warn');
          log('server', 'Will validate against embedder dimensions after provider loads.', 'warn');
        }
      }).catch((err) => {
        log('server', '❌ Qdrant health check failed error=' + (err instanceof Error ? err.message : String(err)));
        log('server', `❌ Qdrant health check failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      });
    } catch (err) {
      log('server', 'vector store creation failed error=' + (err instanceof Error ? err.message : String(err)));
      log('server', `Vector store creation failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  } else {
    log('server', '🗄️  Vector store: sqlite-vec (default)');
    log('server', '🗄️  Vector store: sqlite-vec (default)');
  }

  if (vectorStore) {
    store.setVectorStore(vectorStore);
  }

  let embedder: import('../search.js').SearchProviders['embedder'] = null;
  let reranker: import('../search.js').SearchProviders['reranker'] = null;

  const providers: import('../search.js').SearchProviders = {
    embedder,
    reranker,
    expander: null,
  };

  store.modelStatus = {
    embedding: 'loading...',
    reranker: 'loading...',
    expander: 'disabled',
  };

  const recovery = getLastCorruptionRecovery();
  const corruptionWarningPending = recovery?.recovered
    ? { value: true, corruptedPath: recovery.corruptedPath }
    : { value: false };

  const deps: ServerDeps = {
    store,
    providers,
    collections,
    configPath: finalConfigPath,
    outputDir,
    storageConfig,
    currentProjectHash,
    codebaseConfig: resolvedCodebaseConfig,
    embeddingConfig: config?.embedding,
    workspaceRoot: resolvedWorkspaceRoot,
    searchConfig: parseSearchConfig(config?.search),
    db: symbolGraphDb,
    allWorkspaces: config?.workspaces,
    dataDir: path.dirname(effectiveDbPath),
    daemon: daemon ?? false,
    corruptionWarningPending,
  };

  const server = createMcpServer(deps);

  let watcher: ReturnType<typeof startWatcher> | null = null;
  let watcherStarted = false;

  const watcherRef = { value: watcher as ReturnType<typeof startWatcher> | null };
  const watcherStartedRef = { value: watcherStarted };

  const startFileWatcher = () => {
    if (watcherStartedRef.value) {
      return;
    }
    watcherStartedRef.value = true;

    if (watcherRef.value) {
      try { watcherRef.value.stop(); } catch {}
      watcherRef.value = null;
    }

    log('server', 'Starting file watcher');

    if (config?.workspaces) {
      const wsPaths = Object.keys(config.workspaces).sort()
      for (let i = 0; i < wsPaths.length; i++) {
        for (let j = i + 1; j < wsPaths.length; j++) {
          const a = wsPaths[i].endsWith('/') ? wsPaths[i] : wsPaths[i] + '/'
          const b = wsPaths[j].endsWith('/') ? wsPaths[j] : wsPaths[j] + '/'
          if (b.startsWith(a)) {
            const nameA = path.basename(wsPaths[i])
            const nameB = path.basename(wsPaths[j])
            log('server', `Note: ${nameB} is a sub-workspace of ${nameA} — documents indexed under both`)
            log('config', `Sub-workspace: ${nameB} is inside ${nameA} — documents indexed under both`)
          }
        }
      }
    }

    const watcherConfig: WatcherConfig | undefined = config?.watcher;
    watcherRef.value = startWatcher({
      store,
      collections,
      embedder: providers.embedder,
      db: symbolGraphDb,
      debounceMs: watcherConfig?.debounceMs ?? 2000,
      pollIntervalMs: validatedIntervals?.reindexPoll ? validatedIntervals.reindexPoll * 1000 : (watcherConfig?.pollIntervalMs ?? 120000),
      sessionPollMs: validatedIntervals?.sessionPoll ? validatedIntervals.sessionPoll * 1000 : (watcherConfig?.sessionPollMs ?? 120000),
      embedIntervalMs: validatedIntervals?.embed ? validatedIntervals.embed * 1000 : (watcherConfig?.embedIntervalMs ?? 60000),
      reindexCooldownMs: watcherConfig?.reindexCooldownMs,
      embedQuietPeriodMs: watcherConfig?.embedQuietPeriodMs,
      sessionStorageDir: path.join(homeDir, '.local/share/opencode/storage'),
      outputDir: path.join(outputDir, 'sessions'),
      storageConfig,
      dbPath,
      allWorkspaces: config?.workspaces,
      dataDir: path.dirname(effectiveDbPath),
      onUpdate: (filePath) => {
        if (!daemon) {
          log('watcher', `File changed: ${filePath}`);
        }
      },
      codebaseConfig: resolvedCodebaseConfig,
      workspaceRoot: resolvedWorkspaceRoot,
      projectHash: currentProjectHash,
      vectorStore,
    });
    watcher = watcherRef.value;
  };

  const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  let httpServer: ReturnType<typeof createHttpServer> | null = null;
  let consolidationWorker: ConsolidationWorker | null = null;

  const cleanup = async () => {
    log('server', 'Shutting down');

    if (httpServer) {
      httpServer.close();
    }

    if (consolidationWorker) {
      await consolidationWorker.stop();
    }

    for (const [_id, session] of sseSessions) {
      try { await session.transport.close(); } catch {}
    }
    for (const [_id, session] of streamableSessions) {
      try { await session.transport.close(); } catch {}
    }

    if (watcherRef.value) watcherRef.value.stop();
    await shutdownFTSWorker();
    try { symbolGraphDb.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore checkpoint errors */ }
    symbolGraphDb.close();
    closeAllCachedStores();
    process.exit(0);
  };
  cleanupRef = cleanup;
  rejectionThreshold.setOnExit(cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  const readyState = { value: false };
  deps.ready = readyState;

  const maintenanceModeRef = { value: false };
  const maintenanceTimerRef: { value: NodeJS.Timeout | null } = { value: null };

  if (httpPort) {
    try {
      await initFTSWorker(effectiveDbPath);
    } catch (err) {
      log('server', 'FTS worker init failed, search will use main thread: ' + (err instanceof Error ? err.message : String(err)), 'warn');
    }

    const eventStore = new SqliteEventStore(symbolGraphDb, 300);
    const eventStoreCleanupInterval = setInterval(() => eventStore.cleanup(), 60000);
    eventStoreCleanupInterval.unref();

    const httpCtx: HttpContext = {
      deps,
      mcpServer: server,
      streamableSessions,
      maintenanceModeRef,
      maintenanceTimerRef,
      startFileWatcher,
      watcherRef,
      watcherStartedRef,
      readyState,
      resolvedWorkspaceRoot,
      currentProjectHash,
      outputDir,
      effectiveDbPath,
      finalConfigPath,
      symbolGraphDb,
      eventStore,
    };

    httpServer = createHttpServer(httpPort, httpHost, async (req, res) => {
      await handleRequest(req, res, httpCtx);
    });
  } else {
    setStdioMode(true);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('server', '🔌 MCP server started on stdio');
  }

  Promise.all([
    createEmbeddingProvider({ embeddingConfig: config?.embedding, onTokenUsage: (model, tokens) => store.recordTokenUsage(model, tokens) })
      .then((loadedEmbedder) => {
        providers.embedder = loadedEmbedder;
        store.modelStatus.embedding = loadedEmbedder ? loadedEmbedder.getModel() : 'missing';
        if (loadedEmbedder) {
          store.ensureVecTable(loadedEmbedder.getDimensions());
          if (config?.vector?.provider === 'qdrant' && config.vector.url) {
            const correctStore = createVectorStore({ ...config.vector, dimensions: loadedEmbedder.getDimensions() });
            store.setVectorStore(correctStore);
            log('server', 'vector store reinitialized dims=' + loadedEmbedder.getDimensions());
          }
        }
         log('server', '🧠 Embedding provider ready model=' + store.modelStatus.embedding);
         log('server', `🧠 Embedding provider ready: ${store.modelStatus.embedding}`);
        startFileWatcher();
      })
      .catch((err) => {
         store.modelStatus.embedding = 'failed';
         log('server', '❌ Embedding provider failed error=' + (err instanceof Error ? err.message : String(err)));
         log('server', `❌ Embedding provider failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        startFileWatcher();
      }),
    createReranker({
      apiKey: config?.reranker?.apiKey || config?.embedding?.apiKey,
      model: config?.reranker?.model,
      onTokenUsage: (model, tokens) => store.recordTokenUsage(model, tokens),
    })
      .then((loadedReranker) => {
        providers.reranker = loadedReranker;
        store.modelStatus.reranker = loadedReranker ? (config?.reranker?.model || 'rerank-2.5-lite') : 'disabled';
         log('server', '🔀 Reranker ready model=' + store.modelStatus.reranker);
         log('server', `🔀 Reranker ready: ${store.modelStatus.reranker}`);
      })
      .catch((err) => {
         store.modelStatus.reranker = 'failed';
         log('server', '❌ Reranker failed error=' + (err instanceof Error ? err.message : String(err)));
         log('server', `❌ Reranker failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }),
  ]).then(() => {
    readyState.value = true;
    log('server', '✅ Server ready (Phase 2 complete)');
    log('server', '✅ Server ready');

    const currentVectorStore = store.getVectorStore();
    if (currentVectorStore) {
      backfillQdrantProjectHash(store.getDb(), currentVectorStore).catch(err => {
        log('server', 'backfillQdrantProjectHash failed err=' + (err instanceof Error ? err.message : String(err)), 'warn');
      });
    }

    if (config?.consolidation?.enabled) {
      const consolidationConfig = config.consolidation as import('../types.js').ConsolidationConfig;
      const llmProvider = createLLMProvider(consolidationConfig);
      if (llmProvider) {
        consolidationWorker = new ConsolidationWorker({
          store,
          llmProvider,
          pollingIntervalMs: consolidationConfig.interval_ms ?? 5000,
          maxCandidates: consolidationConfig.max_memories_per_cycle ?? 5,
        });
        consolidationWorker.start();
        log('server', '🔄 Consolidation worker started');

        providers.expander = createLLMQueryExpander(llmProvider);
        store.modelStatus.expander = 'llm:' + (llmProvider.model ?? 'unknown');
        log('server', 'Query expander enabled with LLM');
       } else {
         log('server', '⚠️  Consolidation enabled but no LLM provider configured');
         log('server', '⚠️  Consolidation enabled but no LLM provider configured', 'warn');
       }
    }
  });

  const embeddingConfig = config?.embedding;
  if (!embeddingConfig || embeddingConfig.provider !== 'local') {
    const ollamaUrl = embeddingConfig?.url || detectOllamaUrl();
    const ollamaModel = embeddingConfig?.model || 'mxbai-embed-large';
    let startedWithLocalGGUF = false;

    setTimeout(() => {
      if (store.modelStatus.embedding === 'nomic-embed-text-v1.5') {
        startedWithLocalGGUF = true;
      }
    }, 5000);

    const reconnectTimer = setInterval(async () => {
      if (!startedWithLocalGGUF) {
        clearInterval(reconnectTimer);
        return;
      }
      if (store.modelStatus.embedding === ollamaModel) {
        clearInterval(reconnectTimer);
        return;
      }
      try {
        const health = await checkOllamaHealth(ollamaUrl);
        if (health.reachable) {
          const newProvider = await createEmbeddingProvider({ embeddingConfig: { provider: 'ollama', url: ollamaUrl, model: ollamaModel }, onTokenUsage: (model, tokens) => store.recordTokenUsage(model, tokens) });
          if (newProvider) {
            const oldProvider = providers.embedder;
            providers.embedder = newProvider;
            store.modelStatus.embedding = newProvider.getModel();
            store.ensureVecTable(newProvider.getDimensions());
            if (oldProvider && 'dispose' in oldProvider) (oldProvider as { dispose(): void }).dispose();
             log('server', '🦙 Reconnected to Ollama url=' + ollamaUrl + ' model=' + ollamaModel);
             log('server', `🦙 Reconnected to Ollama at ${ollamaUrl} — switched from local GGUF`);
            startedWithLocalGGUF = false;
            clearInterval(reconnectTimer);
          }
        }
      } catch {
      }
    }, 60000);

    reconnectTimer.unref();
  }

  if (!resolvedCodebaseConfig?.enabled) {
    startFileWatcher();
  }
}
