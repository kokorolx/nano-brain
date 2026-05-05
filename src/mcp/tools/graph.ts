import { z } from 'zod';
import * as path from 'path';
import * as crypto from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './types.js';
import { log } from '../../logger.js';
import { requireDaemonWorkspace, formatAvailableWorkspaces } from '../../server/utils.js';
import { hybridSearch } from '../../search.js';
import { openWorkspaceStore } from '../../store.js';
import { findCycles } from '../../graph.js';
import { traverse, isValidRelationshipType } from '../../connection-graph.js';
import { VALID_RELATIONSHIP_TYPES } from '../../types.js';

const WARMUP_ERROR = { isError: true, content: [{ type: 'text' as const, text: 'Server warming up, try again in a few seconds' }] };

export function registerGraphTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, checkReady, currentProjectHash, store, providers } = ctx;

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
      ).catch(() => [] as import('../../types.js').SearchResult[]);

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
}
