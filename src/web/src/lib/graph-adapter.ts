import Graph from 'graphology';
import { GraphEntity, GraphEntitiesResponse } from '../api/client';
import { typeColorMap } from './colors';

function randomLayout(graph: Graph, scale: number) {
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'x', (Math.random() - 0.5) * scale);
    graph.setNodeAttribute(node, 'y', (Math.random() - 0.5) * scale);
  });
}

type GraphNodeMeta = {
  id: string;
  label: string;
  entityType: string;
  size: number;
  color: string;
  description?: string | null;
  firstLearnedAt?: string | null;
  lastConfirmedAt?: string | null;
  contradictedAt?: string | null;
};

export function buildEntityGraph(data: GraphEntitiesResponse) {
  const graph = new Graph();
  const edgeCounts = new Map<number, number>();

  for (const edge of data.edges) {
    edgeCounts.set(edge.sourceId, (edgeCounts.get(edge.sourceId) || 0) + 1);
    edgeCounts.set(edge.targetId, (edgeCounts.get(edge.targetId) || 0) + 1);
  }

  for (const node of data.nodes) {
    const count = edgeCounts.get(node.id) || 0;
    const size = Math.max(5, Math.min(25, 5 + count * 1.2));
    graph.addNode(String(node.id), {
      id: String(node.id),
      label: node.name,
      entityType: node.type,
      size,
      color: typeColorMap[node.type] || '#64748b',
      description: node.description,
      firstLearnedAt: node.firstLearnedAt,
      lastConfirmedAt: node.lastConfirmedAt,
      contradictedAt: node.contradictedAt,
    } satisfies GraphNodeMeta);
  }

  for (const edge of data.edges) {
    const source = String(edge.sourceId);
    const target = String(edge.targetId);
    if (graph.hasNode(source) && graph.hasNode(target)) {
      graph.addEdgeWithKey(String(edge.id), source, target, {
        label: edge.edgeType,
        type: edge.edgeType,
        size: 1,
        color: 'rgba(148, 163, 184, 0.4)',
      });
    }
  }

  randomLayout(graph, 800);
  return graph;
}

export function buildCodeGraph(files: Array<{ path: string; centrality: number; clusterId: number | null }>, edges: Array<{ source: string; target: string }>, clusterColors: Record<number, string>) {
  const graph = new Graph();
  for (const file of files) {
    const size = Math.max(4, Math.min(20, 4 + file.centrality * 24));
    const clusterColor = file.clusterId !== null ? clusterColors[file.clusterId] : '#64748b';
    graph.addNode(file.path, {
      id: file.path,
      label: file.path.split('/').slice(-2).join('/'),
      fullPath: file.path,
      clusterId: file.clusterId,
      size,
      color: clusterColor,
    });
  }

  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.addEdge(edge.source, edge.target, {
        label: 'imports',
        size: 1,
        color: 'rgba(148, 163, 184, 0.35)',
      });
    }
  }

  randomLayout(graph, 900);
  return graph;
}

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
