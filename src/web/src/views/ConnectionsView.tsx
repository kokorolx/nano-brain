import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type NodeTypes } from '@xyflow/react';
import ReactFlowGraph from '../components/ReactFlowGraph';
import GraphShell from '../components/GraphShell';
import NodeDetail from '../components/NodeDetail';
import QueryStatus from '../components/QueryStatus';
import { SkeletonGraph } from '../components/Skeleton';
import { fetchConnections } from '../api/client';
import { buildConnectionGraph } from '../lib/graph-adapter';
import { relationshipColorMap } from '../lib/colors';
import { useAppStore } from '../store/app';
import DocumentNode from '../components/nodes/DocumentNode';

const nodeTypes: NodeTypes = { document: DocumentNode };

export default function ConnectionsView() {
  const workspace = useAppStore((state) => state.workspace);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['connections', workspace],
    queryFn: () => fetchConnections(workspace),
  });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const allConnections = data?.connections ?? [];

  // buildConnectionGraph handles capping + sorting — pass all connections
  const graphData = useMemo(() => {
    if (!allConnections.length) return null;
    return buildConnectionGraph({ connections: allConnections });
  }, [allConnections]);

  const selectedConnections = selectedNode
    ? allConnections.filter(
        (conn) => String(conn.from_doc_id) === selectedNode || String(conn.to_doc_id) === selectedNode
      )
    : [];

  const selectedMeta = useMemo(() => {
    if (!selectedNode || !allConnections.length) return null;
    const match = allConnections.find(
      (conn) => String(conn.from_doc_id) === selectedNode || String(conn.to_doc_id) === selectedNode
    );
    if (!match) return null;
    if (String(match.from_doc_id) === selectedNode) {
      return { title: match.from_title, path: match.from_path };
    }
    return { title: match.to_title, path: match.to_path };
  }, [selectedNode, allConnections]);

  const relationshipStats = useMemo(() => {
    const counts = new Map<string, number>();
    allConnections.forEach((conn) => counts.set(conn.relationship_type, (counts.get(conn.relationship_type) || 0) + 1));
    return Object.fromEntries(counts.entries());
  }, [allConnections]);

  const displayedConnections = useMemo<Array<{id: number|string; type: string; strength: number; target: string|number; targetPath: string; direction: string}>>(() => {
    if (!selectedNode) return [];
    return selectedConnections.map((conn) => {
      const isFrom = String(conn.from_doc_id) === selectedNode;
      return {
        id: conn.id,
        type: conn.relationship_type,
        strength: conn.strength,
        target: isFrom ? conn.to_title || conn.to_path.split('/').pop() || conn.to_doc_id : conn.from_title || conn.from_path.split('/').pop() || conn.from_doc_id,
        targetPath: isFrom ? conn.to_path : conn.from_path,
        direction: isFrom ? 'to' : 'from',
      };
    });
  }, [selectedConnections, selectedNode]);

  const legendItems = useMemo(
    () =>
      Object.keys(relationshipColorMap).map((type) => ({
        type,
        color: relationshipColorMap[type],
      })),
    []
  );

  const nodeCount = useMemo(() => {
    const ids = new Set<string>();
    allConnections.forEach(c => { ids.add(String(c.from_doc_id)); ids.add(String(c.to_doc_id)); });
    return ids.size;
  }, [allConnections]);

  const handleNodeClick = (nodeId: string) => {
    setSelectedNode(nodeId || null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Document Connections</h1>
          <p className="mt-1 text-sm text-[#8888a0]">Memory relationships across documents.</p>
        </div>
        <div className="text-right text-xs text-[#8888a0]">
          <p>Connections: {allConnections.length || 0}</p>
          <p>Documents: {nodeCount || 0}</p>
        </div>
      </div>

      {isError && <QueryStatus isLoading={false} isError={true} error={error} refetch={refetch} />}

      <div className="grid grid-cols-[1fr_320px] gap-6 max-lg:grid-cols-1">
        {isLoading ? (
          <SkeletonGraph />
        ) : (
          <GraphShell truncated={graphData?.truncated} unit="documents">
            {graphData ? (
              <ReactFlowGraph
                nodes={graphData.nodes}
                edges={graphData.edges}
                onNodeClick={handleNodeClick}
                nodeTypes={nodeTypes}
              />
            ) : (
              <QueryStatus isLoading={false} isError={false} isEmpty={true} emptyText="No document connections found. Use the 'memory_connect' tool or MCP 'connect' command to create relationships between memory documents." />
            )}
          </GraphShell>
        )}
        <div className="space-y-4">
          {selectedMeta ? (
            <NodeDetail
              title={selectedMeta.title || 'Untitled document'}
              subtitle={selectedMeta.path}
              meta={[
                { label: 'Connections', value: selectedConnections.length },
              ]}
            />
          ) : (
            <div className="card p-4 text-sm text-[#8888a0]">Select a document to inspect details.</div>
          )}
          <div className="card p-4">
            <h3 className="text-sm font-semibold">Relationship distribution</h3>
            <div className="mt-3 grid gap-2 text-xs text-[#8888a0]">
              {Object.keys(relationshipStats).length
                ? Object.entries(relationshipStats).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: relationshipColorMap[type] ?? '#64748b' }} />
                        <span>{type}</span>
                      </div>
                      <span className="text-[#e4e4ed]">{count}</span>
                    </div>
                  ))
                : '—'}
            </div>
          </div>
          <div className="card p-4">
            <h3 className="text-sm font-semibold">Legend</h3>
            <div className="mt-3 grid gap-2 text-xs text-[#8888a0]">
              {legendItems.map((item) => (
                <div key={item.type} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
                  <span>{item.type}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <h3 className="text-sm font-semibold">Selected connections</h3>
            <div className="mt-3 grid gap-3 text-xs text-[#8888a0]">
              {selectedNode ? (
                displayedConnections.length ? (
                  displayedConnections.map((conn) => (
                    <div key={conn.id} className="rounded-xl border border-[#1f1f2c] bg-[#111118] px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[#e4e4ed]">{conn.target}</span>
                        <span className="rounded-full bg-[#1c1c27] px-2 py-0.5 text-[11px]">{conn.direction}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ background: relationshipColorMap[conn.type] ?? '#64748b' }} />
                          <span>{conn.type}</span>
                        </div>
                        <span>Strength {conn.strength.toFixed(2)}</span>
                      </div>
                      <p className="mt-2 text-[11px] text-[#646478]">{conn.targetPath}</p>
                    </div>
                  ))
                ) : (
                  <p>No connections for this document.</p>
                )
              ) : (
                <p>Select a document to see connection list.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
