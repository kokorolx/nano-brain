import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './types.js';
import { log } from '../../logger.js';
import { formatSearchResults, formatCompactResults, attachTagsToResults, requireDaemonWorkspace, formatAvailableWorkspaces, sequentialFileAppend } from '../../server/utils.js';
import { hybridSearch } from '../../search.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles } from '../../collections.js';
import { extractProjectHashFromPath } from '../../store.js';
import { categorize } from '../../categorizer.js';
import { categorizeMemory } from '../../llm-categorizer.js';
import { parseCategorizationConfig, DEFAULT_PROACTIVE_CONFIG } from '../../types.js';
import type { ProactiveConfig, ConsolidationConfig } from '../../types.js';
import { createLLMProvider } from '../../llm-provider.js';
import { extractEntitiesFromMemory } from '../../entity-extraction.js';
import { ConsolidationAgent } from '../../consolidation.js';
import { generateBriefing } from '../../wake-up.js';
import { detectReformulation } from '../../telemetry.js';

const WARMUP_ERROR = { isError: true, content: [{ type: 'text' as const, text: 'Server warming up, try again in a few seconds' }] };

export function registerMemoryTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, resultCache, checkReady, prependWarning, currentProjectHash, store, providers } = ctx;

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
        const memoryDir = path.join(deps.outputDir, 'memory');
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
                  effectiveStore.insertOrUpdateEntity({
                    name: entity.name,
                    type: entity.type as 'tool' | 'service' | 'person' | 'concept' | 'decision' | 'file' | 'library',
                    description: entity.description,
                    projectHash: capturedProjectHash,
                    firstLearnedAt: new Date().toISOString(),
                    lastConfirmedAt: new Date().toISOString(),
                  });
                }

                for (const rel of extractionResult.relationships) {
                  const sourceEntity = effectiveStore.getEntityByName(rel.sourceName, undefined, capturedProjectHash);
                  const targetEntity = effectiveStore.getEntityByName(rel.targetName, undefined, capturedProjectHash);
                  if (sourceEntity && targetEntity) {
                    effectiveStore.insertEdge({
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
            const capturedWsResult = wsResult;
            asyncCategorizationPending = true;
            categorizeMemory(content, llmProviderForCategorization, categorizationConfig).then(llmTags => {
              if (llmTags.length > 0) {
                tagStore.insertTags(capturedDocId, llmTags);
                log('mcp', 'LLM categorization complete: ' + llmTags.join(', '));
              }
            }).catch(err => {
              log('mcp', 'LLM categorization failed: ' + (err instanceof Error ? err.message : String(err)));
            }).finally(() => {
              if (capturedWsResult.needsClose) {
                try { capturedWsResult.store.close(); } catch {}
              }
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
          wsResult.store.close();
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
      const { formatStatus } = await import('../../server/utils.js');
      const { getCodebaseStats } = await import('../../codebase.js');
      const { openWorkspaceStore, resolveWorkspaceDbPath, openDatabase } = await import('../../store.js');
      const { checkOllamaHealth, checkOpenAIHealth, detectOllamaUrl } = await import('../../embeddings.js');
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
      let vectorHealth = null
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
            ? extractProjectHashFromPath(filePath, path.join(deps.outputDir, 'sessions'))
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
    'memory_wake_up',
    'Generate a compact context briefing for session start. Returns workspace identity + key memories + recent decisions in ~200-500 tokens.',
    {
      workspace: z.string().optional().describe('Workspace path, hash, or "all"'),
      limit: z.number().optional().default(10).describe('Max documents per section (default: 10)'),
      json: z.boolean().optional().default(false).describe('Return structured JSON instead of formatted text'),
    },
    async ({ workspace, limit, json }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_wake_up workspace="' + (workspace || '') + '"');

      const wsResult = requireDaemonWorkspace(deps, workspace);
      if ('error' in wsResult) {
        return { content: [{ type: 'text', text: wsResult.error }], isError: true };
      }

      try {
        const result = generateBriefing(wsResult.store, deps.configPath, wsResult.projectHash, {
          limit: limit ?? 10,
          json: json ?? false,
        });
        return {
          content: [{ type: 'text', text: json ? JSON.stringify(result, null, 2) : result.formatted }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: 'Wake-up briefing failed: ' + (err instanceof Error ? err.message : String(err)) }],
          isError: true,
        };
      } finally {
        if (wsResult.needsClose) wsResult.store.close();
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
          for (const logEntry of recentLogs) {
            const targetInfo = logEntry.target_doc_id ? ` → doc ${logEntry.target_doc_id}` : '';
            text += `- [${logEntry.created_at}] doc ${logEntry.document_id}: **${logEntry.action}**${targetInfo}`;
            if (logEntry.reason) {
              text += ` — ${logEntry.reason}`;
            }
            if (logEntry.tokens_used > 0) {
              text += ` (${logEntry.tokens_used} tokens)`;
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
}
