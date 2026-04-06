import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SqliteEventStore } from './event-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Store, SearchResult, IndexHealth, Collection, StorageConfig, CodebaseConfig, EmbeddingConfig, WatcherConfig, SearchConfig, ConsolidationConfig, ProactiveConfig } from './types.js'
import { DEFAULT_PROACTIVE_CONFIG, VALID_RELATIONSHIP_TYPES } from './types.js'
import { traverse, isValidRelationshipType } from './connection-graph.js';
import { extractEntitiesFromMemory } from './entity-extraction.js'
import { createLLMProvider } from './llm-provider.js';
import { ConsolidationAgent } from './consolidation.js';
import { ConsolidationWorker } from './consolidation-worker.js';
import type { SearchProviders } from './search.js';
import { hybridSearch, parseSearchConfig } from './search.js';
import { findCycles } from './graph.js';
import { createStore, extractProjectHashFromPath, resolveWorkspaceDbPath, openWorkspaceStore, setProjectLabelDataDir, resolveProjectLabel, openDatabase, getLastCorruptionRecovery, clearCorruptionRecovery, closeAllCachedStores } from './store.js';
import { log, initLogger, setStdioMode } from './logger.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles, getWorkspaceConfig } from './collections.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth, checkOpenAIHealth } from './embeddings.js';
import { createReranker } from './reranker.js';
import { createLLMQueryExpander } from './expansion.js';
import { startWatcher } from './watcher.js';
import { parseStorageConfig } from './storage.js';
import { indexCodebase, getCodebaseStats, embedPendingCodebase } from './codebase.js'
import { createVectorStore, type VectorStore, type VectorStoreHealth } from './vector-store.js'
import Database from 'better-sqlite3'
import { SymbolGraph, type ContextResult, type ImpactResult, type DetectChangesResult } from './symbol-graph.js'
import { ResultCache } from './cache.js'
import { initFTSWorker, shutdownFTSWorker, searchFTSAsync, isFTSWorkerReady } from './fts-client.js'
import { detectReformulation } from './telemetry.js'
import { categorize } from './categorizer.js'
import { categorizeMemory } from './llm-categorizer.js'
import { parseCategorizationConfig } from './types.js'
import { ThompsonSampler, DEFAULT_BANDIT_CONFIGS } from './bandits.js'

let maintenanceMode = false;
let maintenanceTimer: NodeJS.Timeout | null = null;

// Per-file write queue to prevent interleaved appends from concurrent clients
const fileWriteQueues = new Map<string, Promise<void>>();
function sequentialFileAppend(filePath: string, data: string): void {
  const prev = fileWriteQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(() => {
    fs.appendFileSync(filePath, data, 'utf-8');
  }).catch(() => {
    // Ensure queue continues even if a write fails
  });
  fileWriteQueues.set(filePath, next);
}

export interface ServerOptions {
  dbPath: string;
  configPath?: string;
  httpPort?: number;
  httpHost?: string;
  daemon?: boolean;
  root?: string;
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
  searchConfig?: SearchConfig
  db?: Database.Database
  allWorkspaces?: Record<string, { codebase?: CodebaseConfig }>
  dataDir?: string
  daemon?: boolean
  ready?: { value: boolean }
  sequenceAnalyzer?: import('./sequence-analyzer.js').SequenceAnalyzer
  corruptionWarningPending?: { value: boolean; corruptedPath?: string }
  sampler?: ThompsonSampler
}

export interface ResolvedWorkspace {
  store: Store
  workspaceRoot: string
  projectHash: string
  needsClose: boolean
}

export function resolveWorkspace(deps: ServerDeps, filePath?: string, workspaceParam?: string): ResolvedWorkspace | null {
  if (!deps.daemon || !deps.allWorkspaces || !deps.dataDir) {
    return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
  }

  if (workspaceParam && workspaceParam !== 'all') {
    for (const [wsPath, _wsConfig] of Object.entries(deps.allWorkspaces)) {
      const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
      if (workspaceParam === wsHash || workspaceParam === wsPath) {
        if (wsHash === deps.currentProjectHash) {
          return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
        }
        const wsStore = openWorkspaceStore(deps.dataDir, wsPath);
        if (wsStore) {
          return { store: wsStore, workspaceRoot: wsPath, projectHash: wsHash, needsClose: false };
        }
      }
    }
  }

  if (filePath) {
    let bestMatch: { wsPath: string; length: number } | null = null;
    for (const wsPath of Object.keys(deps.allWorkspaces)) {
      if (filePath.startsWith(wsPath) && (!bestMatch || wsPath.length > bestMatch.length)) {
        bestMatch = { wsPath, length: wsPath.length };
      }
    }
    if (bestMatch) {
      const wsHash = crypto.createHash('sha256').update(bestMatch.wsPath).digest('hex').substring(0, 12);
      if (wsHash === deps.currentProjectHash) {
        return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
      }
      const wsStore = openWorkspaceStore(deps.dataDir, bestMatch.wsPath);
      if (wsStore) {
        return { store: wsStore, workspaceRoot: bestMatch.wsPath, projectHash: wsHash, needsClose: false };
      }
    }
  }

  return null;
}

function formatAvailableWorkspaces(deps: ServerDeps): string {
  const workspaces = Object.keys(deps.allWorkspaces || {})
  return workspaces.map(p => {
    const hash = crypto.createHash('sha256').update(p).digest('hex').substring(0, 12)
    return `  - ${path.basename(p)} (${hash}) — ${p}`
  }).join('\n')
}

