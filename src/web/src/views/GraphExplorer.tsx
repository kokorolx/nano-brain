import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type NodeTypes } from '@xyflow/react';
import ReactFlowGraph from '../components/ReactFlowGraph';
import GraphShell from '../components/GraphShell';
import EntityDetailPanel from '../components/EntityDetailPanel';
import QueryStatus from '../components/QueryStatus';
import { SkeletonGraph } from '../components/Skeleton';
import { fetchGraphEntities } from '../api/client';
import { buildEntityGraph } from '../lib/graph-adapter';
import { useAppStore } from '../store/app';
import EntityNode from '../components/nodes/EntityNode';
import { TYPE_COLORS, DEFAULT_TYPE_COLOR } from '../lib/colors';

const nodeTypes: NodeTypes = { entity: EntityNode };

export default function GraphExplorer() {
  const workspace = useAppStore((state) => state.workspace);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['graph-entities', workspace],
    queryFn: () => fetchGraphEntities(workspace),
  });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeLimit, setNodeLimit] = useState(300);
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph');

  const graphData = useMemo(() => {
    if (!data) return null;
    try {
      return buildEntityGraph(data, nodeLimit);
    } catch (err) {
      console.error('[GraphExplorer] graph build failed:', err);
      return null;
    }
  }, [data, nodeLimit]);

  const selectedEntity = useMemo(() => {
    if (!selectedNode || !data) return null;
    const entity = data.nodes.find((node) => String(node.id) === selectedNode);
    if (!entity) return null;
    return {
      id: String(entity.id),
      name: entity.name,
      entityType: entity.type,
      description: entity.description,
      firstLearnedAt: entity.firstLearnedAt,
      lastConfirmedAt: entity.lastConfirmedAt,
      contradictedAt: entity.contradictedAt,
    };
  }, [selectedNode, data]);

  const nodeNames = useMemo(() => {
    const map = new Map<string, string>();
    data?.nodes.forEach((n) => map.set(String(n.id), n.name));
    return map;
  }, [data]);

  const handleNodeClick = (nodeId: string) => {
    setSelectedNode(nodeId || null);
  };

  if (isError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Knowledge Graph</h1>
          <p className="mt-1 text-sm text-[#8888a0]">Explore memory entities and their relationships.</p>
        </div>
        <QueryStatus isLoading={false} isError={true} error={error} refetch={refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Knowledge Graph</h1>
          <p className="mt-1 text-sm text-[#8888a0]">Explore memory entities and their relationships.</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#8888a0]">
          {/* Graph ↔ Table toggle */}
          <div className="flex rounded-lg border border-[#1f1f2c] overflow-hidden">
            <button
              className={`px-3 py-1 text-xs ${viewMode === 'graph' ? 'bg-indigo-600 text-white' : 'bg-[#111118] text-[#8888a0]'}`}
              onClick={() => setViewMode('graph')}
            >
              Graph
            </button>
            <button
              className={`px-3 py-1 text-xs ${viewMode === 'table' ? 'bg-indigo-600 text-white' : 'bg-[#111118] text-[#8888a0]'}`}
              onClick={() => setViewMode('table')}
            >
              Table
            </button>
          </div>
          <label className="flex items-center gap-2">
            Node limit:
            <input
              type="range"
              min={50}
              max={Math.max(500, data?.stats.nodeCount ?? 500)}
              step={50}
              value={nodeLimit}
              onChange={(e) => setNodeLimit(Number(e.target.value))}
              className="w-28 accent-indigo-500"
            />
            <span className="w-8 text-right text-[#e4e4ed]">{nodeLimit}</span>
          </label>
          <div className="text-right">
            <p>Nodes: {data?.stats.nodeCount ?? '—'}</p>
            <p>Edges: {data?.stats.edgeCount ?? '—'}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6 max-lg:grid-cols-1">
        {isLoading ? (
          <SkeletonGraph />
        ) : viewMode === 'graph' ? (
          <GraphShell truncated={graphData?.truncated} unit="entities">
            {graphData ? (
              <ReactFlowGraph
                nodes={graphData.nodes}
                edges={graphData.edges}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
              />
            ) : (
              <QueryStatus isLoading={false} isError={false} isEmpty={true} emptyText="No graph data available." />
            )}
          </GraphShell>
        ) : (
          /* Table view */
          <div className="card overflow-hidden">
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#0d0d14] text-left text-xs text-[#8888a0]">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.nodes.slice(0, nodeLimit).map((entity) => {
                    const tc = TYPE_COLORS[entity.type] || DEFAULT_TYPE_COLOR;
                    return (
                      <tr
                        key={entity.id}
                        className={`cursor-pointer border-t border-[#1f1f2c] hover:bg-[#1c1c27] ${
                          selectedNode === String(entity.id) ? 'bg-[#1c1c27]' : ''
                        }`}
                        onClick={() => setSelectedNode(String(entity.id))}
                      >
                        <td className="px-3 py-2 text-[#e4e4ed]">{entity.name}</td>
                        <td className="px-3 py-2">
                          <span
                            className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ background: tc.dark.bg, color: tc.dark.text, border: `1px solid ${tc.border}` }}
                          >
                            {entity.type}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[#8888a0] truncate max-w-[300px]">
                          {entity.description || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="space-y-4">
          <EntityDetailPanel
            entity={selectedEntity}
            edges={graphData?.edges ?? []}
            nodeNames={nodeNames}
          />
          <div className="card p-4">
            <h3 className="text-sm font-semibold">Type distribution</h3>
            <div className="mt-3 grid gap-2 text-xs text-[#8888a0]">
              {data?.stats.typeDistribution
                ? Object.entries(data.stats.typeDistribution).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between">
                      <span>{type}</span>
                      <span className="text-[#e4e4ed]">{count}</span>
                    </div>
                  ))
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
