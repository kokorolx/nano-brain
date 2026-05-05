import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './types.js';
import { log } from '../../logger.js';
import { requireDaemonWorkspace } from '../../server/utils.js';
import { SymbolGraph } from '../../symbol-graph.js';

const WARMUP_ERROR = { isError: true, content: [{ type: 'text' as const, text: 'Server warming up, try again in a few seconds' }] };

export function registerCodeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, checkReady, currentProjectHash, store } = ctx;

  server.tool(
    'memory_focus',
    'Get dependency graph context for a specific file',
    {
      filePath: z.string().describe('Absolute path to the file'),
    },
    async ({ filePath }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_focus filePath="' + filePath + '"');
      const { resolveWorkspace } = await import('../../server/utils.js');
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
}
