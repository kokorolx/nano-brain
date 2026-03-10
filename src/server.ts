import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Store, SearchResult, IndexHealth, Collection, StorageConfig, CodebaseConfig, EmbeddingConfig, WatcherConfig, SearchConfig } from './types.js'
import type { SearchProviders } from './search.js';
import { hybridSearch, parseSearchConfig } from './search.js';
import { findCycles } from './graph.js';
import { createStore, extractProjectHashFromPath, resolveWorkspaceDbPath, openWorkspaceStore, setProjectLabelDataDir, resolveProjectLabel } from './store.js';
import { log, initLogger } from './logger.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles, getWorkspaceConfig } from './collections.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth, checkOpenAIHealth } from './embeddings.js';
import { createReranker } from './reranker.js';
import { startWatcher } from './watcher.js';
import { parseStorageConfig } from './storage.js';
import { indexCodebase, getCodebaseStats, embedPendingCodebase } from './codebase.js'
import { createVectorStore, type VectorStore, type VectorStoreHealth } from './vector-store.js'
import Database from 'better-sqlite3'
import { SymbolGraph, type ContextResult, type ImpactResult, type DetectChangesResult } from './symbol-graph.js'
import { ResultCache } from './cache.js'

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
        const wsStore = openWorkspaceStore(deps.dataDir, wsPath);
        if (wsStore) {
          return { store: wsStore, workspaceRoot: wsPath, projectHash: wsHash, needsClose: true };
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
      const wsStore = openWorkspaceStore(deps.dataDir, bestMatch.wsPath);
      if (wsStore) {
        return { store: wsStore, workspaceRoot: bestMatch.wsPath, projectHash: wsHash, needsClose: true };
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
    let db = deps.db
    if (resolved.needsClose && deps.dataDir && resolved.workspaceRoot) {
      const dbPath = resolveWorkspaceDbPath(deps.dataDir, resolved.workspaceRoot)
      db = new Database(dbPath)
    }
    return {
      projectHash: resolved.projectHash,
      workspaceRoot: resolved.workspaceRoot,
      db,
      store: resolved.store,
      needsClose: resolved.needsClose,
    }
  }

  if (workspace) {
    return { error: `Workspace not found: ${workspace}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
  }

  return { error: `Could not resolve workspace from file_path: ${filePath}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }
  
  return results.map((r, i) => {
    let output = `### ${i + 1}. ${r.title} (${r.docid})\n` +
      `**Path:** ${r.path} | **Score:** ${r.score.toFixed(3)} | **Lines:** ${r.startLine}-${r.endLine}\n`;
    
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

export function formatCompactResults(results: SearchResult[], cacheKey: string): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const header = `🔑 ${cacheKey} | Use memory_expand(cacheKey, index) for full content | compact:false for verbose`;
  
  const lines = results.map((r, i) => {
    const score = r.score.toFixed(3);
    const title = r.title.replace(/[|—]/g, '-');
    const symbols = r.symbols && r.symbols.length > 0 ? ` [${r.symbols.join(', ')}]` : '';
    const firstLine = r.snippet.split('\n')[0] || '';
    const truncated = firstLine.length > 80 ? firstLine.substring(0, 80) + '…' : firstLine;
    return `${i + 1}. [${score}] ${title} (${r.docid}) — ${r.path}:${r.startLine}${symbols} | ${truncated}`;
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
  return lines.join('\n')
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { store, providers, collections, configPath, outputDir, currentProjectHash, workspaceRoot } = deps;
  
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
      compact: z.boolean().optional().default(false).describe('Return compact single-line results with caching. Defaults to verbose.'),
    },
    async ({ query, limit, collection, workspace, tags, since, until, compact }) => {
      log('mcp', 'memory_search query="' + query + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return {
          content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }],
          isError: true,
        }
      }
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const results = store.searchFTS(query, {
        limit,
        collection,
        projectHash: effectiveWorkspace,
        tags: parsedTags,
        since,
        until,
      });
      if (compact) {
        const cacheKey = resultCache.set(results, query);
        return {
          content: [{ type: 'text', text: formatCompactResults(results, cacheKey) }],
        };
      }
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
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
      compact: z.boolean().optional().default(false).describe('Return compact single-line results with caching. Defaults to verbose.'),
    },
    async ({ query, limit, collection, workspace, tags, since, until, compact }) => {
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
          const results = await store.searchVecAsync(query, embedding, searchOpts);
          if (compact) {
            const cacheKey = resultCache.set(results, query);
            return { content: [{ type: 'text', text: formatCompactResults(results, cacheKey) }] };
          }
          return {
            content: [
              {
                type: 'text',
                text: formatSearchResults(results),
              },
            ],
          };
        } catch (err) {
          const fallbackResults = store.searchFTS(query, searchOpts);
          if (compact) {
            const cacheKey = resultCache.set(fallbackResults, query);
            return { content: [{ type: 'text', text: `⚠️  Vector search failed, falling back to FTS: ${err instanceof Error ? err.message : String(err)}\n\n${formatCompactResults(fallbackResults, cacheKey)}` }] };
          }
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
        const fallbackResults = store.searchFTS(query, searchOpts);
        if (compact) {
          const cacheKey = resultCache.set(fallbackResults, query);
          return { content: [{ type: 'text', text: `⚠️  Embedder not available, falling back to FTS\n\n${formatCompactResults(fallbackResults, cacheKey)}` }] };
        }
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
      workspace: z.string().optional().describe('Workspace path, hash, or "all". Required in daemon mode.'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
      compact: z.boolean().optional().default(false).describe('Return compact single-line results with caching. Defaults to verbose.'),
    },
    async ({ query, limit, collection, minScore, workspace, tags, since, until, compact }) => {
      log('mcp', 'memory_query query="' + query + '" limit=' + limit);
      if (deps.daemon && !workspace) {
        return {
          content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }],
          isError: true,
        }
      }
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const results = await hybridSearch(
        store,
        { query, limit, collection, minScore, projectHash: effectiveWorkspace, tags: parsedTags, since, until, searchConfig: deps.searchConfig, db: deps.db },
        providers
      );
      
      if (compact) {
        const cacheKey = resultCache.set(results, query);
        return {
          content: [{ type: 'text', text: formatCompactResults(results, cacheKey) }],
        };
      }
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
    'memory_expand',
    'Expand a compact search result to see full content',
    {
      cacheKey: z.string().describe('Cache key from compact search response'),
      index: z.number().optional().describe('1-based result index to expand'),
      indices: z.array(z.number()).optional().describe('Array of 1-based indices to expand multiple results'),
      docid: z.string().optional().describe('Document ID fallback if cache expired'),
    },
    async ({ cacheKey, index, indices, docid }) => {
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
      log('mcp', 'memory_write content_length=' + content.length);
      
      const wsResult = requireDaemonWorkspace(deps, workspace)
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true }
      }
      
      const effectiveProjectHash = wsResult.projectHash
      const effectiveWorkspaceRoot = wsResult.workspaceRoot
      const effectiveStore = wsResult.store
      
      try {
        const date = new Date().toISOString().split('T')[0];
        const memoryDir = path.join(outputDir, 'memory');
        fs.mkdirSync(memoryDir, { recursive: true });
        const targetPath = path.join(memoryDir, `${date}.md`);
        const timestamp = new Date().toISOString();
        const workspaceName = path.basename(effectiveWorkspaceRoot);
        const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${effectiveProjectHash})\n\n${content}\n`;
        
        fs.appendFileSync(targetPath, entry, 'utf-8');
        
        let supersedeWarning = '';
        if (supersedes) {
          const targetDoc = effectiveStore.findDocument(supersedes);
          if (targetDoc) {
            effectiveStore.supersedeDocument(targetDoc.id, 0);
          } else {
            supersedeWarning = `\n⚠️ Supersede target not found: ${supersedes}`;
          }
        }
        
        let tagInfo = '';
        if (tags) {
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
          const parsedTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
          if (parsedTags.length > 0) {
            effectiveStore.insertTags(docId, parsedTags);
            tagInfo = `\n📌 Tags: ${parsedTags.join(', ')}`;
          }
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Written to ${targetPath} [${workspaceName}]${supersedeWarning}${tagInfo}`,
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
    'memory_tags',
    'List all tags with document counts',
    {},
    async () => {
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
                  const wsDb = new Database(wsDbPath);
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

      return {
        content: [
          {
            type: 'text',
            text: formatStatus(health, codebaseStats, embeddingHealth, vectorHealth, tokenUsage.length > 0 ? tokenUsage : null) + workspaceStatsText,
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
      if (resolved?.needsClose && deps.dataDir && resolved.workspaceRoot) {
        const wsDbPath = resolveWorkspaceDbPath(deps.dataDir, resolved.workspaceRoot);
        symbolGraphDb = new Database(wsDbPath);
        symbolGraphDbNeedsClose = true;
      }
      
      console.error(`[codebase-debug] symbolGraphDb=${symbolGraphDbNeedsClose ? 'workspace-specific' : 'startup'} root=${effectiveRoot} hash=${effectiveProjectHash}`)
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
          console.error(`[codebase] Indexing complete: ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkippedUnchanged} unchanged`)
          if (providers.embedder) {
            const embedded = await embedPendingCodebase(storeToUse, providers.embedder, 50, effectiveProjectHash)
            console.error(`[codebase] Embedding complete: ${embedded} chunks embedded`)
          }
        } catch (err) {
          console.error(`[codebase] Indexing failed:`, err)
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
      max_depth: z.number().optional().describe('Maximum traversal depth (default: 5)'),
      min_confidence: z.number().optional().describe('Minimum edge confidence (0-1, default: 0)'),
      file_path: z.string().optional().describe('File path to disambiguate common names'),
      workspace: z.string().optional().describe('Workspace path or hash. Required in daemon mode.'),
    },
    async ({ target, direction, max_depth, min_confidence, file_path, workspace }) => {
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
        const maxDepth = 3;
        const maxEntries = 50;
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

/**
 * Singleton guard using PID file.
 * 1. Read old PID from file (if exists)
 * 2. Write our PID immediately
 * 3. After delay, kill the old PID if it's still alive
 * 4. Periodically check if someone overwrote our PID — if so, exit
 */
function setupSingletonGuard(pidPath: string, store: Store, stopWatcher: () => void): void {
  // Read previous PID before overwriting
  let oldPid: number | null = null;
  try {
    const pidStr = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && pid !== process.pid) oldPid = pid;
  } catch { /* no previous PID file */ }
  
  // Write our PID
  writePidFile(pidPath);
  
  // After startup settles, kill the old process
  if (oldPid) {
    setTimeout(() => {
      try {
        process.kill(oldPid!, 0); // Still alive?
        log('server', 'Killing previous nano-brain process PID=' + oldPid);
        console.error(`[memory] Killing previous nano-brain process (PID ${oldPid})`);
        process.kill(oldPid!, 'SIGTERM');
      } catch { /* already dead */ }
    }, 2000);
  }
  
  // Periodically check if a newer instance took over
  const ownerCheck = setInterval(() => {
    try {
      const currentPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (currentPid !== process.pid) {
        log('server', 'Newer instance detected PID=' + currentPid + ', shutting down');
        console.error(`[memory] Newer instance detected (PID ${currentPid}), shutting down`);
        clearInterval(ownerCheck);
        stopWatcher();
        store.close();
        process.exit(0);
      }
    } catch { /* PID file gone — continue running */ }
  }, 5000);
  ownerCheck.unref();
}

export async function startServer(options: ServerOptions): Promise<void> {
  const { dbPath, configPath, httpPort, httpHost = '127.0.0.1', daemon, root } = options;
  
  const homeDir = os.homedir();
  const nanoBrainHome = path.join(homeDir, '.nano-brain');
  const outputDir = nanoBrainHome;
  // Use separate PID files: serve.pid for daemon mode, mcp.pid for local stdio mode
  // This prevents the serve daemon and local MCP instances from killing each other
  const pidPath = path.join(nanoBrainHome, daemon ? 'serve.pid' : 'mcp.pid');
  const finalConfigPath = configPath || path.join(outputDir, 'collections.yaml');
  const config = loadCollectionConfig(finalConfigPath);
  initLogger(config ?? undefined);
  const collections = config ? getCollections(config) : [];
  const storageConfig = parseStorageConfig(config?.storage);
  let resolvedWorkspaceRoot: string;
  if (daemon && config?.workspaces && Object.keys(config.workspaces).length > 0) {
    const configuredWorkspaces = Object.keys(config.workspaces);
    const cwd = root || process.cwd();
    const cwdMatch = configuredWorkspaces.find(ws => cwd === ws || cwd.startsWith(ws + '/'));
    if (cwdMatch) {
      resolvedWorkspaceRoot = cwdMatch;
      log('server', 'Daemon mode: cwd matches configured workspace');
      console.error(`[memory] Daemon mode: workspace from cwd = ${resolvedWorkspaceRoot}`);
    } else {
      resolvedWorkspaceRoot = configuredWorkspaces[0];
      log('server', 'Daemon mode: cwd does not match any workspace, using first configured');
      console.error(`[memory] Daemon mode: primary workspace = ${resolvedWorkspaceRoot}`);
    }
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
  console.error(`[memory] Workspace: ${resolvedWorkspaceRoot} (${currentProjectHash})`);
  log('server', 'Database path=' + effectiveDbPath);
  console.error(`[memory] Database: ${effectiveDbPath}`);
  log('server', 'Config path=' + finalConfigPath);
  const store = createStore(effectiveDbPath);
  const symbolGraphDb = new Database(effectiveDbPath);
  
  const validateInterval = (value: number | undefined, name: string, defaultVal: number): number => {
    if (value === undefined) return defaultVal;
    if (value <= 0 || value > 3600) {
      console.error(`[memory] Warning: intervals.${name}=${value} invalid (must be 1-3600), using default ${defaultVal}`);
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
        console.error(`[memory] Vector store: ${health.provider} (ok=${health.ok}, vectors=${health.vectorCount})`);
        if (health.dimensions && configuredDimensions && health.dimensions !== configuredDimensions) {
          console.error(`[memory] FATAL: Vector dimension mismatch! Configured=${configuredDimensions}, Qdrant collection=${health.dimensions}`);
          console.error(`[memory] Either update config.yml vector.dimensions or recreate the Qdrant collection.`);
          process.exit(1);
        }
      }).catch((err) => {
        log('server', 'vector health check failed error=' + (err instanceof Error ? err.message : String(err)));
        console.error(`[memory] Vector store health check failed:`, err);
      });
    } catch (err) {
      log('server', 'vector store creation failed error=' + (err instanceof Error ? err.message : String(err)));
      console.error(`[memory] Vector store creation failed:`, err);
    }
  } else {
    log('server', 'vector provider=sqlite-vec (default)');
    console.error(`[memory] Vector store: sqlite-vec (default)`);
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
  };
  
  const server = createMcpServer(deps);
  
  let watcher: ReturnType<typeof startWatcher> | null = null;
  const startFileWatcher = () => {
    if (watcher) {
      return;
    }
    log('server', 'Starting file watcher');
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
      sessionStorageDir: path.join(homeDir, '.local/share/opencode/storage'),
      outputDir: path.join(outputDir, 'sessions'),
      storageConfig,
      dbPath,
      allWorkspaces: config?.workspaces,
      dataDir: path.dirname(effectiveDbPath),
      onUpdate: (filePath) => {
        if (!daemon) {
          console.error(`[watcher] File changed: ${filePath}`);
        }
      },
      codebaseConfig: resolvedCodebaseConfig,
      workspaceRoot: resolvedWorkspaceRoot,
      projectHash: currentProjectHash,
    });
  };
  
  // Cleanup on exit (all modes, not just daemon)
  const cleanup = () => {
    log('server', 'Shutting down');
    if (watcher) watcher.stop();
    // Only remove PID file if it's still ours
    try {
      const currentPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (currentPid === process.pid) removePidFile(pidPath);
    } catch { }
    symbolGraphDb.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  
  if (httpPort) {
    const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
    const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/health') {
        let version = 'unknown';
        try {
          const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
          version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version, uptime: process.uptime(), sessions: { sse: sseSessions.size, streamable: streamableSessions.size } }));
        return;
      }

      if (req.method === 'GET' && pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        const clientServer = createMcpServer(deps);
        
        sseSessions.set(transport.sessionId, { transport, server: clientServer });
        log('server', `SSE client connected sessionId=${transport.sessionId}`);
        
        transport.onclose = () => {
          sseSessions.delete(transport.sessionId);
          log('server', `SSE client disconnected sessionId=${transport.sessionId}`);
        };
        
        await clientServer.connect(transport);
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

      if (pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        
        if (req.method === 'GET' || (req.method === 'POST' && !sessionId)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
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
    
    httpServer.listen(httpPort, httpHost, () => {
      console.error(`MCP server listening on http://${httpHost}:${httpPort}`);
      console.error(`  SSE endpoint: GET /sse, POST /messages?sessionId=<id>`);
      console.error(`  Streamable HTTP endpoint: /mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server started on stdio');
  }
  
  // Singleton guard: write PID, kill old process, monitor for newer instances
  log('server', 'Setting up singleton guard pid=' + process.pid);
  setupSingletonGuard(pidPath, store, () => { if (watcher) watcher.stop(); });
  
  Promise.all([
    createEmbeddingProvider({ embeddingConfig: config?.embedding, onTokenUsage: (model, tokens) => store.recordTokenUsage(model, tokens) })
      .then((loadedEmbedder) => {
        providers.embedder = loadedEmbedder;
        store.modelStatus.embedding = loadedEmbedder ? loadedEmbedder.getModel() : 'missing';
        if (loadedEmbedder) {
          store.ensureVecTable(loadedEmbedder.getDimensions());
        }
        log('server', 'Embedding provider initialized model=' + store.modelStatus.embedding);
        console.error(`[memory] Embedding model: ${store.modelStatus.embedding}`);
        startFileWatcher();
      })
      .catch((err) => {
        store.modelStatus.embedding = 'failed';
        log('server', 'Embedding provider failed error=' + (err instanceof Error ? err.message : String(err)));
        console.error('[memory] Embedding model failed:', err);
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
        console.error(`[memory] Reranker model: ${store.modelStatus.reranker}`);
      })
      .catch((err) => {
        store.modelStatus.reranker = 'failed';
        log('server', 'Reranker failed error=' + (err instanceof Error ? err.message : String(err)));
        console.error('[memory] Reranker model failed:', err);
      }),
  ]);

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
            console.error(`[memory] Reconnected to Ollama at ${ollamaUrl} — switched from local GGUF`);
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