function requireDaemonWorkspace(
  deps: ServerDeps,
  workspace: string | undefined,
  filePath?: string
): { error: string } | { projectHash: string; workspaceRoot: string; db: Database.Database | undefined; store: Store; needsClose: boolean } {
  if (!deps.daemon) {
    return {
      projectHash: deps.currentProjectHash,
      workspaceRoot: deps.workspaceRoot,
      db: deps.db,
      store: deps.store,
      needsClose: false,
    }
  }

  if (!workspace && !filePath) {
    return { error: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }
  }

  if (workspace === 'all') {
    return {
      projectHash: 'all',
      workspaceRoot: '',
      db: deps.db,
      store: deps.store,
      needsClose: false,
    }
  }

  const resolved = resolveWorkspace(deps, filePath, workspace)
  if (resolved) {
    return {
      projectHash: resolved.projectHash,
      workspaceRoot: resolved.workspaceRoot,
      db: resolved.store.getDb(),
      store: resolved.store,
      needsClose: resolved.needsClose,
    }
  }

  if (workspace) {
    return { error: `Workspace not found: ${workspace}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
  }

  return { error: `Could not resolve workspace from file_path: ${filePath}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
}

function attachTagsToResults(results: SearchResult[], store: Store): SearchResult[] {
  return results.map(r => {
    const docId = typeof r.id === 'string' ? parseInt(r.id, 10) : r.id;
    if (isNaN(docId)) return r;
    const tags = store.getDocumentTags(docId);
    return tags.length > 0 ? { ...r, tags } : r;
  });
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  return results.map((r, i) => {
    let output = `### ${i + 1}. ${r.title} (${r.docid})\n` +
      `**Path:** ${r.path} | **Score:** ${r.score.toFixed(3)} | **Lines:** ${r.startLine}-${r.endLine}\n`;

    if (r.tags && r.tags.length > 0) {
      output += `**Tags:** ${r.tags.join(', ')}\n`;
    }
    if (r.symbols && r.symbols.length > 0) {
      output += `**Symbols:** ${r.symbols.join(', ')}\n`;
    }
    if (r.clusterLabel) {
      output += `**Cluster:** ${r.clusterLabel}\n`;
    }
    if (r.flowCount !== undefined && r.flowCount > 0) {
      output += `**Flows:** ${r.flowCount}\n`;
    }

    output += `\n${r.snippet}\n`;
    return output;
  }).join('\n---\n\n');
}

function abbreviateTag(tag: string): string {
  const parts = tag.split(':');
  if (parts.length === 2) {
    const prefix = parts[0];
    const name = parts[1];
    const shortName = name.split('-')[0];
    return `${prefix}:${shortName}`;
  }
  return tag.split('-')[0];
}

function formatTagsCompact(tags: string[]): string {
  if (tags.length === 0) return '';
  if (tags.length <= 3) {
    return ` [${tags.map(abbreviateTag).join(', ')}]`;
  }
  const first2 = tags.slice(0, 2).map(abbreviateTag);
  return ` [${first2.join(', ')} +${tags.length - 2}]`;
}

export function formatCompactResults(results: SearchResult[], cacheKey: string): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const header = `🔑 ${cacheKey} | Use memory_expand(cacheKey, index) for full content | compact:false for verbose`;

  const lines = results.map((r, i) => {
    const score = r.score.toFixed(3);
    const title = r.title.replace(/[|—]/g, '-');
    const symbols = r.symbols && r.symbols.length > 0 ? ` [${r.symbols.join(', ')}]` : '';
    const tags = r.tags && r.tags.length > 0 ? formatTagsCompact(r.tags) : '';
    const firstLine = r.snippet.split('\n')[0] || '';
    const truncated = firstLine.length > 80 ? firstLine.substring(0, 80) + '…' : firstLine;
    return `${i + 1}. [${score}] ${title} (${r.docid}) — ${r.path}:${r.startLine}${symbols}${tags} | ${truncated}`;
  });

  return header + '\n\n' + lines.join('\n');
}

export function formatStatus(
  health: IndexHealth,
  codebaseStats?: { enabled: boolean; documents: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number },
  embeddingHealth?: { provider: string; url: string; model: string; reachable: boolean; models?: string[]; error?: string },
  vectorHealth?: VectorStoreHealth | null,
  tokenUsage?: Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }> | null
): string {
  const lines = [
    `📊 **Memory Index Status**`,
    `Documents: ${health.documentCount} | Embedded: ${health.embeddedCount} | Pending embeddings: ${health.pendingEmbeddings}`,
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
  if (vectorHealth) {
    lines.push(``)
    lines.push(`**Vector Store:**`)
    lines.push(`  - Provider: ${vectorHealth.provider}`)
    if (vectorHealth.ok) {
      lines.push(`  - Status: ✅ connected (${vectorHealth.vectorCount.toLocaleString()} vectors${vectorHealth.dimensions ? `, ${vectorHealth.dimensions} dims` : ''})`)
    } else {
      lines.push(`  - Status: ❌ unreachable (${vectorHealth.error || 'unknown'})`)
    }
  } else if (vectorHealth === null) {
    lines.push(``)
    lines.push(`**Vector Store:**`)
    lines.push(`  - Provider: sqlite-vec (built-in)`)
  }
  if (tokenUsage && tokenUsage.length > 0) {
    lines.push(``)
    lines.push(`**Token Usage:**`)
    for (const usage of tokenUsage) {
      lines.push(`  - ${usage.model}: ${usage.totalTokens.toLocaleString()} tokens (${usage.requestCount.toLocaleString()} requests)`)
    }
  }
  if (health.workspaceStats && health.workspaceStats.length > 0) {
    lines.push(``)
    lines.push(`**Workspaces:**`)
    for (const ws of health.workspaceStats) {
      lines.push(`  - ${ws.projectHash}: ${ws.count} docs`)
    }
  }
  if (health.extractedFacts !== undefined && health.extractedFacts > 0) {
    lines.push(``)
    lines.push(`**Extracted Facts:**`)
    lines.push(`  - Count: ${health.extractedFacts}`)
  }
  return lines.join('\n')
}

const WARMUP_ERROR = { isError: true, content: [{ type: 'text' as const, text: 'Server warming up, try again in a few seconds' }] };

export function createMcpServer(deps: ServerDeps): McpServer {
  const { store, providers, collections, configPath, outputDir, currentProjectHash, workspaceRoot } = deps;

  const checkReady = () => deps.ready && !deps.ready.value;

  const getCorruptionWarning = (): string | null => {
    if (deps.corruptionWarningPending?.value) {
      deps.corruptionWarningPending.value = false;
      const corruptedPath = deps.corruptionWarningPending.corruptedPath || 'unknown';
      return `[WARNING] Database was corrupted and rebuilt. Some search results may be incomplete until reindexing completes. Corrupt file preserved at: ${corruptedPath}\n\n`;
    }
    return null;
  };

  const prependWarning = (text: string): string => {
    const warning = getCorruptionWarning();
    return warning ? warning + text : text;
  };

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

  const resultCache = new ResultCache();

  server.tool(
    'memory_search',
    'BM25 full-text keyword search across indexed documents',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
      collection: z.string().optional().describe('Filter by collection name'),
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
      compact: z.boolean().optional().default(true).describe('Return compact single-line results with caching. Defaults to compact.'),
    },
    async ({ query, limit, collection, workspace, tags, since, until, compact }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_search query="' + query + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return {
          content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }],
          isError: true,
        }
      }
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const rawResults = store.searchFTS(query, {
        limit,
        collection,
        projectHash: effectiveWorkspace,
        tags: parsedTags,
        since,
        until,
      });
      const results = attachTagsToResults(rawResults, store);
      try { store.trackAccess(results.map(r => typeof r.id === 'string' ? parseInt(r.id, 10) : r.id)); } catch { /* non-critical */ }
      if (compact) {
        const cacheKey = resultCache.set(results, query);
        return {
          content: [{ type: 'text', text: prependWarning(formatCompactResults(results, cacheKey)) }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: prependWarning(formatSearchResults(results)),
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
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
      compact: z.boolean().optional().default(true).describe('Return compact single-line results with caching. Defaults to compact.'),
    },
    async ({ query, limit, collection, workspace, tags, since, until, compact }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_vsearch query="' + query + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return {
          content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }],
          isError: true,
        }
      }
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const searchOpts = {
        limit,
        collection,
        projectHash: effectiveWorkspace,
        tags: parsedTags,
        since,
        until,
      };
      if (providers.embedder) {
        try {
          let embedding: number[];
          const cached = store.getQueryEmbeddingCache(query);
          if (cached) {
            embedding = cached;
          } else {
            const result = await providers.embedder.embed(query);
            embedding = result.embedding;
            store.setQueryEmbeddingCache(query, embedding);
          }
          const rawResults = await store.searchVecAsync(query, embedding, searchOpts);
          const results = attachTagsToResults(rawResults, store);
          try { store.trackAccess(results.map(r => typeof r.id === 'string' ? parseInt(r.id, 10) : r.id)); } catch { /* non-critical */ }
          if (compact) {
            const cacheKey = resultCache.set(results, query);
            return { content: [{ type: 'text', text: prependWarning(formatCompactResults(results, cacheKey)) }] };
          }
          return {
            content: [
              {
                type: 'text',
                text: prependWarning(formatSearchResults(results)),
              },
            ],
          };
        } catch (err) {
          const rawFallbackResults = store.searchFTS(query, searchOpts);
          const fallbackResults = attachTagsToResults(rawFallbackResults, store);
          if (compact) {
            const cacheKey = resultCache.set(fallbackResults, query);
            return { content: [{ type: 'text', text: prependWarning(`⚠️  Vector search failed, falling back to FTS: ${err instanceof Error ? err.message : String(err)}\n\n${formatCompactResults(fallbackResults, cacheKey)}`) }] };
          }
          return {
            content: [
              {
                type: 'text',
                text: prependWarning(`⚠️  Vector search failed, falling back to FTS: ${err instanceof Error ? err.message : String(err)}\n\n${formatSearchResults(fallbackResults)}`),
              },
            ],
          };
        }
      } else {
        const rawFallbackResults = store.searchFTS(query, searchOpts);
        const fallbackResults = attachTagsToResults(rawFallbackResults, store);
        if (compact) {
          const cacheKey = resultCache.set(fallbackResults, query);
          return { content: [{ type: 'text', text: prependWarning(`⚠️  Embedder not available, falling back to FTS\n\n${formatCompactResults(fallbackResults, cacheKey)}`) }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: prependWarning(`⚠️  Embedder not available, falling back to FTS\n\n${formatSearchResults(fallbackResults)}`),
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
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
      compact: z.boolean().optional().default(true).describe('Return compact single-line results with caching. Defaults to compact.'),
    },
    async ({ query, limit, collection, minScore, workspace, tags, since, until, compact }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_query query="' + query + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return {
          content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }],
          isError: true,
        }
      }
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const sessionId = crypto.createHash('sha256').update(query + Date.now().toString()).digest('hex').substring(0, 12);
      const rawResults = await hybridSearch(
        store,
        { query, limit, collection, minScore, projectHash: effectiveWorkspace, tags: parsedTags, since, until, searchConfig: deps.searchConfig, db: deps.db, sessionId, sampler: deps.sampler },
        providers
      );
      const results = attachTagsToResults(rawResults, store);

      try {
        const recentQueries = store.getRecentQueries(sessionId);
        const reformulatedId = detectReformulation(query, recentQueries);
        if (reformulatedId !== null) {
          store.markReformulation(reformulatedId);
          if (deps.sampler) {
            const configVariant = store.getConfigVariantById(reformulatedId);
            if (configVariant) {
              try {
                const variants = JSON.parse(configVariant) as Record<string, number>;
                for (const [paramName, value] of Object.entries(variants)) {
                  deps.sampler.recordReward(paramName, value, false);
                }
              } catch {
              }
            }
          }
        }
      } catch {
      }

      if (compact) {
        const cacheKey = resultCache.set(results, query);
        return {
          content: [{ type: 'text', text: prependWarning(formatCompactResults(results, cacheKey)) }],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: prependWarning(formatSearchResults(results)),
          },
        ],
      };
    }
  );

  server.tool(
    'memory_expand',
    'Expand a compact search result to see full content',
    {
      cacheKey: z.string().describe('Cache key from compact search response'),
      index: z.number().optional().describe('1-based result index to expand'),
      indices: z.array(z.number()).optional().describe('Array of 1-based indices to expand multiple results'),
      docid: z.string().optional().describe('Document ID fallback if cache expired'),
    },
    async ({ cacheKey, index, indices, docid }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_expand cacheKey="' + cacheKey + '" index=' + index + ' indices=' + JSON.stringify(indices) + ' docid=' + (docid || ''));

      const cached = resultCache.get(cacheKey);

      const expandIndices: number[] = [];
      if (indices && indices.length > 0) {
        expandIndices.push(...indices);
      } else if (index !== undefined) {
        expandIndices.push(index);
      }

      if (cached && expandIndices.length > 0) {
        const errors: string[] = [];
        const expanded: string[] = [];

        for (const idx of expandIndices) {
          if (idx < 1 || idx > cached.results.length) {
            errors.push(`Index ${idx} out of range. Results have ${cached.results.length} items (1-${cached.results.length}).`);
            continue;
          }
          const result = cached.results[idx - 1];
          expanded.push(formatSearchResults([result]));
        }

        if (errors.length > 0 && expanded.length === 0) {
          return { content: [{ type: 'text', text: errors.join('\n') }], isError: true };
        }

        try {
          store.logSearchExpand(cacheKey, expandIndices);
          if (deps.sampler) {
            const configVariant = store.getConfigVariantByCacheKey(cacheKey);
            if (configVariant) {
              try {
                const variants = JSON.parse(configVariant) as Record<string, number>;
                for (const [paramName, value] of Object.entries(variants)) {
                  deps.sampler.recordReward(paramName, value, true);
                }
              } catch {
              }
            }
          }
        } catch {
        }

        const text = expanded.join('\n---\n\n') + (errors.length > 0 ? '\n\n⚠️ ' + errors.join('\n') : '');
        return { content: [{ type: 'text', text }] };
      }

      if (expandIndices.length === 0 && !docid) {
        return {
          content: [{ type: 'text', text: 'Provide index, indices, or docid to expand.' }],
          isError: true,
        };
      }

      if (!cached && docid) {
        const doc = store.findDocument(docid);
        if (!doc) {
          return {
            content: [{ type: 'text', text: `Document not found: ${docid}` }],
            isError: true,
          };
        }
        const body = store.getDocumentBody(doc.hash, undefined, undefined);
        const truncated = body ? (body.length > 2000 ? body.substring(0, 2000) + '\n... (truncated to 2000 chars)' : body) : '';
        return {
          content: [{
            type: 'text',
            text: `⚠️ Cache expired. Showing document section instead of matched snippet.\n\n**${doc.title}** (${doc.path})\n\n${truncated}`,
          }],
        };
      }

      if (!cached) {
        return {
          content: [{ type: 'text', text: 'Cache expired. Re-run your search or provide a docid.' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: 'Provide index, indices, or docid to expand.' }],
        isError: true,
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
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_get id="' + id + '"');
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

      const effectiveMaxLines = maxLines ?? 200;
      const body = store.getDocumentBody(doc.hash, fromLine, effectiveMaxLines);
      const fullBody = store.getDocumentBody(doc.hash);
      const totalLines = fullBody ? fullBody.split('\n').length : 0;
      const returnedLines = body ? body.split('\n').length : 0;
      let text = body ?? '';
      if (totalLines > returnedLines && !maxLines) {
        text += '\n... (truncated, showing ' + effectiveMaxLines + ' of ' + totalLines + ' total lines. Use maxLines to see more)';
      }
      return {
        content: [
          {
            type: 'text',
            text,
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
      maxBytes: z.number().optional().default(30000).describe('Maximum total bytes to return (default: 30000)'),
    },
    async ({ pattern, maxBytes }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_multi_get pattern="' + pattern + '" maxBytes=' + maxBytes);
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
    'Write content to daily log with workspace context',
    {
      content: z.string().describe('Content to write'),
      supersedes: z.string().optional().describe('Path or docid of document this supersedes'),
      tags: z.string().optional().describe('Comma-separated tags to associate with this entry'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ content, supersedes, tags, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      if (!content?.trim()) {
        return { content: [{ type: 'text', text: 'Error: content must not be empty' }], isError: true };
      }
      log('mcp', 'memory_write content_length=' + content.length);

      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }

      const effectiveProjectHash = wsResult.projectHash
      const effectiveWorkspaceRoot = wsResult.workspaceRoot
      const effectiveStore = wsResult.store
      let asyncCategorizationPending = false;

      try {
        const date = new Date().toISOString().split('T')[0];
        const memoryDir = path.join(outputDir, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        const targetPath = path.join(memoryDir, `${date}.md`);
        const timestamp = new Date().toISOString();
        const workspaceName = path.basename(effectiveWorkspaceRoot);
        const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${effectiveProjectHash})\n\n${content}\n`;

        sequentialFileAppend(targetPath, entry);

        let supersedeWarning = '';
        if (supersedes) {
          const targetDoc = effectiveStore.findDocument(supersedes);
          if (targetDoc) {
            effectiveStore.supersedeDocument(targetDoc.id, 0);
          } else {
            supersedeWarning = `\n⚠️ Supersede target not found: ${supersedes}`;
          }
        }

        const fileContent = fs.readFileSync(targetPath, 'utf-8');
        const title = path.basename(targetPath, path.extname(targetPath));
        const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
        effectiveStore.insertContent(hash, fileContent);
        const stats = fs.statSync(targetPath);
        const docId = effectiveStore.insertDocument({
          collection: 'memory',
          path: targetPath,
          title,
          hash,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          active: true,
          projectHash: effectiveProjectHash,
        });

        let tagInfo = '';
        const autoTags = categorize(content);
        const userTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : [];
        const allTags = [...new Set([...userTags, ...autoTags])];
        if (allTags.length > 0) {
          effectiveStore.insertTags(docId, allTags);
          tagInfo = `\n📌 Tags: ${allTags.join(', ')}`;
        }

        let consolidationInfo = '';
        const freshConfig = loadCollectionConfig(deps.configPath);
        const consolidationConfig = freshConfig?.consolidation;
        if (consolidationConfig?.enabled && docId > 0) {
          const queueId = effectiveStore.enqueueConsolidation(docId);
          if (queueId > 0) {
            consolidationInfo = `\n🔄 Consolidation: pending`;
          }
        }

        let proactiveInfo = '';
        const proactiveConfig: ProactiveConfig = { ...DEFAULT_PROACTIVE_CONFIG, ...freshConfig?.proactive };
        if (proactiveConfig.enabled && providers.embedder) {
          try {
            const maxSuggestions = proactiveConfig.max_suggestions || 3;
            let embedding: number[];
            const cached = effectiveStore.getQueryEmbeddingCache(content.substring(0, 500));
            if (cached) {
              embedding = cached;
            } else {
              const result = await providers.embedder.embed(content.substring(0, 500));
              embedding = result.embedding;
            }
            const relatedResults = await effectiveStore.searchVecAsync(content.substring(0, 100), embedding, {
              limit: maxSuggestions,
              collection: 'memory',
              projectHash: effectiveProjectHash,
            });
            if (relatedResults.length > 0) {
              const relatedList = relatedResults.map(r => `  - ${r.title} (${r.docid})`).join('\n');
              proactiveInfo = `\n\n📎 **Related memories:**\n${relatedList}`;
            }
          } catch (err) {
            log('mcp', 'Proactive surfacing failed: ' + (err instanceof Error ? err.message : String(err)));
          }
        }

        if (consolidationConfig?.enabled && docId > 0) {
          const llmProvider = createLLMProvider(consolidationConfig as ConsolidationConfig);
          if (llmProvider) {
            const capturedProjectHash = effectiveProjectHash;
            extractEntitiesFromMemory(content, llmProvider).then(extractionResult => {
              if (extractionResult.entities.length > 0 || extractionResult.relationships.length > 0) {
                for (const entity of extractionResult.entities) {
                  store.insertOrUpdateEntity({
                    name: entity.name,
                    type: entity.type as 'tool' | 'service' | 'person' | 'concept' | 'decision' | 'file' | 'library',
                    description: entity.description,
                    projectHash: capturedProjectHash,
                    firstLearnedAt: new Date().toISOString(),
                    lastConfirmedAt: new Date().toISOString(),
                  });
                }

                for (const rel of extractionResult.relationships) {
                  const sourceEntity = store.getEntityByName(rel.sourceName, undefined, capturedProjectHash);
                  const targetEntity = store.getEntityByName(rel.targetName, undefined, capturedProjectHash);
                  if (sourceEntity && targetEntity) {
                    store.insertEdge({
                      sourceId: sourceEntity.id,
                      targetId: targetEntity.id,
                      edgeType: rel.edgeType as 'uses' | 'depends_on' | 'decided_by' | 'related_to' | 'replaces' | 'configured_with',
                      projectHash: capturedProjectHash,
                    });
                  }
                }

                log('mcp', 'Entity extraction complete: ' + extractionResult.entities.length + ' entities, ' + extractionResult.relationships.length + ' relationships');
              }
            }).catch(err => {
              log('mcp', 'Entity extraction failed: ' + (err instanceof Error ? err.message : String(err)));
            });
          }
        }

        const categorizationConfig = parseCategorizationConfig(freshConfig?.categorization);
        if (categorizationConfig.llm_enabled && docId > 0) {
          const llmProviderForCategorization = createLLMProvider(consolidationConfig as ConsolidationConfig);
          if (llmProviderForCategorization) {
            const capturedDocId = docId;
            const tagStore = effectiveStore;
            asyncCategorizationPending = true;
            categorizeMemory(content, llmProviderForCategorization, categorizationConfig).then(llmTags => {
              if (llmTags.length > 0) {
                tagStore.insertTags(capturedDocId, llmTags);
                log('mcp', 'LLM categorization complete: ' + llmTags.join(', '));
              }
            }).catch(err => {
              log('mcp', 'LLM categorization failed: ' + (err instanceof Error ? err.message : String(err)));
            });
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `✅ Written to ${targetPath} [${workspaceName}]${supersedeWarning}${tagInfo}${consolidationInfo}${proactiveInfo}`,
            },
          ],
        };
      } finally {
        if (wsResult.needsClose && !asyncCategorizationPending) {
          wsResult.store.close()
        }
      }
    }
  );

  server.tool(
    'memory_tags',
    'List all tags with document counts',
    {},
    async () => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_tags');
      const tags = store.listAllTags();
      if (tags.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No tags found.',
            },
          ],
        };
      }
      const lines = ['**Tags:**', ''];
      for (const { tag, count } of tags) {
        lines.push(`- ${tag}: ${count} document${count === 1 ? '' : 's'}`);
      }
      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
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
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_status root="' + (root || '') + '"');
      const health = store.getIndexHealth()
      const effectiveRoot = root || deps.workspaceRoot
      let codebaseStats = getCodebaseStats(store, deps.codebaseConfig, effectiveRoot)

      let workspaceStatsText = '';
      if (deps.daemon && deps.allWorkspaces && deps.dataDir) {
        const wsStats: string[] = [];
        for (const [wsPath, wsConfig] of Object.entries(deps.allWorkspaces)) {
          if (!wsConfig.codebase?.enabled) continue;
          try {
            const wsStore = openWorkspaceStore(deps.dataDir, wsPath);
            if (!wsStore) continue;
            try {
              const stats = getCodebaseStats(wsStore, wsConfig.codebase, wsPath);
              if (stats !== undefined && stats.enabled && stats.documents > 0) {
                let symbolCount = 0;
                let edgeCount = 0;
                try {
                  const wsDbPath = resolveWorkspaceDbPath(deps.dataDir, wsPath);
                  const wsDb = openDatabase(wsDbPath);
                  try {
                    const row = wsDb.prepare('SELECT COUNT(*) as cnt FROM code_symbols').get() as { cnt: number } | undefined;
                    symbolCount = row?.cnt ?? 0;
                    const edgeRow = wsDb.prepare('SELECT COUNT(*) as cnt FROM symbol_edges').get() as { cnt: number } | undefined;
                    edgeCount = edgeRow?.cnt ?? 0;
                  } finally {
                    wsDb.close();
                  }
                } catch { }
                wsStats.push(`  - ${path.basename(wsPath)}: ${stats.documents} docs, ${symbolCount} symbols, ${edgeCount} edges`);
              }
            } finally {
              wsStore.close();
            }
          } catch { }
        }
        if (wsStats.length > 0) {
          workspaceStatsText = '\n\n**Workspace Codebase Stats:**\n' + wsStats.join('\n');
        }
      }

      const embeddingConfig = deps.embeddingConfig
      const ollamaUrl = embeddingConfig?.url || detectOllamaUrl()
      const ollamaModel = embeddingConfig?.model || 'mxbai-embed-large'
      const provider = embeddingConfig?.provider || 'ollama'
      let embeddingHealth: { provider: string; url: string; model: string; reachable: boolean; models?: string[]; error?: string } | undefined

      if (provider === 'openai' && embeddingConfig?.apiKey) {
        const openaiHealth = await checkOpenAIHealth(ollamaUrl, embeddingConfig.apiKey, ollamaModel)
        embeddingHealth = { provider, url: ollamaUrl, model: ollamaModel, ...openaiHealth }
      } else if (provider !== 'local') {
        const ollamaHealth = await checkOllamaHealth(ollamaUrl)
        embeddingHealth = { provider, url: ollamaUrl, model: ollamaModel, ...ollamaHealth }
      } else {
        embeddingHealth = { provider, url: 'n/a', model: ollamaModel, reachable: true }
      }
      let vectorHealth: VectorStoreHealth | null = null
      const vs = store.getVectorStore()
      if (vs) {
        try {
          vectorHealth = await Promise.race([
            vs.health(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
          ])
        } catch (err) {
          vectorHealth = { ok: false, provider: 'unknown', vectorCount: 0, error: err instanceof Error ? err.message : String(err) }
        }
      }

      const tokenUsage = store.getTokenUsage()

      let learningText = '';
      try {
        const telemetryCount = store.getTelemetryCount();
        const banditStats = store.loadBanditStats(currentProjectHash);
        const latestConfig = store.getLatestConfigVersion();

        learningText = '\n\n## Learning\n';
        learningText += '- PID: ' + process.pid + '\n';
        learningText += '- Uptime: ' + Math.round(process.uptime()) + 's\n';
        learningText += '- Telemetry records: ' + telemetryCount + '\n';
        learningText += '- Bandit variants tracked: ' + banditStats.length + '\n';
        if (latestConfig) {
          learningText += '- Config version: ' + latestConfig.version_id + ' (updated ' + latestConfig.created_at + ')\n';
        }
      } catch {
      }

      return {
        content: [
          {
            type: 'text',
            text: formatStatus(health, codebaseStats, embeddingHealth, vectorHealth, tokenUsage.length > 0 ? tokenUsage : null) + workspaceStatsText + learningText,
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
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_index_codebase root="' + (root || '') + '"');

      const resolved = root ? resolveWorkspace(deps, undefined, root) : null;
      const effectiveRoot = resolved?.workspaceRoot || root || deps.workspaceRoot;
      const effectiveStore = resolved?.store || store;
      const effectiveProjectHash = resolved?.projectHash || crypto.createHash('sha256').update(effectiveRoot).digest('hex').substring(0, 12);

      let effectiveCodebaseConfig = deps.codebaseConfig;
      if (deps.daemon && deps.allWorkspaces && effectiveRoot) {
        const wsConfig = deps.allWorkspaces[effectiveRoot];
        if (wsConfig?.codebase) {
          effectiveCodebaseConfig = wsConfig.codebase;
        }
      }

      if (!effectiveCodebaseConfig?.enabled) {
        if (resolved?.needsClose) resolved.store.close();
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

      const needsClose = resolved?.needsClose ?? false;
      const storeToUse = effectiveStore;
      const configToUse = effectiveCodebaseConfig;

      // Open the correct workspace's symbol graph DB (not deps.db which is the startup workspace)
      let symbolGraphDb = deps.db;
      let symbolGraphDbNeedsClose = false;
      if (resolved && resolved.projectHash !== deps.currentProjectHash && deps.dataDir && resolved.workspaceRoot) {
        const wsDbPath = resolveWorkspaceDbPath(deps.dataDir, resolved.workspaceRoot);
        symbolGraphDb = openDatabase(wsDbPath);
        symbolGraphDbNeedsClose = true;
      }

      log('codebase-debug', `symbolGraphDb=${symbolGraphDbNeedsClose ? 'workspace-specific' : 'startup'} root=${effectiveRoot} hash=${effectiveProjectHash}`, 'error')
      ;(async () => {
        try {
          const result = await indexCodebase(
            storeToUse,
            effectiveRoot,
            configToUse,
            effectiveProjectHash,
            providers.embedder,
            symbolGraphDb
          )
          log('codebase', `Indexing complete: ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkippedUnchanged} unchanged`)
          if (providers.embedder) {
            const embedded = await embedPendingCodebase(storeToUse, providers.embedder, 50, effectiveProjectHash)
            log('codebase', `Embedding complete: ${embedded} chunks embedded`)
          }
        } catch (err) {
          log('codebase', `Indexing failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        } finally {
          if (symbolGraphDbNeedsClose && symbolGraphDb) { symbolGraphDb.close() }
          if (needsClose) storeToUse.close();
        }
      })()

      return {
        content: [
          {
            type: 'text',
            text: `🔄 Codebase indexing started in background for ${effectiveRoot}`,
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
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_update');
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

          const effectiveProjectHash = collection.name === 'sessions'
            ? extractProjectHashFromPath(filePath, path.join(outputDir, 'sessions'))
            : currentProjectHash;
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
            projectHash: effectiveProjectHash,
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

  server.tool(
    'memory_focus',
    'Get dependency graph context for a specific file',
    {
      filePath: z.string().describe('Absolute path to the file'),
    },
    async ({ filePath }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_focus filePath="' + filePath + '"');
      const resolved = resolveWorkspace(deps, filePath);
      const effectiveStore = resolved?.store || store;
      const effectiveProjectHash = resolved?.projectHash || currentProjectHash;

      try {
        const dependencies = effectiveStore.getFileDependencies(filePath, effectiveProjectHash);
        const dependents = effectiveStore.getFileDependents(filePath, effectiveProjectHash);
        const centralityInfo = effectiveStore.getDocumentCentrality(filePath);

        const lines: string[] = [];
        lines.push(`**File:** ${filePath}`);
        lines.push('');

        if (centralityInfo) {
          lines.push(`**Centrality:** ${centralityInfo.centrality.toFixed(4)}`);
          if (centralityInfo.clusterId !== null) {
            const clusterMembers = effectiveStore.getClusterMembers(centralityInfo.clusterId, effectiveProjectHash);
            lines.push(`**Cluster ID:** ${centralityInfo.clusterId} (${clusterMembers.length} members)`);
          if (clusterMembers.length > 0) {
            lines.push('**Cluster Members:**');
            for (const member of clusterMembers.slice(0, 10)) {
              lines.push(`  - ${member}`);
            }
            if (clusterMembers.length > 10) {
              lines.push(`  ... and ${clusterMembers.length - 10} more`);
            }
          }
        }
      } else {
        lines.push('**Centrality:** Not indexed');
      }
      lines.push('');

        lines.push(`**Dependencies (imports):** ${dependencies.length}`);
        const maxDeps = 30;
        for (const dep of dependencies.slice(0, maxDeps)) {
          lines.push(`  → ${dep}`);
        }
        if (dependencies.length > maxDeps) {
          lines.push(`  ... and ${dependencies.length - maxDeps} more`);
        }
        lines.push('');

        lines.push(`**Dependents (imported by):** ${dependents.length}`);
        const maxDependents = 30;
        for (const dep of dependents.slice(0, maxDependents)) {
          lines.push(`  ← ${dep}`);
        }
        if (dependents.length > maxDependents) {
          lines.push(`  ... and ${dependents.length - maxDependents} more`);
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
        };
      } finally {
        if (resolved?.needsClose) resolved.store.close();
      }
    }
  );

  server.tool(
    'memory_graph_stats',
    'Get statistics about the file dependency graph',
    {
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
    },
    async ({ workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_graph_stats workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }

      const lines: string[] = [];

      try {
        if (wsResult.projectHash === 'all' && deps.allWorkspaces && deps.dataDir) {
          lines.push('**Graph Statistics (All Workspaces)**');
          lines.push('');
          let totalNodes = 0;
          let totalEdges = 0;
          let totalClusters = 0;

          for (const [wsPath, wsConfig] of Object.entries(deps.allWorkspaces)) {
            if (!wsConfig.codebase?.enabled) continue;
            try {
              const wsStore = openWorkspaceStore(deps.dataDir, wsPath);
              if (!wsStore) continue;
              const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
              try {
                const wsStats = wsStore.getGraphStats(wsHash);
                if (wsStats.nodeCount > 0) {
                  lines.push(`**${path.basename(wsPath)}:** ${wsStats.nodeCount} nodes, ${wsStats.edgeCount} edges, ${wsStats.clusterCount} clusters`);
                  totalNodes += wsStats.nodeCount;
                  totalEdges += wsStats.edgeCount;
                  totalClusters += wsStats.clusterCount;
                }
              } finally {
                wsStore.close();
              }
            } catch { }
          }

          lines.push('');
          lines.push(`**Total:** ${totalNodes} nodes, ${totalEdges} edges, ${totalClusters} clusters`);
        } else {
          const effectiveStore = wsResult.store;
          const effectiveProjectHash = wsResult.projectHash;
          const stats = effectiveStore.getGraphStats(effectiveProjectHash);
          const edges = effectiveStore.getFileEdges(effectiveProjectHash);
          const cycles = findCycles(edges.map(e => ({ source: e.source_path, target: e.target_path })), 5);

          lines.push('**Graph Statistics**');
          lines.push('');
          lines.push(`**Nodes:** ${stats.nodeCount}`);
          lines.push(`**Edges:** ${stats.edgeCount}`);
          lines.push(`**Clusters:** ${stats.clusterCount}`);
          lines.push('');

          if (stats.topCentrality.length > 0) {
            lines.push('**Top 10 by Centrality:**');
            for (const { path: filePath, centrality } of stats.topCentrality) {
              lines.push(`  ${centrality.toFixed(4)} - ${filePath}`);
            }
            lines.push('');
          }

          if (cycles.length > 0) {
            lines.push(`**Cycles (length ≤ 5):** ${cycles.length}`);
            for (const cycle of cycles.slice(0, 5)) {
              lines.push(`  ${cycle.join(' → ')} → ${cycle[0]}`);
            }
            if (cycles.length > 5) {
              lines.push(`  ... and ${cycles.length - 5} more`);
            }
          } else {
            lines.push('**Cycles:** None detected');
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
        };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
        }
      }
    }
  );

  server.tool(
    'memory_symbols',
    'Query cross-repo symbols (Redis keys, PubSub channels, MySQL tables, API endpoints, HTTP calls, Bull queues)',
    {
      type: z.string().optional().describe('Symbol type: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue'),
      pattern: z.string().optional().describe('Glob pattern to match (e.g., "sinv:*" matches "sinv:*:compressed")'),
      repo: z.string().optional().describe('Filter by repository name'),
      operation: z.string().optional().describe('Filter by operation: read, write, publish, subscribe, define, call, produce, consume'),
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
    },
    async ({ type, pattern, repo, operation, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_symbols type="' + (type || '') + '" pattern="' + (pattern || '') + '" workspace="' + (workspace || '') + '"');
      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }
      const effectiveProjectHash = wsResult.projectHash === 'all' ? undefined : wsResult.projectHash
      const effectiveStore = wsResult.store

      try {
        const results = effectiveStore.querySymbols({
          type,
          pattern,
          repo,
          operation,
          projectHash: effectiveProjectHash as string,
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No symbols found matching the criteria.',
              },
            ],
          };
        }

        const grouped = new Map<string, Array<{ operation: string; repo: string; filePath: string; lineNumber: number }>>();
        for (const r of results) {
          const key = `${r.type}:${r.pattern}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push({ operation: r.operation, repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber });
        }

        const lines: string[] = [];
        lines.push(`**Found ${results.length} symbol(s) across ${grouped.size} pattern(s)**`);
        lines.push('');

        let symbolCount = 0;
        const maxSymbols = 50;
        for (const [key, items] of grouped) {
          if (symbolCount >= maxSymbols) break;
          const [symbolType, symbolPattern] = key.split(':');
          lines.push(`### ${symbolType}: \`${symbolPattern}\``);
          for (const item of items) {
            if (symbolCount >= maxSymbols) break;
            lines.push(`  - [${item.operation}] ${item.repo}: ${item.filePath}:${item.lineNumber}`);
            symbolCount++;
          }
          lines.push('');
        }
        if (results.length > maxSymbols) {
          lines.push(`... and ${results.length - maxSymbols} more symbols`);
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
        };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
        }
      }
    }
  );

  server.tool(
    'memory_impact',
    'Analyze cross-repo impact of a symbol (writers vs readers, publishers vs subscribers)',
    {
      type: z.string().describe('Symbol type: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue'),
      pattern: z.string().describe('Pattern to analyze (e.g., "sinv:*:compressed")'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ type, pattern, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_impact type="' + type + '" pattern="' + pattern + '" workspace="' + (workspace || '') + '"');
      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }
      const effectiveStore = wsResult.store

      try {
        const results = effectiveStore.getSymbolImpact(type, pattern, wsResult.projectHash);

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found for ${type}: ${pattern}`,
              },
            ],
          };
        }

        const byOperation = new Map<string, Array<{ repo: string; filePath: string; lineNumber: number }>>();
        for (const r of results) {
          if (!byOperation.has(r.operation)) byOperation.set(r.operation, []);
          byOperation.get(r.operation)!.push({ repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber });
        }

        const lines: string[] = [];
        lines.push(`**Impact Analysis: ${type} \`${pattern}\`**`);
        lines.push('');

        const operationLabels: Record<string, string> = {
          read: '📖 Readers',
          write: '✏️ Writers',
          publish: '📤 Publishers',
          subscribe: '📥 Subscribers',
          define: '📋 Definitions',
          call: '📞 Callers',
          produce: '📦 Producers',
          consume: '🔧 Consumers',
        };

        let impactCount = 0;
        const maxImpact = 50;
        for (const [op, items] of byOperation) {
          if (impactCount >= maxImpact) break;
          const label = operationLabels[op] || op;
          lines.push(`### ${label} (${items.length})`);
          for (const item of items) {
            if (impactCount >= maxImpact) break;
            lines.push(`  - ${item.repo}: ${item.filePath}:${item.lineNumber}`);
            impactCount++;
          }
          lines.push('');
        }
        if (results.length > maxImpact) {
          lines.push(`... and ${results.length - maxImpact} more`);
        }

        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n'),
            },
          ],
        };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
        }
      }
    }
  );

  server.tool(
    'code_context',
    '360-degree view of a code symbol — callers, callees, cluster, flows, infrastructure connections',
    {
      name: z.string().describe('Symbol name (function, class, method, interface)'),
      file_path: z.string().optional().describe('File path to disambiguate common names'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ name, file_path, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'code_context name="' + name + '" file_path="' + (file_path || '') + '" workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace, file_path)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }

      const effectiveProjectHash = wsResult.projectHash
      const effectiveDb = wsResult.db

      if (!effectiveDb) {
        if (wsResult.needsClose) wsResult.store.close()
        return {
          content: [{ type: 'text', text: 'Symbol graph database not available.' }],
          isError: true,
        };
      }

      try {
        const graph = new SymbolGraph(effectiveDb);
        const result = graph.handleContext({
          name,
          filePath: file_path,
          projectHash: effectiveProjectHash,
        });

        if (!result.found && result.disambiguation) {
          const lines = ['**Multiple symbols found. Please specify file_path:**', ''];
          for (const s of result.disambiguation) {
            lines.push(`- \`${s.name}\` (${s.kind}) in ${s.filePath}:${s.startLine}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!result.found) {
          return { content: [{ type: 'text', text: `Symbol not found: ${name}` }] };
        }

        const lines: string[] = [];
        const sym = result.symbol!;
        lines.push(`## ${sym.name} (${sym.kind})`);
        lines.push(`**File:** ${sym.filePath}:${sym.startLine}-${sym.endLine}`);
        lines.push(`**Exported:** ${sym.exported ? 'Yes' : 'No'}`);
        if (result.clusterLabel) {
          lines.push(`**Cluster:** ${result.clusterLabel}`);
        }
        lines.push('');

        if (result.incoming && result.incoming.length > 0) {
          const maxIncoming = 20;
          const displayIncoming = result.incoming.slice(0, maxIncoming);
          lines.push(`### Callers (${result.incoming.length})`);
          for (const e of displayIncoming) {
            lines.push(`- ${e.name} (${e.kind}) — ${e.filePath} [${e.edgeType}, ${(e.confidence * 100).toFixed(0)}%]`);
          }
          if (result.incoming.length > maxIncoming) {
            lines.push(`... and ${result.incoming.length - maxIncoming} more`);
          }
          lines.push('');
        }

        if (result.outgoing && result.outgoing.length > 0) {
          const maxOutgoing = 20;
          const displayOutgoing = result.outgoing.slice(0, maxOutgoing);
          lines.push(`### Callees (${result.outgoing.length})`);
          for (const e of displayOutgoing) {
            lines.push(`- ${e.name} (${e.kind}) — ${e.filePath} [${e.edgeType}, ${(e.confidence * 100).toFixed(0)}%]`);
          }
          if (result.outgoing.length > maxOutgoing) {
            lines.push(`... and ${result.outgoing.length - maxOutgoing} more`);
          }
          lines.push('');
        }

        if (result.flows && result.flows.length > 0) {
          const maxFlows = 10;
          const displayFlows = result.flows.slice(0, maxFlows);
          lines.push(`### Flows (${result.flows.length})`);
          for (const f of displayFlows) {
            lines.push(`- ${f.label} (${f.flowType}) — step ${f.stepIndex}`);
          }
          if (result.flows.length > maxFlows) {
            lines.push(`... and ${result.flows.length - maxFlows} more`);
          }
          lines.push('');
        }

        if (result.infrastructureSymbols && result.infrastructureSymbols.length > 0) {
          lines.push(`### Infrastructure (${result.infrastructureSymbols.length})`);
          for (const s of result.infrastructureSymbols) {
            lines.push(`- [${s.type}] ${s.pattern} (${s.operation})`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
          if (effectiveDb !== deps.db) effectiveDb.close()
        }
      }
    }
  );

  server.tool(
    'code_impact',
    'Analyze impact of changing a symbol — upstream/downstream dependencies, affected flows, risk level',
    {
      target: z.string().describe('Symbol name to analyze'),
      direction: z.enum(['upstream', 'downstream']).describe('Direction: upstream (callers) or downstream (callees)'),
      max_depth: z.number().optional().default(3).describe('Maximum traversal depth (default: 3)'),
      max_entries: z.number().optional().default(50).describe('Maximum total entries to return (default: 50)'),
      min_confidence: z.number().optional().describe('Minimum edge confidence (0-1, default: 0)'),
      file_path: z.string().optional().describe('File path to disambiguate common names'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ target, direction, max_depth, max_entries, min_confidence, file_path, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'code_impact target="' + target + '" direction="' + direction + '" workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace, file_path)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }

      const effectiveProjectHash = wsResult.projectHash
      const effectiveDb = wsResult.db

      if (!effectiveDb) {
        if (wsResult.needsClose) wsResult.store.close()
        return {
          content: [{ type: 'text', text: 'Symbol graph database not available.' }],
          isError: true,
        };
      }

      try {
        const graph = new SymbolGraph(effectiveDb);
        const result = graph.handleImpact({
          target,
          direction,
          maxDepth: max_depth,
          minConfidence: min_confidence,
          filePath: file_path,
          projectHash: effectiveProjectHash,
        });

        if (!result.found && result.disambiguation) {
          const lines = ['**Multiple symbols found. Please specify file_path:**', ''];
          for (const s of result.disambiguation) {
            lines.push(`- \`${s.name}\` (${s.kind}) in ${s.filePath}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (!result.found) {
          return { content: [{ type: 'text', text: `Symbol not found: ${target}` }] };
        }

        const lines: string[] = [];
        const t = result.target!;
        lines.push(`## Impact Analysis: ${t.name}`);
        lines.push(`**Direction:** ${direction}`);
        lines.push(`**Risk Level:** ${result.risk}`);
        lines.push(`**Summary:** ${result.summary.directDeps} direct deps, ${result.summary.totalAffected} total affected, ${result.summary.flowsAffected} flows`);
        lines.push('');

        let totalEntries = 0;
        let truncatedEntries = 0;
        const maxDepth = max_depth ?? 3;
        const maxEntries = max_entries ?? 50;
        const truncatedByDepth: Record<string, Array<{ name: string; kind: string; filePath: string; edgeType: string }>> = {};
        for (const [depth, depItems] of Object.entries(result.byDepth as Record<string, Array<{ name: string; kind: string; filePath: string; edgeType: string; confidence: number }>>)) {
          if (parseInt(depth) > maxDepth) {
            truncatedEntries += depItems.length;
            continue;
          }
          const remaining = maxEntries - totalEntries;
          if (remaining <= 0) {
            truncatedEntries += depItems.length;
            continue;
          }
          if (depItems.length > remaining) {
            truncatedByDepth[depth] = depItems.slice(0, remaining);
            truncatedEntries += depItems.length - remaining;
            totalEntries += remaining;
          } else {
            truncatedByDepth[depth] = depItems;
            totalEntries += depItems.length;
          }
        }

        for (const [depth, depItems] of Object.entries(truncatedByDepth)) {
          if (depItems.length > 0) {
            lines.push(`### Depth ${depth} (${depItems.length})`);
            for (const d of depItems) {
              lines.push(`- ${d.name} (${d.kind}) — ${d.filePath} [${d.edgeType}]`);
            }
            lines.push('');
          }
        }
        if (truncatedEntries > 0) {
          lines.push(`... and ${truncatedEntries} more at deeper levels`);
          lines.push('');
        }

        if (result.affectedFlows.length > 0) {
          const maxFlows = 20;
          const displayFlows = result.affectedFlows.slice(0, maxFlows);
          lines.push(`### Affected Flows (${result.affectedFlows.length})`);
          for (const f of displayFlows) {
            lines.push(`- ${f.label} (${f.flowType}) — step ${f.stepIndex}`);
          }
          if (result.affectedFlows.length > maxFlows) {
            lines.push(`... and ${result.affectedFlows.length - maxFlows} more`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
          if (effectiveDb !== deps.db) effectiveDb.close()
        }
      }
    }
  );

  server.tool(
    'code_detect_changes',
    'Detect changed symbols and affected flows from git diff',
    {
      scope: z.enum(['unstaged', 'staged', 'all']).optional().describe('Git diff scope (default: all)'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ scope, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'code_detect_changes scope="' + (scope || 'all') + '" workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }

      const effectiveDb = wsResult.db
      if (!effectiveDb) {
        if (wsResult.needsClose) wsResult.store.close()
        return {
          content: [{ type: 'text', text: 'Symbol graph database not available.' }],
          isError: true,
        };
      }

      try {
      const graph = new SymbolGraph(effectiveDb);
      const result = graph.handleDetectChanges({
        scope,
        workspaceRoot: wsResult.workspaceRoot,
        projectHash: wsResult.projectHash,
      });

      if (result.changedFiles.length === 0) {
        return { content: [{ type: 'text', text: 'No changes detected.' }] };
      }

      const lines: string[] = [];
      lines.push(`## Change Detection`);
      lines.push(`**Risk Level:** ${result.riskLevel}`);
      lines.push('');

      lines.push(`### Changed Files (${result.changedFiles.length})`);
      for (const f of result.changedFiles.slice(0, 20)) {
        lines.push(`- ${f}`);
      }
      if (result.changedFiles.length > 20) {
        lines.push(`... and ${result.changedFiles.length - 20} more`);
      }
      lines.push('');

      if (result.changedSymbols.length > 0) {
        lines.push(`### Changed Symbols (${result.changedSymbols.length})`);
        for (const s of result.changedSymbols.slice(0, 30)) {
          lines.push(`- ${s.name} (${s.kind}) — ${s.filePath}`);
        }
        if (result.changedSymbols.length > 30) {
          lines.push(`... and ${result.changedSymbols.length - 30} more`);
        }
        lines.push('');
      }

      if (result.affectedFlows.length > 0) {
        const maxFlows = 20;
        lines.push(`### Affected Flows (${result.affectedFlows.length})`);
        for (const f of result.affectedFlows.slice(0, maxFlows)) {
          lines.push(`- ${f.label} (${f.flowType})`);
        }
        if (result.affectedFlows.length > maxFlows) {
          lines.push(`... and ${result.affectedFlows.length - maxFlows} more`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
      } finally {
        if (wsResult.needsClose) {
          wsResult.store.close()
          if (effectiveDb !== deps.db) effectiveDb.close()
        }
      }
    }
  );

  server.tool(
    'memory_consolidate',
    'Trigger memory consolidation cycle manually',
    {
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_consolidate triggered');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      const effectiveStore = wsResult.store;

      try {
        const config = loadCollectionConfig(deps.configPath);

        if (!config?.consolidation?.enabled) {
          return {
            content: [{ type: 'text', text: 'Consolidation is not enabled. Set consolidation.enabled=true in config.yml' }],
          };
        }

        const consolidationConfig = config.consolidation as ConsolidationConfig;
        const provider = createLLMProvider(consolidationConfig);

        if (!provider) {
          return {
            content: [{ type: 'text', text: 'No API key configured. Set consolidation.apiKey in config.yml or CONSOLIDATION_API_KEY env var' }],
          };
        }

        const agent = new ConsolidationAgent(effectiveStore, {
          llmProvider: provider,
          maxMemoriesPerCycle: consolidationConfig.max_memories_per_cycle,
          minMemoriesThreshold: consolidationConfig.min_memories_threshold,
          confidenceThreshold: consolidationConfig.confidence_threshold,
        });

        const results = await agent.runConsolidationCycle();

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No memories to consolidate' }],
          };
        }

        return {
          content: [{ type: 'text', text: `Consolidation complete: ${results.length} consolidation(s) created` }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log('mcp', 'memory_consolidate failed: ' + errorMsg);
        return {
          content: [{ type: 'text', text: `Consolidation failed: ${errorMsg}` }],
          isError: true,
        };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_consolidation_status',
    'Show consolidation queue status and recent activity',
    {
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_consolidation_status');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      try {
        const effectiveStore = wsResult.store;
        const queueStats = effectiveStore.getQueueStats();
        const recentLogs = effectiveStore.getRecentConsolidationLogs(10);

        const config = loadCollectionConfig(deps.configPath);
        const consolidationEnabled = config?.consolidation?.enabled ?? false;

        let text = '## Consolidation Status\n\n';
        text += `**Enabled:** ${consolidationEnabled ? 'Yes' : 'No'}\n`;
        text += '\n### Queue\n';
        text += `- Pending: ${queueStats.pending}\n`;
        text += `- Processing: ${queueStats.processing}\n`;
        text += `- Completed: ${queueStats.completed}\n`;
        text += `- Failed: ${queueStats.failed}\n`;

        if (recentLogs.length > 0) {
          text += '\n### Recent Activity\n';
          for (const log of recentLogs) {
            const targetInfo = log.target_doc_id ? ` → doc ${log.target_doc_id}` : '';
            text += `- [${log.created_at}] doc ${log.document_id}: **${log.action}**${targetInfo}`;
            if (log.reason) {
              text += ` — ${log.reason}`;
            }
            if (log.tokens_used > 0) {
              text += ` (${log.tokens_used} tokens)`;
            }
            text += '\n';
          }
        } else {
          text += '\n_No recent consolidation activity._\n';
        }

        return { content: [{ type: 'text', text }] };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_importance',
    'View document importance scores with breakdown',
    {
      limit: z.number().optional().default(10).describe('Number of top documents to show'),
      workspace: z.string().optional().describe('Workspace path or hash.'),
    },
    async ({ limit, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_importance limit=' + limit);

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      try {
        return {
          content: [{ type: 'text', text: 'Importance scoring not yet active. Enable with importance.enabled=true in config.' }],
        };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_learning_status',
    'Show learning system status: telemetry, bandits, consolidation, importance',
    {
      workspace: z.string().optional().describe('Workspace path or hash.'),
    },
    async ({ workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_learning_status');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      try {
        const effectiveStore = wsResult.store;
        const effectiveProjectHash = wsResult.projectHash;

        const telemetryCount = effectiveStore.getTelemetryCount();
        const banditStats = effectiveStore.loadBanditStats(effectiveProjectHash);
        const globalLearning = effectiveStore.getGlobalLearning();

        let text = '## Learning Status\n\n';
        text += '**PID:** ' + process.pid + '\n';
        text += '**Uptime:** ' + Math.round(process.uptime()) + 's\n';
        text += '**Telemetry:** ' + telemetryCount + ' queries logged\n';
        text += '**Bandit Stats:** ' + banditStats.length + ' variant records\n';

        if (banditStats.length > 0) {
          text += '\n### Active Bandits\n';
          const grouped = new Map<string, typeof banditStats>();
          for (const s of banditStats) {
            const arr = grouped.get(s.parameter_name) ?? [];
            arr.push(s);
            grouped.set(s.parameter_name, arr);
          }
          for (const [param, variants] of grouped) {
            text += '\n**' + param + ':**\n';
            for (const v of variants) {
              const total = v.successes + v.failures;
              const rate = total > 0 ? (v.successes / total * 100).toFixed(1) : 'N/A';
              text += '  - ' + v.variant_value + ': ' + v.successes + '/' + total + ' (' + rate + '% success)\n';
            }
          }
        }

        if (globalLearning.length > 0) {
          text += '\n### Global Learning\n';
          for (const g of globalLearning) {
            text += '- ' + g.parameter_name + ': ' + g.value.toFixed(4) + ' (confidence: ' + g.confidence.toFixed(2) + ')\n';
          }
        }

        try {
          const clusters = effectiveStore.getQueryClusters(effectiveProjectHash);
          const transitions = effectiveStore.getClusterTransitions(effectiveProjectHash);
          const accuracy = effectiveStore.getSuggestionAccuracy(effectiveProjectHash);

          text += '\n### Proactive Intelligence\n';
          text += '- Clusters: ' + clusters.length + '\n';
          text += '- Transitions: ' + transitions.length + '\n';
          if (accuracy.total > 0) {
            text += '- Prediction accuracy: ' + ((accuracy.exact + accuracy.partial) / accuracy.total * 100).toFixed(1) + '% (' + accuracy.exact + ' exact, ' + accuracy.partial + ' partial, ' + accuracy.none + ' miss out of ' + accuracy.total + ')\n';
          }
        } catch {
        }

        return { content: [{ type: 'text', text }] };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_suggestions',
    'Get proactive suggestions for what the user might need next based on query patterns',
    {
      context: z.string().optional().describe('Current query or topic context'),
      workspace: z.string().optional().describe('Workspace path or hash'),
      limit: z.number().optional().default(3).describe('Max suggestions to return'),
    },
    async ({ context, workspace, limit }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_suggestions context="' + (context || '') + '" workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      try {
        const effectiveStore = wsResult.store;
        const effectiveProjectHash = wsResult.projectHash;

        if (!deps.sequenceAnalyzer) {
          return {
            content: [{ type: 'text', text: 'Proactive intelligence is not configured. Set proactive.enabled=true in config.yml.' }],
            isError: true,
          };
        }

        if (!context) {
          const profile = effectiveStore.getWorkspaceProfile(effectiveProjectHash);
          const telemetryStats = effectiveStore.getTelemetryStats(effectiveProjectHash);
          if (telemetryStats.queryCount < 50) {
            return { content: [{ type: 'text', text: 'Not enough data for suggestions. Need at least 50 queries (current: ' + telemetryStats.queryCount + ').' }] };
          }
          const topKeywords = effectiveStore.getTelemetryTopKeywords(effectiveProjectHash, 5);
          const expandRate = telemetryStats.queryCount > 0 ? (telemetryStats.expandCount / telemetryStats.queryCount) : 0;
          return {
            content: [{ type: 'text', text: '## Workspace Insights\n\n**Top topics:** ' + topKeywords.map(k => k.keyword).join(', ') + '\n**Queries logged:** ' + telemetryStats.queryCount + '\n**Expand rate:** ' + (expandRate * 100).toFixed(1) + '%' }],
          };
        }

        const suggestions = await deps.sequenceAnalyzer.predictNext(context, effectiveProjectHash, limit ?? 3);

        if (suggestions.length === 0) {
          return { content: [{ type: 'text', text: 'No predictions available for this context. The system needs more query data to learn patterns.' }] };
        }

        const dataFreshness = new Date().toISOString();

        let text = '## Predicted Next Queries\n\n';
        for (const s of suggestions) {
          text += '- **' + s.query + '** (confidence: ' + (s.confidence * 100).toFixed(0) + '%)\n';
          text += '  ' + s.reasoning + '\n';
          if (s.relatedDocids.length > 0) {
            text += '  Related docs: ' + s.relatedDocids.join(', ') + '\n';
          }
          text += '\n';
        }
        text += '_Data freshness: ' + dataFreshness + '_';

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: 'Prediction failed: ' + (err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_graph_query',
    'Traverse the knowledge graph starting from an entity',
    {
      entity: z.string().describe('Entity name to start traversal from'),
      maxDepth: z.number().optional().default(3).describe('Maximum traversal depth (1-10)'),
      relationshipTypes: z.array(z.string()).optional().describe('Filter by relationship types'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ entity, maxDepth, relationshipTypes, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_graph_query entity="' + entity + '" maxDepth=' + maxDepth);

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      const effectiveStore = wsResult.store;
      const effectiveProjectHash = wsResult.projectHash;
      const clampedDepth = Math.min(Math.max(maxDepth ?? 3, 1), 10);

      try {
        const db = effectiveStore.getDb();
        const entityRow = db.prepare(`
          SELECT id, name, type, description, first_learned_at, last_confirmed_at, contradicted_at
          FROM memory_entities
          WHERE name = ? AND project_hash = ?
        `).get(entity, effectiveProjectHash) as {
          id: number;
          name: string;
          type: string;
          description: string | null;
          first_learned_at: string;
          last_confirmed_at: string;
          contradicted_at: string | null;
        } | undefined;

        if (!entityRow) {
          const similarRows = db.prepare(`
            SELECT name, type FROM memory_entities
            WHERE project_hash = ? AND name LIKE ?
            LIMIT 5
          `).all(effectiveProjectHash, '%' + entity + '%') as Array<{ name: string; type: string }>;

          if (similarRows.length > 0) {
            const suggestions = similarRows.map(r => `- ${r.name} (${r.type})`).join('\n');
            return { content: [{ type: 'text', text: `Entity not found: "${entity}"\n\nDid you mean:\n${suggestions}` }] };
          }
          return { content: [{ type: 'text', text: `Entity not found: "${entity}"` }] };
        }

        const lines: string[] = [];
        lines.push(`## ${entityRow.name} (${entityRow.type})`);
        if (entityRow.description) {
          lines.push(`**Description:** ${entityRow.description}`);
        }
        lines.push(`**First learned:** ${entityRow.first_learned_at}`);
        lines.push(`**Last confirmed:** ${entityRow.last_confirmed_at}`);
        if (entityRow.contradicted_at) {
          lines.push(`**⚠️ Contradicted:** ${entityRow.contradicted_at}`);
        }
        lines.push('');

        const visited = new Set<number>([entityRow.id]);
        const queue: Array<{ id: number; depth: number }> = [{ id: entityRow.id, depth: 0 }];
        const byDepth: Record<number, Array<{ name: string; type: string; edgeType: string; direction: string }>> = {};

        let typeFilter = '';
        if (relationshipTypes && relationshipTypes.length > 0) {
          const placeholders = relationshipTypes.map(() => '?').join(',');
          typeFilter = ` AND e.edge_type IN (${placeholders})`;
        }

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= clampedDepth) continue;

          const outgoingQuery = `
            SELECT e.target_id, e.edge_type, me.name, me.type
            FROM memory_edges e
            JOIN memory_entities me ON e.target_id = me.id
            WHERE e.source_id = ? AND e.project_hash = ?${typeFilter}
          `;
          const incomingQuery = `
            SELECT e.source_id, e.edge_type, me.name, me.type
            FROM memory_edges e
            JOIN memory_entities me ON e.source_id = me.id
            WHERE e.target_id = ? AND e.project_hash = ?${typeFilter}
          `;

          const outParams = relationshipTypes ? [current.id, effectiveProjectHash, ...relationshipTypes] : [current.id, effectiveProjectHash];
          const inParams = relationshipTypes ? [current.id, effectiveProjectHash, ...relationshipTypes] : [current.id, effectiveProjectHash];

          const outgoing = db.prepare(outgoingQuery).all(...outParams) as Array<{ target_id: number; edge_type: string; name: string; type: string }>;
          const incoming = db.prepare(incomingQuery).all(...inParams) as Array<{ source_id: number; edge_type: string; name: string; type: string }>;

          const nextDepth = current.depth + 1;
          if (!byDepth[nextDepth]) byDepth[nextDepth] = [];

          for (const row of outgoing) {
            byDepth[nextDepth].push({ name: row.name, type: row.type, edgeType: row.edge_type, direction: '→' });
            if (!visited.has(row.target_id)) {
              visited.add(row.target_id);
              queue.push({ id: row.target_id, depth: nextDepth });
            }
          }

          for (const row of incoming) {
            byDepth[nextDepth].push({ name: row.name, type: row.type, edgeType: row.edge_type, direction: '←' });
            if (!visited.has(row.source_id)) {
              visited.add(row.source_id);
              queue.push({ id: row.source_id, depth: nextDepth });
            }
          }
        }

        for (const [depth, items] of Object.entries(byDepth)) {
          if (items.length > 0) {
            lines.push(`### Depth ${depth} (${items.length})`);
            for (const item of items.slice(0, 20)) {
              lines.push(`  ${item.direction} ${item.name} (${item.type}) [${item.edgeType}]`);
            }
            if (items.length > 20) {
              lines.push(`  ... and ${items.length - 20} more`);
            }
            lines.push('');
          }
        }

        if (Object.keys(byDepth).length === 0) {
          lines.push('_No connected entities found._');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        if (err instanceof Error && err.message.includes('no such table')) {
          return { content: [{ type: 'text', text: 'Knowledge graph not initialized. Entity extraction will populate it as memories are written.' }] };
        }
        throw err;
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
      }
    }
  );

  server.tool(
    'memory_related',
    'Find memories related to a topic with entity context enrichment',
    {
      topic: z.string().describe('Topic to find related memories for'),
      collection: z.string().optional().describe('Filter by collection'),
      limit: z.number().optional().default(5).describe('Max results (1-10)'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ topic, collection, limit, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_related topic="' + topic + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return { content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }], isError: true };
      }
      const effectiveProjectHash = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const clampedLimit = Math.min(Math.max(limit ?? 5, 1), 10);

      const searchResults = await hybridSearch(
        store,
        {
          query: topic,
          limit: clampedLimit,
          collection,
          projectHash: effectiveProjectHash,
          searchConfig: deps.searchConfig,
          db: deps.db,
          internal: true,
        },
        providers
      ).catch(() => [] as import('./types.js').SearchResult[]);

      if (searchResults.length === 0) {
        return { content: [{ type: 'text', text: 'No related memories found for: ' + topic }] };
      }

      const lines: string[] = [];
      lines.push(`## Related Memories: "${topic}"`);
      lines.push('');

      for (let i = 0; i < searchResults.length; i++) {
        const r = searchResults[i];
        lines.push(`### ${i + 1}. ${r.title} (${r.docid})`);
        lines.push(`**Score:** ${r.score.toFixed(3)} | **Path:** ${r.path}`);

        try {
          const docEntities = store.getDb().prepare(`
            SELECT DISTINCT me.name, me.type
            FROM memory_edges edge
            JOIN memory_entities me ON (edge.source_id = me.id OR edge.target_id = me.id)
            WHERE edge.source_id = ? OR edge.target_id = ?
            LIMIT 5
          `).all(parseInt(r.id), parseInt(r.id)) as Array<{ name: string; type: string }>;

          if (docEntities.length > 0) {
            const entityList = docEntities.map(e => `${e.name} (${e.type})`).join(', ');
            lines.push(`**Entities:** ${entityList}`);
          }
        } catch {
        }

        const snippet = r.snippet.length > 200 ? r.snippet.substring(0, 200) + '...' : r.snippet;
        lines.push(`\n${snippet}\n`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'memory_timeline',
    'Show chronological timeline of memories for a topic',
    {
      topic: z.string().describe('Topic to show timeline for'),
      startDate: z.string().optional().describe('Filter start date (ISO format)'),
      endDate: z.string().optional().describe('Filter end date (ISO format)'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ topic, startDate, endDate, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_timeline topic="' + topic + '" startDate=' + (startDate || '') + ' endDate=' + (endDate || ''));
      if (deps.daemon && !workspace) {
        return { content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }], isError: true };
      }
      const effectiveProjectHash = workspace === 'all' ? 'all' : (workspace || currentProjectHash);

      try {
        const db = store.getDb();

        let entityIds: number[] = [];
        try {
          const entityRows = db.prepare(`
            SELECT id FROM memory_entities
            WHERE project_hash = ? AND (name LIKE ? OR description LIKE ?)
          `).all(effectiveProjectHash, '%' + topic + '%', '%' + topic + '%') as Array<{ id: number }>;
          entityIds = entityRows.map(r => r.id);
        } catch {
        }

        let dateFilter = '';
        const params: (string | number)[] = [effectiveProjectHash];
        if (startDate) {
          dateFilter += ' AND d.modified_at >= ?';
          params.push(startDate);
        }
        if (endDate) {
          dateFilter += ' AND d.modified_at <= ?';
          params.push(endDate);
        }

        let query: string;
        if (entityIds.length > 0) {
          const placeholders = entityIds.map(() => '?').join(',');
          query = `
            SELECT DISTINCT d.id, d.title, d.path, d.modified_at, d.superseded_by,
              CASE
                WHEN d.superseded_by IS NOT NULL THEN 'superseded'
                ELSE 'active'
              END as status
            FROM documents d
            LEFT JOIN memory_edges me ON (me.source_id = d.id OR me.target_id = d.id)
            WHERE d.project_hash = ? AND d.active = 1
              AND (me.source_id IN (${placeholders}) OR me.target_id IN (${placeholders}) OR d.title LIKE ? OR d.path LIKE ?)
              ${dateFilter}
            ORDER BY d.modified_at DESC
            LIMIT 20
          `;
          params.push(...entityIds, ...entityIds, '%' + topic + '%', '%' + topic + '%');
        } else {
          query = `
            SELECT d.id, d.title, d.path, d.modified_at, d.superseded_by,
              CASE
                WHEN d.superseded_by IS NOT NULL THEN 'superseded'
                ELSE 'active'
              END as status
            FROM documents d
            WHERE d.project_hash = ? AND d.active = 1
              AND (d.title LIKE ? OR d.path LIKE ?)
              ${dateFilter}
            ORDER BY d.modified_at DESC
            LIMIT 20
          `;
          params.push('%' + topic + '%', '%' + topic + '%');
        }

        const rows = db.prepare(query).all(...params) as Array<{
          id: number;
          title: string;
          path: string;
          modified_at: string;
          superseded_by: number | null;
          status: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: 'text', text: `No timeline entries found for: "${topic}"` }] };
        }

        const lines: string[] = [];
        lines.push(`## Timeline: "${topic}"`);
        if (startDate || endDate) {
          lines.push(`**Date range:** ${startDate || 'beginning'} to ${endDate || 'now'}`);
        }
        lines.push('');

        for (const row of rows) {
          const date = row.modified_at.split('T')[0];
          const statusIcon = row.status === 'superseded' ? '~~' : '';
          const supersededNote = row.superseded_by ? ` (superseded by #${row.superseded_by})` : '';
          lines.push(`- **${date}** ${statusIcon}${row.title}${statusIcon}${supersededNote}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        if (err instanceof Error && err.message.includes('no such table')) {
          const db = store.getDb();
          let dateFilter = '';
          const params: string[] = [effectiveProjectHash];
          if (startDate) {
            dateFilter += ' AND modified_at >= ?';
            params.push(startDate);
          }
          if (endDate) {
            dateFilter += ' AND modified_at <= ?';
            params.push(endDate);
          }

          const rows = db.prepare(`
            SELECT id, title, path, modified_at, superseded_by
            FROM documents
            WHERE project_hash = ? AND active = 1 AND (title LIKE ? OR path LIKE ?)
            ${dateFilter}
            ORDER BY modified_at DESC
            LIMIT 20
          `).all(...params, '%' + topic + '%', '%' + topic + '%') as Array<{
            id: number;
            title: string;
            path: string;
            modified_at: string;
            superseded_by: number | null;
          }>;

          if (rows.length === 0) {
            return { content: [{ type: 'text', text: `No timeline entries found for: "${topic}"` }] };
          }

          const lines: string[] = [];
          lines.push(`## Timeline: "${topic}"`);
          lines.push('');
          for (const row of rows) {
            const date = row.modified_at.split('T')[0];
            lines.push(`- **${date}** ${row.title}`);
            lines.push(`  ${row.path}`);
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        throw err;
      }
    }
  );

  server.tool(
    'memory_connections',
    'Get all connections for a document. Shows how memories relate to each other.',
    {
      doc_id: z.string().describe('Document ID or path'),
      relationship_type: z.string().optional().describe('Filter by type: supports, contradicts, extends, supersedes, related, caused_by, refines, implements'),
      direction: z.enum(['incoming', 'outgoing', 'both']).optional().default('both').describe('Connection direction'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ doc_id, relationship_type, direction, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_connections doc_id="' + doc_id + '" type="' + (relationship_type || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      const doc = wsResult.store.findDocument(doc_id);
      if (!doc) {
        return { content: [{ type: 'text', text: 'Document not found: ' + doc_id }], isError: true };
      }

      if (relationship_type && !isValidRelationshipType(relationship_type)) {
        return { content: [{ type: 'text', text: 'Invalid relationship type: ' + relationship_type + '. Valid: ' + VALID_RELATIONSHIP_TYPES.join(', ') }], isError: true };
      }

      const connections = wsResult.store.getConnectionsForDocument(doc.id, {
        direction: direction as 'incoming' | 'outgoing' | 'both',
        relationshipType: relationship_type,
      });

      if (connections.length === 0) {
        return { content: [{ type: 'text', text: 'No connections found for ' + doc_id }] };
      }

      const lines: string[] = [`## Connections for ${doc.title} (${connections.length})\n`];
      for (const conn of connections) {
        const otherId = conn.fromDocId === doc.id ? conn.toDocId : conn.fromDocId;
        const otherDoc = wsResult.store.findDocument(String(otherId));
        const dir = conn.fromDocId === doc.id ? '→' : '←';
        lines.push(`- ${dir} **${conn.relationshipType}** ${otherDoc?.title ?? 'doc#' + otherId} (strength: ${conn.strength.toFixed(2)}, by: ${conn.createdBy})`);
        if (conn.description) lines.push(`  ${conn.description}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'memory_traverse',
    'Traverse the memory connection graph from a starting document. Finds related memories up to N hops away.',
    {
      start_doc_id: z.string().describe('Starting document ID or path'),
      max_depth: z.number().optional().default(2).describe('Maximum traversal depth (default: 2)'),
      relationship_types: z.array(z.string()).optional().describe('Only follow these relationship types'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ start_doc_id, max_depth, relationship_types, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_traverse start="' + start_doc_id + '" depth=' + max_depth);

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      const doc = wsResult.store.findDocument(start_doc_id);
      if (!doc) {
        return { content: [{ type: 'text', text: 'Document not found: ' + start_doc_id }], isError: true };
      }

      if (relationship_types) {
        for (const rt of relationship_types) {
          if (!isValidRelationshipType(rt)) {
            return { content: [{ type: 'text', text: 'Invalid relationship type: ' + rt + '. Valid: ' + VALID_RELATIONSHIP_TYPES.join(', ') }], isError: true };
          }
        }
      }

      const nodes = traverse(wsResult.store, doc.id, { maxDepth: max_depth, relationshipTypes: relationship_types });

      if (nodes.length === 0) {
        return { content: [{ type: 'text', text: 'No connected memories found within depth ' + max_depth }] };
      }

      const lines: string[] = [`## Graph traversal from: ${doc.title}\n`];
      for (const node of nodes) {
        const nodeDoc = wsResult.store.findDocument(String(node.docId));
        const indent = '  '.repeat(node.depth);
        const lastConn = node.path[node.path.length - 1];
        lines.push(`${indent}[depth ${node.depth}] ${nodeDoc?.title ?? 'doc#' + node.docId} (via ${lastConn?.relationshipType ?? '?'})`);
      }
      lines.push(`\n**Total:** ${nodes.length} connected memories found`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'memory_connect',
    'Create a connection between two memories. Defines how they relate to each other.',
    {
      from_doc_id: z.string().describe('Source document ID or path'),
      to_doc_id: z.string().describe('Target document ID or path'),
      relationship_type: z.string().describe('Type: supports, contradicts, extends, supersedes, related, caused_by, refines, implements'),
      description: z.string().optional().describe('Description of the relationship'),
      strength: z.number().optional().default(1.0).describe('Connection strength 0.0-1.0 (default: 1.0)'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ from_doc_id, to_doc_id, relationship_type, description, strength, workspace }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_connect from="' + from_doc_id + '" to="' + to_doc_id + '" type="' + relationship_type + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      if (!isValidRelationshipType(relationship_type)) {
        return { content: [{ type: 'text', text: 'Invalid relationship type: ' + relationship_type + '. Valid: ' + VALID_RELATIONSHIP_TYPES.join(', ') }], isError: true };
      }

      const fromDoc = wsResult.store.findDocument(from_doc_id);
      if (!fromDoc) {
        return { content: [{ type: 'text', text: 'Source document not found: ' + from_doc_id }], isError: true };
      }

      const toDoc = wsResult.store.findDocument(to_doc_id);
      if (!toDoc) {
        return { content: [{ type: 'text', text: 'Target document not found: ' + to_doc_id }], isError: true };
      }

      const count = wsResult.store.getConnectionCount(fromDoc.id);
      if (count >= 50) {
        return { content: [{ type: 'text', text: 'Connection limit reached (50) for document: ' + from_doc_id }], isError: true };
      }

      const id = wsResult.store.insertConnection({
        fromDocId: fromDoc.id,
        toDocId: toDoc.id,
        relationshipType: relationship_type as any,
        description: description ?? null,
        strength: strength ?? 1.0,
        createdBy: 'user',
        projectHash: wsResult.projectHash,
      });

      return {
        content: [{ type: 'text', text: `✅ Connection created (#${id}): ${fromDoc.title} —[${relationship_type}]→ ${toDoc.title}` }],
      };
    }
  );

  return server;
}



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
  // Suppress EPIPE on stdout/stderr — daemon may outlive its pipe
  process.stdout?.on('error', () => {});
  process.stderr?.on('error', () => {});

  const { dbPath, configPath, httpPort, httpHost = '127.0.0.1', daemon, root } = options;
  const isStdioTransport = !httpPort;
  if (isStdioTransport) {
    // In stdio transport mode, stdout/stderr must be reserved for MCP JSON-RPC frames.
    setStdioMode(true);
  }

  let cleanupRef: (() => void) | null = null;

  process.on('uncaughtException', (err: Error) => {
    // EPIPE is non-fatal for daemons (broken stdout/stderr pipe)
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
        log('server', 'vector provider=' + health.provider + ' ok=' + health.ok + ' vectors=' + health.vectorCount);
        log('server', `Vector store: ${health.provider} (ok=${health.ok}, vectors=${health.vectorCount})`);
        if (health.dimensions && configuredDimensions && health.dimensions !== configuredDimensions) {
          log('server', 'vector dimension mismatch config=' + configuredDimensions + ' qdrant=' + health.dimensions);
          log('server', `Vector dimension mismatch: config=${configuredDimensions}, qdrant=${health.dimensions}`, 'warn');
          log('server', 'Will validate against embedder dimensions after provider loads.', 'warn');
        }
      }).catch((err) => {
        log('server', 'vector health check failed error=' + (err instanceof Error ? err.message : String(err)));
        log('server', `Vector store health check failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      });
    } catch (err) {
      log('server', 'vector store creation failed error=' + (err instanceof Error ? err.message : String(err)));
      log('server', `Vector store creation failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  } else {
    log('server', 'vector provider=sqlite-vec (default)');
    log('server', 'Vector store: sqlite-vec (default)');
  }

  if (vectorStore) {
    store.setVectorStore(vectorStore);
  }

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
  const startFileWatcher = () => {
    if (watcher) {
      return;
    }
    log('server', 'Starting file watcher');

    // Detect overlapping workspaces
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
    watcher = startWatcher({
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
    });
  };

  const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  let httpServer: http.Server | null = null;
  let consolidationWorker: ConsolidationWorker | null = null;

  const cleanup = async () => {
    log('server', 'Shutting down');

    if (httpServer) {
      httpServer.close();
    }

    if (consolidationWorker) {
      await consolidationWorker.stop();
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    for (const [_id, session] of sseSessions) {
      try { await session.transport.close(); } catch {}
    }
    for (const [_id, session] of streamableSessions) {
      try { await session.transport.close(); } catch {}
    }

    if (watcher) watcher.stop();
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

  if (httpPort) {
    try {
      await initFTSWorker(effectiveDbPath);
    } catch (err) {
      log('server', 'FTS worker init failed, search will use main thread: ' + (err instanceof Error ? err.message : String(err)), 'warn');
    }

    const eventStore = new SqliteEventStore(symbolGraphDb, 300);
    const eventStoreCleanupInterval = setInterval(() => eventStore.cleanup(), 60000);
    eventStoreCleanupInterval.unref();

    const readBody = (req: http.IncomingMessage): Promise<string> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
      });

    httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (maintenanceMode && pathname !== '/api/maintenance/resume' && pathname !== '/health' && pathname !== '/api/maintenance/prepare') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'maintenance in progress' }));
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        let version = 'unknown';
        try {
          const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
          version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
        } catch {}
        const recovery = getLastCorruptionRecovery();
        const healthResponse: Record<string, unknown> = {
          status: 'ok',
          ready: readyState.value,
          version,
          uptime: process.uptime(),
          sessions: { sse: sseSessions.size, streamable: streamableSessions.size }
        };
        if (recovery?.recovered) {
          healthResponse.corruption_recovered = true;
          healthResponse.recovered_at = recovery.recoveredAt;
          healthResponse.corrupted_path = recovery.corruptedPath;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthResponse));
        return;
      }

      if (req.method === 'GET' && pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        const clientServer = createMcpServer(deps);

        transport.onclose = () => {
          sseSessions.delete(transport.sessionId);
          log('server', `SSE client disconnected sessionId=${transport.sessionId}`);
        };

        try {
          sseSessions.set(transport.sessionId, { transport, server: clientServer });
          log('server', `SSE client connected sessionId=${transport.sessionId}`);
          await clientServer.connect(transport);
        } catch (err) {
          sseSessions.delete(transport.sessionId);
          log('server', `SSE client connect failed sessionId=${transport.sessionId}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing sessionId parameter' }));
          return;
        }

        const session = sseSessions.get(sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        await session.transport.handlePostMessage(req, res);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        let indexHealth: any = null;
        let indexError: string | undefined;
        try {
          indexHealth = store.getIndexHealth();
        } catch (e) {
          indexError = e instanceof Error ? e.message : String(e);
          log('server', `getIndexHealth failed: ${indexError}`);
        }
        const modelStatus = store.modelStatus;
        let statusVersion = 'unknown';
        try {
          const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
          statusVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: indexError ? 'degraded' : 'ok',
          version: statusVersion,
          uptime: process.uptime(),
          ready: readyState.value,
          models: modelStatus,
          index: indexHealth,
          ...(indexError ? { error: indexError } : {}),
          workspace: { root: resolvedWorkspaceRoot, hash: currentProjectHash },
        }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/query') {
        const body = await readBody(req);
        try {
          const { query, tags, scope, limit } = JSON.parse(body);
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'query is required' }));
            return;
          }
          const effectiveProjectHash = scope === 'all' ? 'all' : currentProjectHash;
          const parsedTags = tags ? tags.split(',').map((t: string) => t.trim().toLowerCase()).filter((t: string) => t.length > 0) : undefined;
          // hybridSearch has internal timeouts: 1s FTS + 5s vec → max ~6s total
          const QUERY_TIMEOUT_MS = 6000;
          const results = await Promise.race([
            hybridSearch(
              store,
              { query, limit: limit || 10, projectHash: effectiveProjectHash, tags: parsedTags, searchConfig: deps.searchConfig, db: deps.db },
              providers
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Query timed out after ' + QUERY_TIMEOUT_MS + 'ms')), QUERY_TIMEOUT_MS)
            ),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid JSON body';
          const status = message.includes('timed out') ? 504 : 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/search') {
        const body = await readBody(req);
        try {
          const { query, limit } = JSON.parse(body);
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'query is required' }));
            return;
          }
          const safeLimit = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? limit : 10, 100));
          // Hard outer deadline to prevent indefinite blocking on WAL write locks
          const SEARCH_DEADLINE_MS = 8000;
          const FTS_TIMEOUT_MS = 5000;
          const deadline = new Promise<{ results: import('./types.js').SearchResult[]; timedOut: boolean }>((resolve) => {
            setTimeout(() => resolve({ results: [], timedOut: true }), SEARCH_DEADLINE_MS);
          });
          const doSearch = async (): Promise<{ results: import('./types.js').SearchResult[]; timedOut: boolean }> => {
            if (isFTSWorkerReady()) {
              try {
                const results = await Promise.race([
                  searchFTSAsync(query, { limit: safeLimit, projectHash: currentProjectHash }),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('__FTS_TIMEOUT__')), FTS_TIMEOUT_MS)
                  ),
                ]);
                return { results, timedOut: false };
              } catch (ftsErr: any) {
                log('server', `POST /api/search FTS worker timeout/fail: ${ftsErr?.message}`, 'warn');
              }
            }
            // NOTE: Do NOT call store.searchFTS() here — it is synchronous and will block
            // the event loop when SQLite WAL write locks are held by the embedder.
            // Return empty results immediately; the deadline Promise handles the timeout case.
            return { results: [], timedOut: false };
          };
          const { results, timedOut } = await Promise.race([doSearch(), deadline]);
          try { store.trackAccess(results.map((r: { id: string | number }) => typeof r.id === 'string' ? parseInt(r.id, 10) : r.id)); } catch { /* non-critical */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results, ...(timedOut ? { warning: 'search timed out, try again when indexing completes' } : {}) }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/write') {
        const body = await readBody(req);
        try {
          const { content, tags, workspace } = JSON.parse(body);
          if (!content || !content.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'content is required' }));
            return;
          }
          const date = new Date().toISOString().split('T')[0];
          const memoryDir = path.join(outputDir, 'memory');
          fs.mkdirSync(memoryDir, { recursive: true });
          const targetPath = path.join(memoryDir, `${date}.md`);
          const timestamp = new Date().toISOString();
          const workspaceName = path.basename(resolvedWorkspaceRoot);
          const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${currentProjectHash})\n\n${content}\n`;
          sequentialFileAppend(targetPath, entry);
          let tagInfo = '';
          if (tags) {
            const parsedTags = tags.split(',').map((t: string) => t.trim().toLowerCase()).filter((t: string) => t.length > 0);
            if (parsedTags.length > 0) {
              const fileContent = fs.readFileSync(targetPath, 'utf-8');
              const title = path.basename(targetPath, path.extname(targetPath));
              const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
              store.insertContent(hash, fileContent);
              const stats = fs.statSync(targetPath);
              const docId = store.insertDocument({
                collection: 'memory',
                path: targetPath,
                title,
                hash,
                createdAt: stats.birthtime.toISOString(),
                modifiedAt: stats.mtime.toISOString(),
                active: true,
                projectHash: currentProjectHash,
              });
              store.insertTags(docId, parsedTags);
              tagInfo = ` Tags: ${parsedTags.join(', ')}`;
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', path: targetPath, message: `Written to ${targetPath}${tagInfo}` }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/init') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Use maintenance endpoints for init operations from container. Run init directly on the host: npx nano-brain init' }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/reindex') {
        const body = await readBody(req);
        try {
          const { root } = JSON.parse(body || '{}');
          const effectiveRoot = root || resolvedWorkspaceRoot;
          const effectiveProjectHash = crypto.createHash('sha256').update(effectiveRoot).digest('hex').substring(0, 12);
          const wsConfig = getWorkspaceConfig(loadCollectionConfig(finalConfigPath), effectiveRoot);
          const codebaseConfig = wsConfig?.codebase ?? { enabled: true };
          indexCodebase(store, effectiveRoot, codebaseConfig, effectiveProjectHash, providers.embedder, symbolGraphDb)
            .then((stats) => {
              log('server', `[api/reindex] Reindex complete: ${stats.filesIndexed} indexed, ${stats.filesSkippedUnchanged} unchanged`);
            })
            .catch((err) => {
              log('server', `[api/reindex] Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'started', root: effectiveRoot }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/embed') {
        try {
          if (!providers.embedder) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Embedding provider not available' }));
            return;
          }
          embedPendingCodebase(store, providers.embedder, 50, currentProjectHash)
            .then((embedded) => {
              log('server', `[api/embed] Embedded ${embedded} chunks`);
            })
            .catch((err) => {
              log('server', `[api/embed] Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'started' }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Embedding failed' }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/maintenance/prepare') {
        if (maintenanceMode) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'maintenance already in progress' }));
          return;
        }
        maintenanceMode = true;
        if (watcher) {
          watcher.stop();
          watcher = null;
        }
        try {
          symbolGraphDb.pragma('wal_checkpoint(TRUNCATE)');
        } catch (err) {
          log('server', 'WAL checkpoint failed during maintenance prepare: ' + (err instanceof Error ? err.message : String(err)));
        }
        maintenanceTimer = setTimeout(() => {
          if (maintenanceMode) {
            maintenanceMode = false;
            startFileWatcher();
            log('server', 'Maintenance auto-resumed after timeout (no resume call received)');
          }
        }, 5 * 60 * 1000);
        log('server', 'Maintenance mode started');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'prepared' }));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/maintenance/resume') {
        if (!maintenanceMode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'no maintenance in progress' }));
          return;
        }
        maintenanceMode = false;
        if (maintenanceTimer) {
          clearTimeout(maintenanceTimer);
          maintenanceTimer = null;
        }
        startFileWatcher();
        log('server', 'Maintenance mode ended');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'resumed' }));
        return;
      }

      // CORS middleware for REST API and web dashboard
      if (req.url?.startsWith('/api/v1/') || req.url?.startsWith('/web/') || req.url === '/web') {
        const origin = req.headers.origin;
        if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          res.setHeader('Access-Control-Allow-Origin', origin || '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // Static file serving for web dashboard
      if (req.url?.startsWith('/web/') || req.url === '/web') {
        const webDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'web');
        let filePath = req.url === '/web' || req.url === '/web/'
          ? path.join(webDir, 'index.html')
          : path.join(webDir, req.url.slice(5));

        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(webDir))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

        const ext = path.extname(resolved);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };

        try {
          const content = fs.readFileSync(resolved);
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
          res.end(content);
        } catch {
          try {
            const indexContent = fs.readFileSync(path.join(webDir, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexContent);
          } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Web dashboard not built. Run: npm run build:web' }));
          }
        }
        return;
      }

      // REST API v1 endpoints
      if (req.method === 'GET' && pathname === '/api/v1/status') {
        let version = 'unknown';
        try {
          const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
          version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
        } catch {}
        const workspaces = deps.allWorkspaces
          ? Object.entries(deps.allWorkspaces).map(([wsPath]) => ({
              path: wsPath,
              name: path.basename(wsPath),
            }))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version,
          uptime: process.uptime(),
          documents: store.getIndexHealth().documentCount,
          embeddings: store.getIndexHealth().embeddedCount,
          workspaces,
          primaryWorkspace: resolvedWorkspaceRoot,
        }));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/workspaces') {
        const workspaceList: Array<{ path: string; name: string; hash: string; documentCount: number }> = [];
        if (deps.allWorkspaces) {
          for (const [wsPath] of Object.entries(deps.allWorkspaces)) {
            const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
            // Use a lightweight direct DB open instead of createStore() to avoid
            // the expensive store initialization (prepared statements, migrations, etc.)
            let docCount = 0;
            try {
              const wsDbPath = resolveWorkspaceDbPath(deps.dataDir ?? path.dirname(effectiveDbPath), wsPath);
              const lightDb = openDatabase(wsDbPath);
              try {
                const row = lightDb.prepare(
                  `SELECT COUNT(*) as cnt FROM documents WHERE active = 1 AND project_hash = ?`
                ).get(wsHash) as { cnt: number } | undefined;
                docCount = row?.cnt ?? 0;
              } finally {
                lightDb.close();
              }
            } catch { /* workspace DB may not exist yet */ }
            workspaceList.push({
              path: wsPath,
              name: path.basename(wsPath),
              hash: wsHash,
              documentCount: docCount,
            });
          }
        } else {
          workspaceList.push({
            path: resolvedWorkspaceRoot,
            name: path.basename(resolvedWorkspaceRoot),
            hash: currentProjectHash,
            documentCount: store.getIndexHealth().documentCount,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ workspaces: workspaceList }));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/entities') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const entities = store.getMemoryEntities(wsHash);
          const entityEdges: Array<{ id: number; sourceId: number; targetId: number; edgeType: string; createdAt: string }> = [];
          for (const entity of entities) {
            const edges = store.getEntityEdges(entity.id, 'outgoing');
            for (const edge of edges) {
              entityEdges.push({
                id: edge.id,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                edgeType: edge.edgeType,
                createdAt: edge.createdAt,
              });
            }
          }
          const typeDistribution: Record<string, number> = {};
          for (const entity of entities) {
            typeDistribution[entity.type] = (typeDistribution[entity.type] || 0) + 1;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            nodes: entities.map(e => ({
              id: e.id,
              name: e.name,
              type: e.type,
              description: e.description,
              firstLearnedAt: e.firstLearnedAt,
              lastConfirmedAt: e.lastConfirmedAt,
              contradictedAt: e.contradictedAt,
            })),
            edges: entityEdges,
            stats: {
              nodeCount: entities.length,
              edgeCount: entityEdges.length,
              typeDistribution,
            },
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/stats') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const stats = store.getGraphStats(wsHash);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stats));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/code/dependencies') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const edges = store.getFileEdges(wsHash);
          const fileSet = new Set<string>();
          for (const edge of edges) {
            fileSet.add(edge.source_path);
            fileSet.add(edge.target_path);
          }
          const files: Array<{ path: string; centrality: number; clusterId: number | null }> = [];
          for (const fp of fileSet) {
            const centralityInfo = store.getDocumentCentrality(fp);
            files.push({
              path: fp,
              centrality: centralityInfo?.centrality ?? 0,
              clusterId: centralityInfo?.clusterId ?? null,
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            files,
            edges: edges.map(e => ({ source: e.source_path, target: e.target_path })),
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/search') {
        const query = url.searchParams.get('q');
        const limit = parseInt(url.searchParams.get('limit') || '10', 10);
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'query parameter "q" is required' }));
          return;
        }
        // Hard outer deadline: always respond within SEARCH_HARD_DEADLINE_MS.
        // This prevents the HTTP handler from blocking indefinitely when both
        // the FTS worker AND store.searchFTS are blocked by SQLite WAL write locks
        // held by the codebase embedding background process.
        const SEARCH_HARD_DEADLINE_MS = 8000;
        const searchDeadline = new Promise<{ results: import('./types.js').SearchResult[]; timedOut: boolean }>((resolve) => {
          setTimeout(() => resolve({ results: [], timedOut: true }), SEARCH_HARD_DEADLINE_MS);
        });

        const doSearch = async (): Promise<{ results: import('./types.js').SearchResult[]; timedOut: boolean }> => {
          let results: import('./types.js').SearchResult[] = [];
          // Try FTS worker first (read-only connection, should be fast)
          const FTS_WORKER_TIMEOUT_MS = 5000;
          if (isFTSWorkerReady()) {
            try {
              results = await Promise.race([
                searchFTSAsync(query, { limit, projectHash: wsHash }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('__FTS_TIMEOUT__')), FTS_WORKER_TIMEOUT_MS)
                ),
              ]);
              return { results, timedOut: false };
            } catch (ftsErr: any) {
              log('server', `FTS worker timeout/fail: ${ftsErr?.message}`, 'warn');
            }
          }
          // NOTE: Do NOT call store.searchFTS() here — it is synchronous and will block
          // the event loop when SQLite WAL write locks are held by the embedder.
          return { results: [], timedOut: false };
        };

        try {
          const startTime = Date.now();
          const { results, timedOut } = await Promise.race([doSearch(), searchDeadline]);
          const executionMs = Date.now() - startTime;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            results: results.map(r => ({
              id: r.id,
              docid: r.docid,
              title: r.title,
              path: r.path,
              score: r.score,
              snippet: r.snippet,
              collection: r.collection,
            })),
            query,
            executionMs,
            ...(timedOut ? { warning: 'search timed out, try again when indexing completes' } : {}),
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/telemetry') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const telemetryCount = store.getTelemetryCount();
          const banditStats = store.loadBanditStats(wsHash);
          const profile = store.getWorkspaceProfile(wsHash);
          const telemetryStats = store.getTelemetryStats(wsHash);
          const importanceRows = store.getActiveDocumentsWithAccess();
          const accessCounts = importanceRows.map((r) => r.access_count || 0);
          const importanceStats = accessCounts.length > 0
            ? {
                min: Math.min(...accessCounts),
                max: Math.max(...accessCounts),
                mean: accessCounts.reduce((a, b) => a + b, 0) / accessCounts.length,
                median: accessCounts.sort((a, b) => a - b)[Math.floor(accessCounts.length / 2)],
              }
            : { min: 0, max: 0, mean: 0, median: 0 };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            queryCount: telemetryCount,
            banditStats,
            preferenceWeights: profile ? JSON.parse(profile.profile_data || '{}').categoryWeights || {} : {},
            expandRate: telemetryStats.expandCount / Math.max(telemetryStats.queryCount, 1),
            importanceStats,
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/connections') {
        const docId = url.searchParams.get('docId');
        const direction = (url.searchParams.get('direction') || 'both') as 'incoming' | 'outgoing' | 'both';
        if (!docId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'docId parameter is required' }));
          return;
        }
        try {
          const doc = store.findDocument(docId);
          if (!doc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Document not found' }));
            return;
          }
          const connections = store.getConnectionsForDocument(doc.id, { direction });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            connections: connections.map(c => ({
              fromDocId: c.fromDocId,
              toDocId: c.toDocId,
              relationshipType: c.relationshipType,
              strength: c.strength,
              description: c.description,
              createdAt: c.createdAt,
            })),
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/symbols') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        // limit=0 means "no limit" (return all). Default 2000 to keep payload manageable.
        const limitParam = url.searchParams.get('limit');
        const symbolLimit = limitParam === '0' ? Infinity : parseInt(limitParam || '2000', 10);
        // kinds filter: comma-separated list or 'all'. Default excludes noisy 'property' symbols.
        const kindsParam = url.searchParams.get('kinds');
        const excludeKinds = kindsParam === 'all' ? new Set<string>() : new Set(['property']);
        try {
          const allSymbolsRaw = store.getSymbolsForProject(wsHash);
          // Filter out noisy property symbols (e.g. module.exports.x config exports) unless caller opts out
          const allSymbols = excludeKinds.size > 0
            ? allSymbolsRaw.filter((s: { kind: string }) => !excludeKinds.has(s.kind))
            : allSymbolsRaw;
          const allEdges = store.getSymbolEdgesForProject(wsHash);
          const clusters = store.getSymbolClusters(wsHash);
          const total = allSymbols.length;

          // Build edge degree map for sorting
          const edgeDegree = new Map<number, number>();
          for (const e of allEdges) {
            edgeDegree.set(e.sourceId, (edgeDegree.get(e.sourceId) || 0) + 1);
            edgeDegree.set(e.targetId, (edgeDegree.get(e.targetId) || 0) + 1);
          }

          // If we need to trim: prioritize connected symbols first, then exported, then degree.
          let symbols = allSymbols;
          let edges = allEdges;
          if (isFinite(symbolLimit) && allSymbols.length > symbolLimit) {
            symbols = [...allSymbols].sort((a, b) => {
              // 1. Connected symbols (have at least one edge) come first
              const aDeg = edgeDegree.get(a.id) || 0;
              const bDeg = edgeDegree.get(b.id) || 0;
              const aConnected = aDeg > 0 ? 1 : 0;
              const bConnected = bDeg > 0 ? 1 : 0;
              if (bConnected !== aConnected) return bConnected - aConnected;
              // 2. Exported first
              const exportedDiff = (b.exported ? 1 : 0) - (a.exported ? 1 : 0);
              if (exportedDiff !== 0) return exportedDiff;
              // 3. Higher degree first
              return bDeg - aDeg;
            }).slice(0, symbolLimit);
            const keptIds = new Set(symbols.map((s: { id: number }) => s.id));
            edges = allEdges.filter((e: { sourceId: number; targetId: number }) => keptIds.has(e.sourceId) && keptIds.has(e.targetId));
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbols, edges, clusters, total, truncated: total > symbols.length }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/flows') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const flows = store.getFlowsWithSteps(wsHash);
          const flowsWithSteps = flows.map(flow => ({
            ...flow,
            steps: store.getFlowSteps(flow.id),
          }));
          // Merge doc flows from .agents/_flows/*.md
          const docFlows = store.getDocFlows(wsHash);
          const docFlowsMapped = docFlows.map(df => ({
            id: df.id + 100000,
            label: df.label,
            flowType: df.flowType,
            stepCount: 0,
            entryName: null,
            entryFile: df.sourceFile,
            terminalName: null,
            terminalFile: null,
            description: df.description,
            services: df.services,
            lastUpdated: df.lastUpdated,
            steps: [],
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ flows: [...flowsWithSteps, ...docFlowsMapped] }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/connections') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const connections = store.getAllConnections(wsHash);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connections }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/graph/infrastructure') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const symbols = store.getInfrastructureSymbols(wsHash);
          const grouped: Record<string, Array<{
            pattern: string;
            operations: Array<{ op: string; repo: string; file: string; line: number }>;
          }>> = {};
          for (const sym of symbols) {
            if (!grouped[sym.type]) grouped[sym.type] = [];
            let patternEntry = grouped[sym.type].find(p => p.pattern === sym.pattern);
            if (!patternEntry) {
              patternEntry = { pattern: sym.pattern, operations: [] };
              grouped[sym.type].push(patternEntry);
            }
            patternEntry.operations.push({
              op: sym.operation,
              repo: sym.repo,
              file: sym.filePath,
              line: sym.lineNumber,
            });
          }
          // Return only the grouped view (not the raw symbols array which duplicates all data).
          // The grouped view is sufficient for the frontend and is much smaller.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ grouped, total: symbols.length }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/tags') {
        const wsHash = url.searchParams.get('workspace') || currentProjectHash;
        try {
          const tags = store.listAllTags();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tags }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/vsearch') {
        const body = await readBody(req);
        try {
          const { query, limit, workspace } = JSON.parse(body);
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'query is required' }));
            return;
          }
          const safeLimit = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? limit : 10, 100));
          const wsHash = workspace || currentProjectHash;
          // Hard outer deadline to prevent indefinite blocking on WAL write locks
          const VSEARCH_DEADLINE_MS = 8000;
          const deadline = new Promise<import('./types.js').SearchResult[]>((resolve) => {
            setTimeout(() => resolve([]), VSEARCH_DEADLINE_MS);
          });
          const doVsearch = async (): Promise<import('./types.js').SearchResult[]> => {
            if (providers.embedder) {
              try {
                let embedding: number[];
                const cached = store.getQueryEmbeddingCache(query);
                if (cached) {
                  embedding = cached;
                } else {
                  const result = await providers.embedder.embed(query);
                  embedding = result.embedding;
                  store.setQueryEmbeddingCache(query, embedding);
                }
                return await store.searchVecAsync(query, embedding, { limit: safeLimit, projectHash: wsHash });
              } catch {
                // Fall back to FTS if vector search fails
              }
            }
            // NOTE: Do NOT call store.searchFTS() here — synchronous, blocks event loop
            return [];
          };
          const results = await Promise.race([doVsearch(), deadline]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
        return;
      }

      if (pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (req.method === 'GET' || (req.method === 'POST' && !sessionId)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
          });
          const clientServer = createMcpServer(deps);

          await clientServer.connect(transport);
          await transport.handleRequest(req, res);

          if (transport.sessionId) {
            streamableSessions.set(transport.sessionId, { transport, server: clientServer });
            log('server', `Streamable HTTP client connected sessionId=${transport.sessionId}`);

            transport.onclose = () => {
              if (transport.sessionId) {
                streamableSessions.delete(transport.sessionId);
                log('server', `Streamable HTTP client disconnected sessionId=${transport.sessionId}`);
              }
            };
          }
          return;
        }

        if (sessionId) {
          const session = streamableSessions.get(sessionId);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
          }

          await session.transport.handleRequest(req, res);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log('server', `nano-brain already running on port ${httpPort}`, 'error');
        process.exit(0);
      }
      throw err;
    });

    httpServer.listen(httpPort, httpHost, () => {
      log('server', `MCP server listening on http://${httpHost}:${httpPort}`);
      log('server', `SSE endpoint: GET /sse, POST /messages?sessionId=<id>`);
      log('server', `Streamable HTTP endpoint: /mcp`);
    });
  } else {
    // Suppress stdout/stderr log writes — they would corrupt the JSON-RPC stream
    setStdioMode(true);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('server', 'MCP server started on stdio');
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
        log('server', 'Embedding provider initialized model=' + store.modelStatus.embedding);
        log('server', `Embedding model: ${store.modelStatus.embedding}`);
        startFileWatcher();
      })
      .catch((err) => {
        store.modelStatus.embedding = 'failed';
        log('server', 'Embedding provider failed error=' + (err instanceof Error ? err.message : String(err)));
        log('server', `Embedding model failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
        log('server', 'Reranker initialized model=' + store.modelStatus.reranker);
        log('server', `Reranker model: ${store.modelStatus.reranker}`);
      })
      .catch((err) => {
        store.modelStatus.reranker = 'failed';
        log('server', 'Reranker failed error=' + (err instanceof Error ? err.message : String(err)));
        log('server', `Reranker model failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }),
  ]).then(() => {
    readyState.value = true;
    log('server', 'Server ready (Phase 2 complete)');
    log('server', 'Server ready');

    if (config?.consolidation?.enabled) {
      const consolidationConfig = config.consolidation as import('./types.js').ConsolidationConfig;
      const llmProvider = createLLMProvider(consolidationConfig);
      if (llmProvider) {
        consolidationWorker = new ConsolidationWorker({
          store,
          llmProvider,
          pollingIntervalMs: consolidationConfig.interval_ms ?? 5000,
          maxCandidates: consolidationConfig.max_memories_per_cycle ?? 5,
        });
        consolidationWorker.start();
        log('server', 'Consolidation worker started');

        providers.expander = createLLMQueryExpander(llmProvider);
        store.modelStatus.expander = 'llm:' + (llmProvider.model ?? 'unknown');
        log('server', 'Query expander enabled with LLM');
      } else {
        log('server', 'Consolidation enabled but no LLM provider configured');
        log('server', 'Consolidation enabled but no LLM provider configured', 'warn');
      }
    }
  });

  // Ollama reconnect — retry if fell back to local GGUF at startup
  const embeddingConfig = config?.embedding;
  if (!embeddingConfig || embeddingConfig.provider !== 'local') {
    const ollamaUrl = embeddingConfig?.url || detectOllamaUrl();
    const ollamaModel = embeddingConfig?.model || 'mxbai-embed-large';
    let startedWithLocalGGUF = false;

    // Check after initial provider loads whether we're using local GGUF
    setTimeout(() => {
      // Local GGUF model is 'nomic-embed-text-v1.5', Ollama is 'nomic-embed-text'
      if (store.modelStatus.embedding === 'nomic-embed-text-v1.5') {
        startedWithLocalGGUF = true;
      }
    }, 5000);

    const reconnectTimer = setInterval(async () => {
      if (!startedWithLocalGGUF) {
        clearInterval(reconnectTimer);
        return;
      }
      // Already reconnected?
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
            log('server', 'Reconnected to Ollama url=' + ollamaUrl + ' model=' + ollamaModel);
            log('server', `Reconnected to Ollama at ${ollamaUrl} — switched from local GGUF`);
            startedWithLocalGGUF = false;
            clearInterval(reconnectTimer);
          }
        }
      } catch {
        // Silent retry — don't spam logs
      }
    }, 60000);

    // Don't prevent process exit
    reconnectTimer.unref();
  }

  if (!resolvedCodebaseConfig?.enabled) {
    startFileWatcher();
  }
}
