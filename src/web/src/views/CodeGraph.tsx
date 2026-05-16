import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type NodeTypes } from '@xyflow/react';
import ReactFlowGraph from '../components/ReactFlowGraph';
import GraphShell from '../components/GraphShell';
import NodeDetail from '../components/NodeDetail';
import QueryStatus from '../components/QueryStatus';
import { SkeletonGraph } from '../components/Skeleton';
import { fetchCodeDependencies } from '../api/client';
import { buildCodeGraph } from '../lib/graph-adapter';
import { fallbackColors } from '../lib/colors';
import { useAppStore } from '../store/app';
import FileNode from '../components/nodes/FileNode';

const nodeTypes: NodeTypes = { file: FileNode };

export default function CodeGraph() {
  const workspace = useAppStore((state) => state.workspace);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['code-deps', workspace],
    queryFn: () => fetchCodeDependencies(workspace),
  });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const clusterColors = useMemo(() => {
    const clusters = new Map<number, string>();
    data?.files.forEach((file) => {
      if (file.clusterId === null || clusters.has(file.clusterId)) return;
      const color = fallbackColors[clusters.size % fallbackColors.length];
      clusters.set(file.clusterId, color);
    });
    return Object.fromEntries(clusters.entries());
  }, [data]);

  const graphData = useMemo(() => {
    if (!data) return null;
    return buildCodeGraph(data.files, data.edges, clusterColors);
  }, [data, clusterColors]);

  const selectedFile = data?.files.find((file) => file.path === selectedNode);
  const imports = data?.edges.filter((edge) => edge.source === selectedNode).length ?? 0;
  const dependents = data?.edges.filter((edge) => edge.target === selectedNode).length ?? 0;

  const handleNodeClick = (nodeId: string) => {
    setSelectedNode(nodeId || null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Code Dependencies</h1>
          <p className="mt-1 text-sm text-[#8888a0]">File-level dependency graph with centrality sizing.</p>
        </div>
        <div className="text-right text-xs text-[#8888a0]">
          <p>Files: {data?.files.length ?? '—'}</p>
          <p>Edges: {data?.edges.length ?? '—'}</p>
        </div>
      </div>

      {isError && <QueryStatus isLoading={false} isError={true} error={error} refetch={refetch} />}

      <div className="grid grid-cols-[1fr_320px] gap-6 max-lg:grid-cols-1">
        {isLoading ? (
          <SkeletonGraph />
        ) : (
          <GraphShell truncated={graphData?.truncated} unit="files">
            {graphData ? (
              <ReactFlowGraph
                nodes={graphData.nodes}
                edges={graphData.edges}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
              />
            ) : (
              <QueryStatus isLoading={false} isError={false} isEmpty={true} emptyText="No dependency data." />
            )}
          </GraphShell>
        )}
        <div className="space-y-4">
          {selectedFile ? (
            <NodeDetail
              title={selectedFile.path.split('/').slice(-2).join('/')}
              subtitle={selectedFile.path}
              meta={[
                { label: 'Centrality', value: selectedFile.centrality.toFixed(3) },
                { label: 'Cluster', value: selectedFile.clusterId ?? '—' },
                { label: 'Imports', value: imports },
                { label: 'Dependents', value: dependents },
              ]}
            />
          ) : (
            <div className="card p-4 text-sm text-[#8888a0]">Select a file to inspect details.</div>
          )}
          <div className="card p-4 text-sm text-[#8888a0]">
            <p className="font-semibold text-[#e4e4ed]">Cluster legend</p>
            <div className="mt-3 grid gap-2">
              {Object.entries(clusterColors).map(([cluster, color]) => (
                <div key={cluster} className="flex items-center justify-between">
                  <span>Cluster {cluster}</span>
                  <span className="h-3 w-6 rounded-full" style={{ background: color }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
