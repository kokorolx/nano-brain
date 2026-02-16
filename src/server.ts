import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import type { Store, SearchResult, IndexHealth, Collection } from './types.js';
import type { SearchProviders } from './search.js';
import { hybridSearch } from './search.js';
import { createStore } from './store.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles } from './collections.js';

export interface ServerOptions {
  dbPath: string;
  configPath?: string;
  httpPort?: number;
  daemon?: boolean;
}

export interface ServerDeps {
  store: Store;
  providers: SearchProviders;
  collections: Collection[];
  configPath: string;
  outputDir: string;
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

export function formatStatus(health: IndexHealth): string {
  return [
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
  ].join('\n');
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { store, providers, collections, configPath, outputDir } = deps;
  
  const server = new McpServer(
    {
      name: 'opencode-memory',
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
    },
    async ({ query, limit, collection }) => {
      const results = store.searchFTS(query, limit, collection);
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
    },
    async ({ query, limit, collection }) => {
      if (providers.embedder) {
        try {
          const { embedding } = await providers.embedder.embed(query);
          const results = store.searchVec(query, embedding, limit, collection);
          return {
            content: [
              {
                type: 'text',
                text: formatSearchResults(results),
              },
            ],
          };
        } catch (err) {
          const fallbackResults = store.searchFTS(query, limit, collection);
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
        const fallbackResults = store.searchFTS(query, limit, collection);
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
    },
    async ({ query, limit, collection, minScore }) => {
      const results = await hybridSearch(
        store,
        { query, limit, collection, minScore },
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
    {},
    async () => {
      const health = store.getIndexHealth();
      return {
        content: [
          {
            type: 'text',
            text: formatStatus(health),
          },
        ],
      };
    }
  );
  
  server.tool(
    'memory_update',
    'Trigger immediate reindex of all collections',
    {},
    async () => {
      let totalAdded = 0;
      let totalUpdated = 0;
      
      // Reload config to pick up newly added collections
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
  const outputDir = path.join(homeDir, '.opencode-memory');
  const cacheDir = path.join(homeDir, '.cache', 'opencode-memory');
  const pidPath = path.join(cacheDir, 'mcp.pid');
  
  if (daemon) {
    checkStalePid(pidPath);
    writePidFile(pidPath);
    
    const cleanup = () => {
      removePidFile(pidPath);
      store.close();
      process.exit(0);
    };
    
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  }
  
  const store = createStore(dbPath);
  
  const finalConfigPath = configPath || path.join(outputDir, 'collections.yaml');
  const config = loadCollectionConfig(finalConfigPath);
  const collections = config ? getCollections(config) : [];
  
  const providers: SearchProviders = {
    embedder: null,
    reranker: null,
    expander: null,
  };
  
  const deps: ServerDeps = {
    store,
    providers,
    collections,
    configPath: finalConfigPath,
    outputDir,
  };
  
  const server = createMcpServer(deps);
  
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
}
