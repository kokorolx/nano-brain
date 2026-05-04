import { createStore, openDatabase, resolveWorkspaceDbPath } from '../../store.js';
import { loadCollectionConfig, getWorkspaceConfig } from '../../collections.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth, checkOpenAIHealth } from '../../embeddings.js';
import { getCodebaseStats } from '../../codebase.js';
import { createVectorStore } from '../../vector-store.js';
import type { VectorStoreHealth } from '../../vector-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { DEFAULT_HTTP_PORT, detectRunningServer, proxyGet, resolveDbPath } from '../utils.js';

function extractWorkspaceName(dbFilename: string): string {
  const base = path.basename(dbFilename, '.sqlite');
  const parts = base.split('-');
  if (parts.length > 1 && parts[parts.length - 1].length === 12) {
    return parts.slice(0, -1).join('-');
  }
  return base;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

async function getVectorStoreHealth(config: ReturnType<typeof loadCollectionConfig>): Promise<VectorStoreHealth | null> {
  const vectorConfig = config?.vector;
  if (!vectorConfig || vectorConfig.provider !== 'qdrant') return null;

  try {
    const vectorStore = createVectorStore(vectorConfig);
    const health = await Promise.race([
      vectorStore.health(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    await vectorStore.close();
    return health;
  } catch (err) {
    return {
      ok: false,
      provider: vectorConfig.provider || 'unknown',
      vectorCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printVectorStoreSection(vectorHealth: VectorStoreHealth | null, sqliteVecCount?: number): void {
  cliOutput('Vector Store:');
  if (vectorHealth) {
    cliOutput(`  Provider:   ${vectorHealth.provider}`);
    if (vectorHealth.ok) {
      cliOutput(`  Status:     ✅ connected`);
      cliOutput(`  Vectors:    ${vectorHealth.vectorCount.toLocaleString()}`);
      if (vectorHealth.dimensions) {
        cliOutput(`  Dimensions: ${vectorHealth.dimensions}`);
      }
    } else {
      cliOutput(`  Status:     ❌ unreachable (${vectorHealth.error || 'unknown'})`);
    }
  } else {
    cliOutput(`  Provider:   sqlite-vec (built-in)`);
    cliOutput(`  Vectors:    ${(sqliteVecCount ?? 0).toLocaleString()}`);
  }
  cliOutput('');
}

function printTokenUsageSection(tokenUsage: Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>): void {
  if (tokenUsage.length === 0) return;
  cliOutput('Token Usage:');
  for (const usage of tokenUsage) {
    cliOutput(`  ${usage.model.padEnd(25)} ${usage.totalTokens.toLocaleString()} tokens (${usage.requestCount.toLocaleString()} requests)`);
  }
  cliOutput('');
}

async function printEmbeddingServerStatus(config: ReturnType<typeof loadCollectionConfig>): Promise<void> {
  const embeddingConfig = config?.embedding;
  const url = embeddingConfig?.url || detectOllamaUrl();
  const model = embeddingConfig?.model || 'nomic-embed-text';
  const provider = embeddingConfig?.provider || 'ollama';

  cliOutput('Embedding Server:');
  cliOutput(`  Provider:  ${provider}`);
  cliOutput(`  URL:       ${url}`);
  cliOutput(`  Model:     ${model}`);

  if (provider === 'openai') {
    const openAiHealth = await checkOpenAIHealth(url, embeddingConfig?.apiKey || '', model);
    if (openAiHealth.reachable) {
      cliOutput(`  Status:    ✅ connected`);
    } else {
      cliOutput(`  Status:    ❌ unreachable (${openAiHealth.error})`);
    }
  } else if (provider !== 'local') {
    const ollamaHealth = await checkOllamaHealth(url);
    if (ollamaHealth.reachable) {
      cliOutput(`  Status:    ✅ connected`);
    } else {
      cliOutput(`  Status:    ❌ unreachable (${ollamaHealth.error})`);
    }
  } else {
    cliOutput(`  Status:    local GGUF mode`);
  }
}

export async function handleStatus(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'status command invoked');
  const serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);
  let serverInfo: { uptime: number; ready: boolean } | null = null;
  if (serverRunning) {
    try {
      const data = await proxyGet(DEFAULT_HTTP_PORT, '/api/status') as { uptime?: number; ready?: boolean };
      serverInfo = { uptime: data.uptime ?? 0, ready: data.ready ?? false };
    } catch (err) {
      log('cli', 'HTTP proxy failed for server info: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  const showAll = commandArgs.includes('--all');
  const config = loadCollectionConfig(globalOpts.configPath);
  const dataDir = path.dirname(globalOpts.dbPath);

  if (showAll) {
    let dbFiles: string[] = [];
    try {
      const files = fs.readdirSync(dataDir);
      dbFiles = files.filter(f => f.endsWith('.sqlite')).map(f => path.join(dataDir, f));
    } catch {
      cliError(`Cannot read data directory: ${dataDir}`);
      return;
    }

    if (dbFiles.length === 0) {
      cliOutput('No workspaces found.');
      return;
    }

    cliOutput('nano-brain Status — All Workspaces');
    cliOutput('═══════════════════════════════════════════════════');
    cliOutput('');

    if (serverInfo) {
      const uptimeSec = Math.floor(serverInfo.uptime);
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const secs = uptimeSec % 60;
      const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      cliOutput('Server:');
      cliOutput(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
      cliOutput(`  Uptime:   ${uptimeStr}`);
      cliOutput(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
      cliOutput('');
    }

    const header = '  Workspace              Documents  Embedded  Pending  DB Size';
    const divider = '  ─────────────────────  ─────────  ────────  ───────  ───────';
    cliOutput(header);
    cliOutput(divider);

    let totalDocs = 0;
    let totalEmbedded = 0;
    let totalPending = 0;
    let totalSize = 0;

    for (const dbFile of dbFiles) {
      const workspaceName = extractWorkspaceName(dbFile);
      let fileSize = 0;
      try {
        fileSize = fs.statSync(dbFile).size;
      } catch { /* ignore */ }

      let docs = 0;
      let embedded = 0;
      let pending = 0;
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          docs = (readDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
          embedded = (readDb.prepare('SELECT COUNT(*) as count FROM content_vectors').get() as { count: number }).count;
          pending = docs - embedded;
          if (pending < 0) pending = 0;
        } catch {
        }
        readDb.close();
      } catch { /* ignore */ }

      totalDocs += docs;
      totalEmbedded += embedded;
      totalPending += pending;
      totalSize += fileSize;

      const name = workspaceName.padEnd(21);
      const docsStr = docs.toLocaleString().padStart(9);
      const embeddedStr = embedded.toLocaleString().padStart(8);
      const pendingStr = pending.toLocaleString().padStart(7);
      const sizeStr = formatBytes(fileSize).padStart(9);
      cliOutput(`  ${name}  ${docsStr}  ${embeddedStr}  ${pendingStr}  ${sizeStr}`);
    }

    cliOutput('');
    cliOutput(`  Total: ${dbFiles.length} workspaces, ${totalDocs.toLocaleString()} documents, ${totalPending.toLocaleString()} pending embeddings, ${formatBytes(totalSize)}`);
    cliOutput('');

    await printEmbeddingServerStatus(config);
    cliOutput('');

    const vectorHealth = await getVectorStoreHealth(config);
    printVectorStoreSection(vectorHealth);

    const allTokenUsage = new Map<string, { totalTokens: number; requestCount: number; lastUpdated: string }>();
    for (const dbFile of dbFiles) {
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          const rows = readDb.prepare('SELECT model, total_tokens as totalTokens, request_count as requestCount, last_updated as lastUpdated FROM token_usage').all() as Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>;
          for (const row of rows) {
            const existing = allTokenUsage.get(row.model);
            if (existing) {
              existing.totalTokens += row.totalTokens;
              existing.requestCount += row.requestCount;
              if (row.lastUpdated > existing.lastUpdated) existing.lastUpdated = row.lastUpdated;
            } else {
              allTokenUsage.set(row.model, { totalTokens: row.totalTokens, requestCount: row.requestCount, lastUpdated: row.lastUpdated });
            }
          }
        } catch { /* token_usage table may not exist in older DBs */ }
        readDb.close();
      } catch { /* ignore */ }
    }
    const aggregatedUsage = [...allTokenUsage.entries()].map(([model, data]) => ({ model, ...data })).sort((a, b) => b.totalTokens - a.totalTokens);
    printTokenUsageSection(aggregatedUsage);

    return;
  }

  const workspaceRoot = process.cwd();
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const workspaceName = extractWorkspaceName(resolvedDbPath);
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  let dbSize = 0;
  try {
    dbSize = fs.statSync(resolvedDbPath).size;
  } catch { /* ignore */ }

  const store = await createStore(resolvedDbPath);
  const health = store.getIndexHealth();

  cliOutput(`nano-brain Status — ${workspaceName}`);
  cliOutput('═══════════════════════════════════════════════════');
  cliOutput('');

  if (serverInfo) {
    const uptimeSec = Math.floor(serverInfo.uptime);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    cliOutput('Server:');
    cliOutput(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
    cliOutput(`  Uptime:   ${uptimeStr}`);
    cliOutput(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
    cliOutput('');
  }

  cliOutput('Database:');
  cliOutput(`  Path:     ${resolvedDbPath.replace(os.homedir(), '~')}`);
  cliOutput(`  Size:     ${formatBytes(dbSize)} (on disk)`);
  cliOutput('');

  cliOutput('Index:');
  cliOutput(`  Documents:          ${health.documentCount.toLocaleString()}`);
  cliOutput(`  Embedded:           ${health.embeddedCount.toLocaleString()}`);
  cliOutput(`  Pending embeddings: ${health.pendingEmbeddings.toLocaleString()}`);
  cliOutput('');

  if (health.collections.length > 0) {
    cliOutput('Collections:');
    for (const coll of health.collections) {
      cliOutput(`  ${coll.name.padEnd(10)} ${coll.documentCount.toLocaleString()} documents`);
    }
    cliOutput('');
  }

  const wsConfig = getWorkspaceConfig(config, workspaceRoot);
  const codebaseStats = getCodebaseStats(store, wsConfig?.codebase, workspaceRoot);
  if (codebaseStats) {
    cliOutput('Codebase:');
    cliOutput(`  Enabled:    ${codebaseStats.enabled}`);
    cliOutput(`  Storage:    ${formatBytes(codebaseStats.storageUsed)} / ${formatBytes(codebaseStats.maxSize)}`);
    cliOutput(`  Extensions: ${codebaseStats.extensions.join(', ') || 'auto-detect'}`);
    cliOutput(`  Excludes:   ${codebaseStats.excludeCount} patterns`);
    cliOutput('');
  }

  try {
    const symbolDb = openDatabase(resolvedDbPath);
    const symbolCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    const edgeCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    let flowCount = 0;
    try {
      flowCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM execution_flows WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    } catch { /* table may not exist */ }
    symbolDb.close();

    cliOutput('Code Intelligence:');
    cliOutput(`  Symbols:    ${symbolCount.toLocaleString()}`);
    cliOutput(`  Edges:      ${edgeCount.toLocaleString()}`);
    cliOutput(`  Flows:      ${flowCount.toLocaleString()}`);
    if (symbolCount === 0) {
      cliOutput('  ⚠️  Empty — run `npx nano-brain reindex` to populate');
    }
    cliOutput('');
  } catch { /* code_symbols table may not exist in older DBs */ }

  await printEmbeddingServerStatus(config);
  cliOutput('');

  const vectorHealth = await getVectorStoreHealth(config);
  printVectorStoreSection(vectorHealth, vectorHealth ? undefined : store.getSqliteVecCount());

  printTokenUsageSection(store.getTokenUsage());

  const embeddingModel = config?.embedding?.model
    ? `${config.embedding.model} (${config.embedding.provider ?? 'ollama'})`
    : 'missing';
  const rerankerModel = config?.reranker?.model
    ? `${config.reranker.model} (no endpoint — set reranker.apiKey)`
    : 'missing';
  const expanderModel = config?.search?.expansion?.enabled ? 'enabled' : 'disabled';

  cliOutput('Models:');
  cliOutput(`  Embedding: ${embeddingModel}`);
  cliOutput(`  Reranker:  ${rerankerModel}`);
  cliOutput(`  Expander:  ${expanderModel}`);
  store.close();
}
