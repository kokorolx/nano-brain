import { type Node, type Edge } from '@xyflow/react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { ConnectionsResponse, GraphEntity, GraphEntitiesResponse, SymbolsResponse } from '../api/client';
import { edgeTypeColorMap, fallbackColors, relationshipColorMap, symbolKindColorMap, typeColorMap } from './colors';

// ---------- d3-force layout helper ----------

interface SimNode extends SimulationNodeDatum {
  id: string;
}

function computeForceLayout(
  nodes: Node[],
  edges: Edge[],
  opts: { width?: number; height?: number; linkDistance?: number; chargeStrength?: number } = {}
): Node[] {
  if (nodes.length === 0) return nodes;
  const w = opts.width ?? 1400;
  const h = opts.height ?? 900;
  const n = nodes.length;
  const linkDist = opts.linkDistance ?? (n > 100 ? 220 : n > 50 ? 180 : n > 20 ? 160 : 140);
  const charge = opts.chargeStrength ?? (n > 100 ? -500 : n > 50 ? -400 : n > 20 ? -320 : -260);
  const centerPull = n > 100 ? 0.02 : n > 50 ? 0.03 : 0.04;
  const collideBase = n > 100 ? 70 : n > 50 ? 65 : n > 20 ? 60 : 55;

  const simNodes: SimNode[] = nodes.map((nd) => ({
    id: nd.id,
    x: nd.position.x || (Math.random() - 0.5) * w,
    y: nd.position.y || (Math.random() - 0.5) * h,
  }));
  const simLinks = edges.map((e) => ({ source: e.source, target: e.target }));

  const simulation = forceSimulation(simNodes)
    .force('link', forceLink(simLinks).id((d: any) => d.id).distance(linkDist).strength(0.5))
    .force('charge', forceManyBody().strength(charge))
    .force('center', forceCenter(w / 2, h / 2))
    .force('x', forceX(w / 2).strength(centerPull))
    .force('y', forceY(h / 2).strength(centerPull))
    .force('collide', forceCollide().radius(collideBase).strength(0.7))
    .stop();

  const ticks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
  for (let i = 0; i < ticks; i++) simulation.tick();

  return nodes.map((nd, i) => ({
    ...nd,
    position: { x: simNodes[i]!.x ?? 0, y: simNodes[i]!.y ?? 0 },
  }));
}

// ---------- Entity graph (Knowledge Graph) ----------

export function buildEntityGraph(
  data: GraphEntitiesResponse,
  nodeLimit = 500
): { nodes: Node[]; edges: Edge[] } {
  const edgeCounts = new Map<number, number>();
  for (const edge of data.edges) {
    edgeCounts.set(edge.sourceId, (edgeCounts.get(edge.sourceId) || 0) + 1);
    edgeCounts.set(edge.targetId, (edgeCounts.get(edge.targetId) || 0) + 1);
  }

  // Sort by degree descending, take top N
  const sortedNodes = [...data.nodes]
    .sort((a, b) => (edgeCounts.get(b.id) || 0) - (edgeCounts.get(a.id) || 0))
    .slice(0, nodeLimit);
  const nodeIds = new Set(sortedNodes.map((n) => n.id));

  const nodes: Node[] = sortedNodes.map((node) => {
    const degree = edgeCounts.get(node.id) || 0;
    return {
      id: String(node.id),
      type: 'entity',
      position: { x: 0, y: 0 },
      data: {
        label: node.name,
        entityType: node.type,
        degree,
        description: node.description,
        firstLearnedAt: node.firstLearnedAt,
        lastConfirmedAt: node.lastConfirmedAt,
        contradictedAt: node.contradictedAt,
      },
    };
  });

  // Deduplicate edges: keep only one edge per source→target pair
  const seenPairs = new Map<string, Edge>();
  for (const edge of data.edges) {
    if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) continue;
    const source = String(edge.sourceId);
    const target = String(edge.targetId);
    const pairKey = `${source}->${target}`;
    const existing = seenPairs.get(pairKey);
    if (existing) {
      const existingLabel = (existing.data as any)?.edgeType ?? '';
      if (!existingLabel.includes(edge.edgeType)) {
        (existing.data as any).edgeType = `${existingLabel}, ${edge.edgeType}`;
        existing.label = (existing.data as any).edgeType;
      }
    } else {
      seenPairs.set(pairKey, {
        id: `e-${edge.id}`,
        source,
        target,
        label: edge.edgeType,
        data: { edgeType: edge.edgeType },
        animated: false,
        style: { stroke: '#64748b', strokeWidth: 2, opacity: 0.6 },
      });
    }
  }
  const edges: Edge[] = Array.from(seenPairs.values());

  const positioned = computeForceLayout(nodes, edges);
  return { nodes: positioned, edges };
}

