import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type NodeTypes } from '@xyflow/react';
import ReactFlowGraph from '../components/ReactFlowGraph';
import NodeDetail from '../components/NodeDetail';
import QueryStatus from '../components/QueryStatus';
import { SkeletonGraph } from '../components/Skeleton';
import { fetchSymbols } from '../api/client';
import { buildSymbolGraph } from '../lib/graph-adapter';
import { symbolKindColorMap } from '../lib/colors';
import { useAppStore } from '../store/app';
import SymbolNode from '../components/nodes/SymbolNode';

const nodeTypes: NodeTypes = { symbol: SymbolNode };

export default function SymbolGraph() {
  const workspace = useAppStore((state) => state.workspace);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['symbols', workspace],
    queryFn: () => fetchSymbols(workspace),
  });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [clusterMode, setClusterMode] = useState(false);

  const autoCluster = (data?.symbols.length ?? 0) > 500;
  const useCluster = clusterMode && autoCluster;

  const graphData = useMemo(() => {
    if (!data) return null;
    try {
      return buildSymbolGraph(data, useCluster);
    } catch {
      return null;
    }
  }, [data, useCluster]);

  const selectedSymbol = data?.symbols.find((s) => String(s.id) === selectedNode);

  const callers = data?.edges.filter((e) => String(e.targetId) === selectedNode).length ?? 0;
  const callees = data?.edges.filter((e) => String(e.sourceId) === selectedNode).length ?? 0;

  const handleNodeClick = (nodeId: string) => {
    setSelectedNode(nodeId || null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Symbol Call Graph</h1>
          <p className="mt-1 text-sm text-[#8888a0]">Functions, classes, and their call relationships.</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-[#8888a0]">
          {autoCluster && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={clusterMode}
                onChange={(e) => setClusterMode(e.target.checked)}
                className="accent-indigo-500"
              />
              Cluster view
            </label>
          )}
          <div className="text-right">
            <p>Symbols: {data?.symbols.length ?? '—'}</p>
            <p>Edges: {data?.edges.length ?? '—'}</p>
            <p>Clusters: {data?.clusters.length ?? '—'}</p>
          </div>
        </div>
      </div>

      {isError && <QueryStatus isLoading={false} isError={true} error={error} refetch={refetch} />}

      <div className="grid grid-cols-[1fr_320px] gap-6 max-lg:grid-cols-1">
        {isLoading ? (
          <SkeletonGraph />
        ) : (
          <div className="card graph-shell overflow-hidden relative">
            {graphData?.truncated && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-[#1c1c27]/90 border border-[#3a3a5c] text-[11px] text-[#8888a0]">
                Showing top {graphData.truncated.shown} of {graphData.truncated.total.toLocaleString()} symbols by call degree
              </div>
            )}
            {graphData && (data?.symbols.length ?? 0) > 0 ? (
              <ReactFlowGraph
                nodes={graphData.nodes}
                edges={graphData.edges}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
              />
            ) : (
              <QueryStatus
                isLoading={false}
                isError={false}
                isEmpty={true}
                emptyText="No symbol data available. Run 'npx nano-brain index-codebase' to index symbols, or the code_symbols table may need repair (check DB integrity)."
              />
            )}
          </div>
        )}
        <div className="space-y-4">
          {selectedSymbol ? (
            <NodeDetail
              title={selectedSymbol.name}
              subtitle={`${selectedSymbol.kind} · ${selectedSymbol.filePath?.split('/').pop()}:${selectedSymbol.startLine}`}
              description={selectedSymbol.filePath}
              meta={[
                { label: 'Kind', value: selectedSymbol.kind },
                { label: 'Exported', value: selectedSymbol.exported ? 'Yes' : 'No' },
                { label: 'Cluster', value: selectedSymbol.clusterId ?? '—' },
                { label: 'Callers', value: callers },
                { label: 'Callees', value: callees },
              ]}
            />
          ) : (
            <div className="card p-4 text-sm text-[#8888a0]">Select a symbol to inspect details.</div>
          )}
          <div className="card p-4">
            <h3 className="text-sm font-semibold">Symbol kinds</h3>
            <div className="mt-3 grid gap-2 text-xs text-[#8888a0]">
              {Object.entries(symbolKindColorMap).map(([kind, color]) => (
                <div key={kind} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ background: color }} />
                    <span>{kind}</span>
                  </div>
                  <span className="text-[#e4e4ed]">
                    {data?.symbols.filter((s) => s.kind === kind).length ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
