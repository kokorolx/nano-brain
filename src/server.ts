import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Store, SearchResult, IndexHealth, Collection, StorageConfig, CodebaseConfig, EmbeddingConfig, WatcherConfig, SearchConfig } from './types.js'
import type { SearchProviders } from './search.js';
import { hybridSearch, parseSearchConfig } from './search.js';
import { findCycles } from './graph.js';
import { createStore, extractProjectHashFromPath } from './store.js';
import { log, initLogger } from './logger.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles, getWorkspaceConfig } from './collections.js';
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
  searchConfig?: SearchConfig
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
  
  server.tool(
    'memory_search',
    'BM25 full-text keyword search across indexed documents',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(10).describe('Max results'),
      collection: z.string().optional().describe('Filter by collection name'),
      workspace: z.string().optional().describe('Filter by workspace hash. Omit for current workspace, "all" for cross-workspace search'),
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
    },
    async ({ query, limit, collection, workspace, tags, since, until }) => {
      log('mcp', 'memory_search query="' + query + '" limit=' + limit);
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
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
    },
    async ({ query, limit, collection, workspace, tags, since, until }) => {
      log('mcp', 'memory_vsearch query="' + query + '" limit=' + limit);
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
          const results = store.searchVec(query, embedding, searchOpts);
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
      tags: z.string().optional().describe('Comma-separated tags to filter by (AND logic)'),
      since: z.string().optional().describe('Filter documents modified on or after this date (ISO format)'),
      until: z.string().optional().describe('Filter documents modified on or before this date (ISO format)'),
    },
    async ({ query, limit, collection, minScore, workspace, tags, since, until }) => {
      log('mcp', 'memory_query query="' + query + '" limit=' + limit);
      const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || currentProjectHash);
      const parsedTags = tags ? tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : undefined;
      const results = await hybridSearch(
        store,
        { query, limit, collection, minScore, projectHash: effectiveWorkspace, tags: parsedTags, since, until, searchConfig: deps.searchConfig },
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
    },
    async ({ content, supersedes, tags }) => {
      log('mcp', 'memory_write content_length=' + content.length);
      const date = new Date().toISOString().split('T')[0];
      const memoryDir = path.join(outputDir, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const targetPath = path.join(memoryDir, `${date}.md`);
      const timestamp = new Date().toISOString();
      const workspaceName = path.basename(workspaceRoot);
      const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${currentProjectHash})\n\n${content}\n`;
      
      fs.appendFileSync(targetPath, entry, 'utf-8');
      
      let supersedeWarning = '';
      if (supersedes) {
        const targetDoc = store.findDocument(supersedes);
        if (targetDoc) {
          store.supersedeDocument(targetDoc.id, 0);
        } else {
          supersedeWarning = `\n⚠️ Supersede target not found: ${supersedes}`;
        }
      }
      
      let tagInfo = '';
      if (tags) {
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
        const parsedTags = tags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
        if (parsedTags.length > 0) {
          store.insertTags(docId, parsedTags);
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
      const codebaseStats = getCodebaseStats(store, deps.codebaseConfig, effectiveRoot)
      // Probe embedding server connectivity
      const embeddingConfig = deps.embeddingConfig
      const ollamaUrl = embeddingConfig?.url || detectOllamaUrl()
      const ollamaModel = embeddingConfig?.model || 'mxbai-embed-large'
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
      log('mcp', 'memory_index_codebase root="' + (root || '') + '"');
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
            const embedded = await embedPendingCodebase(store, providers.embedder, 50, effectiveProjectHash)
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
      const dependencies = store.getFileDependencies(filePath, currentProjectHash);
      const dependents = store.getFileDependents(filePath, currentProjectHash);
      const centralityInfo = store.getDocumentCentrality(filePath);
      
      const lines: string[] = [];
      lines.push(`**File:** ${filePath}`);
      lines.push('');
      
      if (centralityInfo) {
        lines.push(`**Centrality:** ${centralityInfo.centrality.toFixed(4)}`);
        if (centralityInfo.clusterId !== null) {
          const clusterMembers = store.getClusterMembers(centralityInfo.clusterId, currentProjectHash);
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
      for (const dep of dependencies) {
        lines.push(`  → ${dep}`);
      }
      lines.push('');
      
      lines.push(`**Dependents (imported by):** ${dependents.length}`);
      for (const dep of dependents) {
        lines.push(`  ← ${dep}`);
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
    'memory_graph_stats',
    'Get statistics about the file dependency graph',
    {},
    async () => {
      log('mcp', 'memory_graph_stats');
      const stats = store.getGraphStats(currentProjectHash);
      const edges = store.getFileEdges(currentProjectHash);
      const cycles = findCycles(edges.map(e => ({ source: e.source_path, target: e.target_path })), 5);
      
      const lines: string[] = [];
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
    'memory_symbols',
    'Query cross-repo symbols (Redis keys, PubSub channels, MySQL tables, API endpoints, HTTP calls, Bull queues)',
    {
      type: z.string().optional().describe('Symbol type: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue'),
      pattern: z.string().optional().describe('Glob pattern to match (e.g., "sinv:*" matches "sinv:*:compressed")'),
      repo: z.string().optional().describe('Filter by repository name'),
      operation: z.string().optional().describe('Filter by operation: read, write, publish, subscribe, define, call, produce, consume'),
    },
    async ({ type, pattern, repo, operation }) => {
      log('mcp', 'memory_symbols type="' + (type || '') + '" pattern="' + (pattern || '') + '"');
      const results = store.querySymbols({
        type,
        pattern,
        repo,
        operation,
        projectHash: currentProjectHash,
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

      for (const [key, items] of grouped) {
        const [symbolType, symbolPattern] = key.split(':');
        lines.push(`### ${symbolType}: \`${symbolPattern}\``);
        for (const item of items) {
          lines.push(`  - [${item.operation}] ${item.repo}: ${item.filePath}:${item.lineNumber}`);
        }
        lines.push('');
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
    'memory_impact',
    'Analyze cross-repo impact of a symbol (writers vs readers, publishers vs subscribers)',
    {
      type: z.string().describe('Symbol type: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue'),
      pattern: z.string().describe('Pattern to analyze (e.g., "sinv:*:compressed")'),
    },
    async ({ type, pattern }) => {
      log('mcp', 'memory_impact type="' + type + '" pattern="' + pattern + '"');
      const results = store.getSymbolImpact(type, pattern, currentProjectHash);

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

      for (const [op, items] of byOperation) {
        const label = operationLabels[op] || op;
        lines.push(`### ${label} (${items.length})`);
        for (const item of items) {
          lines.push(`  - ${item.repo}: ${item.filePath}:${item.lineNumber}`);
        }
        lines.push('');
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
  const { dbPath, configPath, httpPort, daemon } = options;
  
  const homeDir = os.homedir();
  const nanoBrainHome = path.join(homeDir, '.nano-brain');
  const outputDir = nanoBrainHome;
  const pidPath = path.join(nanoBrainHome, 'mcp.pid');
  
  // PID file path — singleton guard set up after server starts
  const finalConfigPath = configPath || path.join(outputDir, 'collections.yaml');
  const config = loadCollectionConfig(finalConfigPath);
  initLogger(config ?? undefined);
  const collections = config ? getCollections(config) : [];
  const storageConfig = parseStorageConfig(config?.storage);
  const resolvedWorkspaceRoot = process.cwd();
  const wsConfig = getWorkspaceConfig(config, resolvedWorkspaceRoot);
  const resolvedCodebaseConfig = wsConfig.codebase;
  const currentProjectHash = crypto.createHash('sha256').update(resolvedWorkspaceRoot).digest('hex').substring(0, 12);
  // Use per-workspace database: {dirName}-{hash}.sqlite instead of default.sqlite
  const isDefaultDb = dbPath.endsWith('/default.sqlite') || dbPath.endsWith('\\default.sqlite');
  const workspaceDirName = path.basename(resolvedWorkspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
  const effectiveDbPath = isDefaultDb ? path.join(path.dirname(dbPath), `${workspaceDirName}-${currentProjectHash}.sqlite`) : dbPath;
  log('server', 'Workspace path=' + resolvedWorkspaceRoot + ' hash=' + currentProjectHash);
  console.error(`[memory] Workspace: ${resolvedWorkspaceRoot} (${currentProjectHash})`);
  log('server', 'Database path=' + effectiveDbPath);
  console.error(`[memory] Database: ${effectiveDbPath}`);
  log('server', 'Config path=' + finalConfigPath);
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
    codebaseConfig: resolvedCodebaseConfig,
    embeddingConfig: config?.embedding,
    workspaceRoot: resolvedWorkspaceRoot,
    searchConfig: parseSearchConfig(config?.search),
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
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  
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
  
  // Singleton guard: write PID, kill old process, monitor for newer instances
  log('server', 'Setting up singleton guard pid=' + process.pid);
  setupSingletonGuard(pidPath, store, () => { if (watcher) watcher.stop(); });
  
  Promise.all([
    createEmbeddingProvider({ embeddingConfig: config?.embedding })
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
    createReranker()
      .then((loadedReranker) => {
        providers.reranker = loadedReranker;
        store.modelStatus.reranker = loadedReranker ? 'bge-reranker-v2-m3' : 'missing';
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
          const newProvider = await createEmbeddingProvider({ embeddingConfig: { provider: 'ollama', url: ollamaUrl, model: ollamaModel } });
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