// ---------- Code dependency graph ----------

export function buildCodeGraph(
  files: Array<{ path: string; centrality: number; clusterId: number | null }>,
  rawEdges: Array<{ source: string; target: string }>,
  clusterColors: Record<number, string>
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = files.map((file) => {
    const clusterColor = file.clusterId !== null ? clusterColors[file.clusterId] : '#64748b';
    return {
      id: file.path,
      type: 'file',
      position: { x: 0, y: 0 },
      data: {
        label: file.path.split('/').slice(-2).join('/'),
        fullPath: file.path,
        clusterId: file.clusterId,
        color: clusterColor ?? '#64748b',
        centrality: file.centrality,
      },
    };
  });

  const nodeIds = new Set(files.map((f) => f.path));
  const seenEdges = new Set<string>();
  const edges: Edge[] = [];
  for (const edge of rawEdges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const key = `${edge.source}->${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({
      id: `e-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      label: 'imports',
      animated: false,
      style: { stroke: 'rgba(148, 163, 184, 0.35)', strokeWidth: 1, opacity: 0.6 },
    });
  }

  const positioned = computeForceLayout(nodes, edges, { width: 1600, height: 1000 });
  return { nodes: positioned, edges };
}

// ---------- Symbol call graph ----------

export function buildSymbolGraph(
  data: SymbolsResponse,
  clusterMode: boolean
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  if (clusterMode && data.clusters.length > 0) {
    for (const cluster of data.clusters) {
      nodes.push({
        id: `cluster-${cluster.clusterId}`,
        type: 'symbol',
        position: { x: 0, y: 0 },
        data: {
          label: `Cluster ${cluster.clusterId} (${cluster.memberCount})`,
          entityType: 'cluster',
          color: fallbackColors[cluster.clusterId % fallbackColors.length],
        },
      });
    }

    for (const sym of data.symbols) {
      if (sym.clusterId === null) {
        nodes.push({
          id: String(sym.id),
          type: 'symbol',
          position: { x: 0, y: 0 },
          data: {
            label: sym.name,
            entityType: sym.kind,
            color: symbolKindColorMap[sym.kind] || '#64748b',
            filePath: sym.filePath,
            startLine: sym.startLine,
          },
        });
      }
    }

    const clusterEdges = new Map<string, number>();
    const symbolById = new Map(data.symbols.map((sym) => [sym.id, sym]));
    for (const edge of data.edges) {
      const src = symbolById.get(edge.sourceId);
      const tgt = symbolById.get(edge.targetId);
      if (!src || !tgt || src.clusterId == null || tgt.clusterId == null) continue;
      if (src.clusterId === tgt.clusterId) continue;
      const key = `cluster-${src.clusterId}||cluster-${tgt.clusterId}`;
      clusterEdges.set(key, (clusterEdges.get(key) || 0) + 1);
    }
    for (const [key, count] of clusterEdges) {
      const [srcNode, tgtNode] = key.split('||');
      edges.push({
        id: `e-${key}`,
        source: srcNode,
        target: tgtNode,
        label: `${count}`,
        animated: false,
        style: { stroke: 'rgba(148,163,184,0.4)', strokeWidth: Math.min(5, 1 + count * 0.2), opacity: 0.6 },
      });
    }
  } else {
    for (const sym of data.symbols) {
      nodes.push({
        id: String(sym.id),
        type: 'symbol',
        position: { x: 0, y: 0 },
        data: {
          label: sym.name,
          entityType: sym.kind,
          color: symbolKindColorMap[sym.kind] || '#64748b',
          filePath: sym.filePath,
          startLine: sym.startLine,
          clusterId: sym.clusterId,
        },
      });
    }

    const seenEdges = new Set<string>();
    for (const edge of data.edges) {
      const src = String(edge.sourceId);
      const tgt = String(edge.targetId);
      const key = `${src}->${tgt}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        id: `e-${edge.id}`,
        source: src,
        target: tgt,
        label: edge.edgeType,
        data: { edgeType: edge.edgeType },
        animated: false,
        style: {
          stroke: edgeTypeColorMap[edge.edgeType] || 'rgba(148, 163, 184, 0.3)',
          strokeWidth: 1,
          opacity: 0.6,
        },
      });
    }
  }

  const positioned = computeForceLayout(nodes, edges, { width: 1800, height: 1200 });
  return { nodes: positioned, edges };
}

// ---------- Connection graph ----------

export function buildConnectionGraph(
  data: ConnectionsResponse
): { nodes: Node[]; edges: Edge[] } {
  const docNodes = new Map<string, Node>();
  const seenPairs = new Map<string, Edge>();

  for (const conn of data.connections) {
    const fromId = String(conn.from_doc_id);
    const toId = String(conn.to_doc_id);

    if (!docNodes.has(fromId)) {
      docNodes.set(fromId, {
        id: fromId,
        type: 'document',
        position: { x: 0, y: 0 },
        data: {
          label: conn.from_title || conn.from_path.split('/').pop() || fromId,
          fullPath: conn.from_path,
          color: '#3b82f6',
        },
      });
    }
    if (!docNodes.has(toId)) {
      docNodes.set(toId, {
        id: toId,
        type: 'document',
        position: { x: 0, y: 0 },
        data: {
          label: conn.to_title || conn.to_path.split('/').pop() || toId,
          fullPath: conn.to_path,
          color: '#3b82f6',
        },
      });
    }

    const pairKey = `${fromId}->${toId}`;
    const existing = seenPairs.get(pairKey);
    if (existing) {
      const existingLabel = typeof existing.label === 'string' ? existing.label : '';
      if (!existingLabel.includes(conn.relationship_type)) {
        existing.label = `${existingLabel}, ${conn.relationship_type}`;
      }
    } else {
      seenPairs.set(pairKey, {
        id: `e-${conn.id}`,
        source: fromId,
        target: toId,
        label: conn.relationship_type,
        data: { edgeType: conn.relationship_type },
        animated: false,
        style: {
          stroke: relationshipColorMap[conn.relationship_type] || 'rgba(148,163,184,0.4)',
          strokeWidth: Math.max(1, Math.min(5, conn.strength * 5)),
          opacity: 0.6,
        },
      });
    }
  }

  const nodes = Array.from(docNodes.values());
  const edges = Array.from(seenPairs.values());
  const positioned = computeForceLayout(nodes, edges, { width: 800, height: 500 });
  return { nodes: positioned, edges };
}

// ---------- Utility ----------

export function getNodeMeta(entity?: GraphEntity) {
  if (!entity) return undefined;
  return {
    id: String(entity.id),
    label: entity.name,
    type: entity.type,
    description: entity.description,
    firstLearnedAt: entity.firstLearnedAt,
    lastConfirmedAt: entity.lastConfirmedAt,
    contradictedAt: entity.contradictedAt,
  };
}
