import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Store, SearchResult, IndexHealth, Collection, StorageConfig, CodebaseConfig, EmbeddingConfig, WatcherConfig } from './types.js'
import type { SearchProviders } from './search.js';
import { hybridSearch } from './search.js';
import { createStore } from './store.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles } from './collections.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth } from './embeddings.js';
import { createReranker } from './reranker.js';
import { startWatcher } from './watcher.js';
import { parseStorageConfig } from './storage.js';
import { indexCodebase, getCodebaseStats, embedPendingCodebase } from './codebase.js'

export interface ServerOptions {
  dbPath: string;
  configPath?: string;
  httpPort?: number;
  daemon?: boolean;
}

export interface ServerDeps {
  store: Store
  providers: SearchProviders
  collections: Collection[]
  configPath: string
  outputDir: string
  storageConfig?: StorageConfig
  currentProjectHash: string
  codebaseConfig?: CodebaseConfig
  workspaceRoot: string
  embeddingConfig?: EmbeddingConfig
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }
  
  return results.map((r, i) => 
    `### ${i + 1}. ${r.title} (${r.docid})\n` +
    `**Path:** ${r.path} | **Score:** ${r.score.toFixed(3)} | **Lines:** ${r.startLine}-${r.endLine}\n\n` +
    `${r.snippet}\n`
  ).join('\n---\n\n');
}

export function formatStatus(
  health: IndexHealth,
  codebaseStats?: { enabled: boolean; documents: number; chunks: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number },
  embeddingHealth?: { provider: string; url: string; model: string; reachable: boolean; models?: string[]; error?: string }
): string {
  const lines = [
    `📊 **Memory Index Status**`,
    `Documents: ${health.documentCount} | Chunks: ${health.chunkCount} | Pending embeddings: ${health.pendingEmbeddings}`,
    `Database size: ${(health.databaseSize / 1024 / 1024).toFixed(1)} MB`,
    ``,
    `**Collections:**`,
    ...health.collections.map(c => `  - ${c.name}: ${c.documentCount} docs (${c.path})`),
    ``,
    `**Models:**`,
    `  - Embedding: ${health.modelStatus.embedding}`,
    `  - Reranker: ${health.modelStatus.reranker}`,
    `  - Expander: ${health.modelStatus.expander}`,
  ]
  if (embeddingHealth) {
    lines.push(``)
    lines.push(`**Embedding Server:**`)
    lines.push(`  - Provider: ${embeddingHealth.provider}`)
    lines.push(`  - URL: ${embeddingHealth.url}`)
    lines.push(`  - Model: ${embeddingHealth.model}`)
    if (embeddingHealth.reachable) {
      const hasModel = embeddingHealth.models?.some(m => m.startsWith(embeddingHealth.model))
      lines.push(`  - Status: ✅ connected`)
      lines.push(`  - Model available: ${hasModel ? '✅ yes' : '❌ not found — run: ollama pull ' + embeddingHealth.model}`)
    } else {
      lines.push(`  - Status: ❌ unreachable (${embeddingHealth.error})`)
      lines.push(`  - Fallback: local GGUF (node-llama-cpp)`)
    }
  }
  if (codebaseStats) {
    const usedMB = (codebaseStats.storageUsed / 1024 / 1024).toFixed(1)
    const maxMB = (codebaseStats.maxSize / 1024 / 1024).toFixed(0)
    lines.push(``)
    lines.push(`**Codebase:**`)
    lines.push(`  - Enabled: ${codebaseStats.enabled}`)
    lines.push(`  - Documents: ${codebaseStats.documents}`)
    lines.push(`  - Storage: ${usedMB}MB / ${maxMB}MB`)
    lines.push(`  - Extensions: ${codebaseStats.extensions.join(', ')}`)
    lines.push(`  - Exclude patterns: ${codebaseStats.excludeCount}`)
  }
  if (health.workspaceStats && health.workspaceStats.length > 0) {
    lines.push(``)
    lines.push(`**Workspaces:**`)
    for (const ws of health.workspaceStats) {
      lines.push(`  - ${ws.projectHash}: ${ws.count} docs`)
    }
  }
  return lines.join('\n')
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { store, providers, collections, configPath, outputDir, currentProjectHash } = deps;
  
  const server = new McpServer(
    {
      name: 'nano-brain',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  
  server.tool(
    'memory_search',
    'BM25 full-text keyword search across indexed documents',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
      collection: z.string().optional().describe('Filter by collection name'),
      workspace: z.string().optional().describe('Filter by workspace hash. Omit for current workspace, "all" for cross-workspace search'),
    },
    async ({ query, limit, collection, workspace }) => {
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const results = store.searchFTS(query, limit, collection, effectiveWorkspace);
      return {
        content: [
          {
            type: 'text',
            text: formatSearchResults(results),
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_vsearch',
    'Semantic vector search using embeddings',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
      collection: z.string().optional().describe('Filter by collection name'),
      workspace: z.string().optional().describe('Filter by workspace hash. Omit for current workspace, "all" for cross-workspace search'),
    },
    async ({ query, limit, collection, workspace }) => {
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      if (providers.embedder) {
        try {
          const { embedding } = await providers.embedder.embed(query);
          const results = store.searchVec(query, embedding, limit, collection, effectiveWorkspace);
          return {
            content: [
              {
                type: 'text',
                text: formatSearchResults(results),
              },
            ],
          };
        } catch (err) {
          const fallbackResults = store.searchFTS(query, limit, collection, effectiveWorkspace);
          return {
            content: [
              {
                type: 'text',
                text: `⚠️  Vector search failed, falling back to FTS: ${err instanceof Error ? err.message : String(err)}\n\n${formatSearchResults(fallbackResults)}`,
              },
            ],
          };
        }
      } else {
        const fallbackResults = store.searchFTS(query, limit, collection, effectiveWorkspace);
        return {
          content: [
            {
              type: 'text',
              text: `⚠️  Embedder not available, falling back to FTS\n\n${formatSearchResults(fallbackResults)}`,
            },
          ],
        };
      }
    }
  );
  
  server.tool(
    'memory_query',
    'Full hybrid search with query expansion, RRF fusion, and LLM reranking',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
      collection: z.string().optional().describe('Filter by collection name'),
      minScore: z.number().optional().default(0).describe('Minimum score threshold'),
      workspace: z.string().optional().describe('Filter by workspace hash. Omit for current workspace, "all" for cross-workspace search'),
    },
    async ({ query, limit, collection, minScore, workspace }) => {
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const results = await hybridSearch(
        store,
        { query, limit, collection, minScore, projectHash: effectiveWorkspace },
        providers
      );
      
      return {
        content: [
          {
            type: 'text',
            text: formatSearchResults(results),
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_get',
    'Retrieve a document by path or docid (#abc123)',
    {
      id: z.string().describe('Document path or docid (6-char hash prefix with # prefix)'),
      fromLine: z.number().optional().describe('Start line number'),
      maxLines: z.number().optional().describe('Maximum number of lines to return'),
    },
    async ({ id, fromLine, maxLines }) => {
      const docid = id.startsWith('#') ? id.slice(1) : id;
      const doc = store.findDocument(docid);
      
      if (!doc) {
        return {
          content: [
            {
              type: 'text',
              text: `Document not found: ${id}`,
            },
          ],
          isError: true,
        };
      }
      
      const body = store.getDocumentBody(doc.hash, fromLine, maxLines);
      return {
        content: [
          {
            type: 'text',
            text: body ?? '',
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_multi_get',
    'Batch retrieve documents by glob pattern or comma-separated list',
    {
      pattern: z.string().describe('Glob pattern or comma-separated docids/paths'),
      maxBytes: z.number().optional().default(50000).describe('Maximum total bytes to return'),
    },
    async ({ pattern, maxBytes }) => {
      const ids = pattern.split(',').map(s => s.trim());
      
      let totalBytes = 0;
      const results: string[] = [];
      
      for (const id of ids) {
        const docid = id.startsWith('#') ? id.slice(1) : id;
        const doc = store.findDocument(docid);
        
        if (!doc) {
          results.push(`### Document not found: ${id}\n`);
          continue;
        }
        
        const body = store.getDocumentBody(doc.hash);
        if (!body) {
          results.push(`### Document body not found: ${id}\n`);
          continue;
        }
        
        const docText = `### ${doc.title} (${doc.path})\n\n${body}\n\n---\n\n`;
        
        if (totalBytes + docText.length > maxBytes) {
          results.push(`\n⚠️  Reached maxBytes limit (${maxBytes}), truncating results.\n`);
          break;
        }
        
        results.push(docText);
        totalBytes += docText.length;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: results.join(''),
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_write',
    'Write content to daily log or MEMORY.md',
    {
      content: z.string().describe('Content to write'),
      target: z.string().optional().default('daily').describe('Target: "daily" for daily log, "memory" for MEMORY.md'),
    },
    async ({ content, target }) => {
      let targetPath: string;
      
      if (target === 'daily') {
        const date = new Date().toISOString().split('T')[0];
        const memoryDir = path.join(outputDir, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        targetPath = path.join(memoryDir, `${date}.md`);
      } else if (target === 'memory') {
        targetPath = path.join(outputDir, 'MEMORY.md');
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid target: ${target}. Use "daily" or "memory".`,
            },
          ],
          isError: true,
        };
      }
      
      const timestamp = new Date().toISOString();
      const entry = `\n## ${timestamp}\n\n${content}\n`;
      
      fs.appendFileSync(targetPath, entry, 'utf-8');
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Written to ${targetPath}`,
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_status',
    'Show index health, collection info, and model status',
    {
      root: z.string().optional().describe('Workspace root path for codebase stats'),
    },
    async ({ root }) => {
      const health = store.getIndexHealth()
      const effectiveRoot = root || deps.workspaceRoot
      const codebaseStats = getCodebaseStats(store, deps.codebaseConfig, effectiveRoot)
      // Probe embedding server connectivity
      const embeddingConfig = deps.embeddingConfig
      const ollamaUrl = embeddingConfig?.url || detectOllamaUrl()
      const ollamaModel = embeddingConfig?.model || 'nomic-embed-text'
      const provider = embeddingConfig?.provider || 'ollama'
      let embeddingHealth: { provider: string; url: string; model: string; reachable: boolean; models?: string[]; error?: string } | undefined
      
      if (provider !== 'local') {
        const ollamaHealth = await checkOllamaHealth(ollamaUrl)
        embeddingHealth = { provider, url: ollamaUrl, model: ollamaModel, ...ollamaHealth }
      } else {
        embeddingHealth = { provider, url: 'n/a', model: ollamaModel, reachable: true }
      }
      return {
        content: [
          {
            type: 'text',
            text: formatStatus(health, codebaseStats, embeddingHealth),
          },
        ],
      }
    }
  )
  server.tool(
    'memory_index_codebase',
    'Index codebase files in the current workspace',
    {
      root: z.string().optional().describe('Workspace root path to index. Defaults to configured root or server cwd.'),
    },
    async ({ root }) => {
      if (!deps.codebaseConfig?.enabled) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Codebase indexing is not enabled. Add `codebase: { enabled: true }` to your collections.yaml',
            },
          ],
          isError: true,
        }
      }
      
      ;(async () => {
        try {
          const effectiveRoot = root || deps.workspaceRoot
          const effectiveProjectHash = crypto.createHash('sha256').update(effectiveRoot).digest('hex').substring(0, 12)
          const result = await indexCodebase(
            store,
            effectiveRoot,
            deps.codebaseConfig!,
            effectiveProjectHash,
            providers.embedder
          )
          console.error(`[codebase] Indexing complete: ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkippedUnchanged} unchanged`)
          if (providers.embedder) {
            const embedded = await embedPendingCodebase(store, providers.embedder, 10, effectiveProjectHash)
            console.error(`[codebase] Embedding complete: ${embedded} chunks embedded`)
          }
        } catch (err) {
          console.error(`[codebase] Indexing failed:`, err)
        }
      })()
      
      return {
        content: [
          {
            type: 'text',
            text: `🔄 Codebase indexing started in background for ${root || deps.workspaceRoot}`,
          },
        ],
      }
    }
  )
  
  server.tool(
    'memory_update',
    'Trigger immediate reindex of all collections',
    {},
    async () => {
      let totalAdded = 0;
      let totalUpdated = 0;
      
      const freshConfig = loadCollectionConfig(deps.configPath);
      const freshCollections = freshConfig ? getCollections(freshConfig) : deps.collections;
      
      for (const collection of freshCollections) {
        const files = await scanCollectionFiles(collection);
        
        for (const filePath of files) {
          const existing = store.findDocument(filePath);
          const stats = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          
          if (existing && existing.hash === hash) {
            continue;
          }
          
          if (existing) {
            store.deactivateDocument(collection.name, filePath);
            totalUpdated++;
          } else {
            totalAdded++;
          }
          
          const title = path.basename(filePath, path.extname(filePath));
          store.insertContent(hash, content);
          store.insertDocument({
            collection: collection.name,
            path: filePath,
            title,
            hash,
            createdAt: stats.birthtime.toISOString(),
            modifiedAt: stats.mtime.toISOString(),
            active: true,
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `✅ Reindex complete: ${totalAdded} added, ${totalUpdated} updated`,
          },
        ],
      };
    }
  );
  
  return server;
}

function writePidFile(pidPath: string): void {
  const dir = path.dirname(pidPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf-8');
}

function removePidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath);
  } catch {
  }
}

function checkStalePid(pidPath: string): void {
  if (!fs.existsSync(pidPath)) {
    return;
  }
  
  const pidStr = fs.readFileSync(pidPath, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  
  if (isNaN(pid)) {
    fs.unlinkSync(pidPath);
    return;
  }
  
  try {
    process.kill(pid, 0);
    console.error(`Server already running with PID ${pid}`);
    process.exit(1);
  } catch {
    console.warn(`Removing stale PID file (PID ${pid} not running)`);
    fs.unlinkSync(pidPath);
  }
}

export async function startServer(options: ServerOptions): Promise<void> {
  const { dbPath, configPath, httpPort, daemon } = options;
  
  const homeDir = os.homedir();
  const outputDir = path.join(homeDir, '.nano-brain');
  const cacheDir = path.join(homeDir, '.cache', 'nano-brain');
  const pidPath = path.join(cacheDir, 'mcp.pid');
  const finalConfigPath = configPath || path.join(outputDir, 'collections.yaml');
  const config = loadCollectionConfig(finalConfigPath);
  const collections = config ? getCollections(config) : [];
  const storageConfig = parseStorageConfig(config?.storage);
  const resolvedWorkspaceRoot = config?.codebase?.root || process.cwd();
  const currentProjectHash = crypto.createHash('sha256').update(resolvedWorkspaceRoot).digest('hex').substring(0, 12);
  // Use per-workspace database: {dirName}-{hash}.sqlite instead of default.sqlite
  const isDefaultDb = dbPath.endsWith('/default.sqlite') || dbPath.endsWith('\\default.sqlite');
  const workspaceDirName = path.basename(resolvedWorkspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
  const effectiveDbPath = isDefaultDb ? path.join(path.dirname(dbPath), `${workspaceDirName}-${currentProjectHash}.sqlite`) : dbPath;
  console.error(`[memory] Workspace: ${resolvedWorkspaceRoot} (${currentProjectHash})`);
  console.error(`[memory] Database: ${effectiveDbPath}`);
  const store = createStore(effectiveDbPath);
  
  let embedder: SearchProviders['embedder'] = null;
  let reranker: SearchProviders['reranker'] = null;
  
  const providers: SearchProviders = {
    embedder,
    reranker,
    expander: null,
  };
  
  store.modelStatus = {
    embedding: 'loading...',
    reranker: 'loading...',
    expander: 'disabled',
  };
  
  const deps: ServerDeps = {
    store,
    providers,
    collections,
    configPath: finalConfigPath,
    outputDir,
    storageConfig,
    currentProjectHash,
    codebaseConfig: config?.codebase,
    embeddingConfig: config?.embedding,
    workspaceRoot: resolvedWorkspaceRoot,
  };
  
  const server = createMcpServer(deps);
  
  let watcher: ReturnType<typeof startWatcher> | null = null;
  const startFileWatcher = () => {
    if (watcher) {
      return;
    }
    const watcherConfig: WatcherConfig | undefined = config?.watcher;
    watcher = startWatcher({
      store,
      collections,
      embedder: providers.embedder,
      debounceMs: watcherConfig?.debounceMs ?? 2000,
      pollIntervalMs: watcherConfig?.pollIntervalMs ?? 120000,
      sessionPollMs: watcherConfig?.sessionPollMs ?? 120000,
      embedIntervalMs: watcherConfig?.embedIntervalMs ?? 60000,
      sessionStorageDir: path.join(homeDir, '.local/share/opencode/storage'),
      outputDir: path.join(outputDir, 'sessions'),
      storageConfig,
      dbPath,
      onUpdate: (filePath) => {
        if (!daemon) {
          console.error(`[watcher] File changed: ${filePath}`);
        }
      },
      codebaseConfig: config?.codebase,
      workspaceRoot: resolvedWorkspaceRoot,
      projectHash: currentProjectHash,
    });
  };
  
  if (daemon) {
    checkStalePid(pidPath);
    writePidFile(pidPath);
    
    const cleanup = () => {
      if (watcher) {
        watcher.stop();
      }
      removePidFile(pidPath);
      store.close();
      process.exit(0);
    };
    
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }
  
  if (httpPort) {
    const httpServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }
      
      if (req.method === 'POST' && req.url === '/mcp') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const request = JSON.parse(body);
            const response = await server.request(request, {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }
      
      res.writeHead(404);
      res.end('Not Found');
    });
    
    httpServer.listen(httpPort, () => {
      console.error(`MCP server listening on http://localhost:${httpPort}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server started on stdio');
  }
  
  Promise.all([
    createEmbeddingProvider({ embeddingConfig: config?.embedding })
      .then((loadedEmbedder) => {
        providers.embedder = loadedEmbedder;
        store.modelStatus.embedding = loadedEmbedder ? loadedEmbedder.getModel() : 'missing';
        if (loadedEmbedder) {
          store.ensureVecTable(loadedEmbedder.getDimensions());
        }
        console.error(`[memory] Embedding model: ${store.modelStatus.embedding}`);
        startFileWatcher();
      })
      .catch((err) => {
        store.modelStatus.embedding = 'failed';
        console.error('[memory] Embedding model failed:', err);
        startFileWatcher();
      }),
    createReranker()
      .then((loadedReranker) => {
        providers.reranker = loadedReranker;
        store.modelStatus.reranker = loadedReranker ? 'bge-reranker-v2-m3' : 'missing';
        console.error(`[memory] Reranker model: ${store.modelStatus.reranker}`);
      })
      .catch((err) => {
        store.modelStatus.reranker = 'failed';
        console.error('[memory] Reranker model failed:', err);
      }),
  ]);

  if (!config?.codebase?.enabled) {
    startFileWatcher();
  }
}
