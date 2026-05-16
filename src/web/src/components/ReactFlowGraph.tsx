import { memo, useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';

type ReactFlowGraphProps = {
  nodes: Node[];
  edges: Edge[];
  onNodeClick?: (nodeId: string) => void;
  nodeTypes?: NodeTypes;
};

const ReactFlowGraphInner = memo(function ReactFlowGraphInner({ nodes: inputNodes, edges: inputEdges, onNodeClick, nodeTypes }: ReactFlowGraphProps) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState(inputNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(inputEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Single unified effect — handles data sync + focus mode + viewport in one pass.
  // Previously split across 3 effects that all fired on selectedNodeId change,
  // causing redundant double-setNodes and jarring viewport adjustments.
  useEffect(() => {
    const neighbors = selectedNodeId
      ? (() => {
          const s = new Set<string>([selectedNodeId]);
          for (const e of inputEdges) {
            if (e.source === selectedNodeId) s.add(e.target);
            if (e.target === selectedNodeId) s.add(e.source);
          }
          return s;
        })()
      : null;

    // 1. Sync nodes + apply focus state in one pass
    const newNodes = inputNodes.map((n) => ({
      ...n,
      data: neighbors
        ? { ...n.data, dimmed: !neighbors.has(n.id), focused: n.id === selectedNodeId }
        : { ...n.data, dimmed: false, focused: false },
    }));
    setNodes(newNodes);

    // 2. Sync edges + apply focus highlighting in one pass
    const edgeType = (e: Edge) => ((e.data as any)?.edgeType as string | undefined) ?? e.label;
    setEdges(inputEdges.map((e) => {
      if (!neighbors) {
        return { ...e, animated: false, label: edgeType(e), style: { ...e.style, opacity: 0.6, strokeWidth: 2 }, labelStyle: { opacity: 1 } };
      }
      const connected = e.source === selectedNodeId || e.target === selectedNodeId;
      return connected
        ? { ...e, animated: true, label: edgeType(e), style: { ...e.style, opacity: 0.9, strokeWidth: 3 }, labelStyle: { opacity: 1 } }
        : { ...e, animated: false, label: '', style: { ...e.style, opacity: 0.04, strokeWidth: 1 }, labelStyle: { opacity: 0 } };
    }));

    // 3. Viewport: fit to selection or fit full graph on data load
    requestAnimationFrame(() => {
      if (!neighbors) {
        fitView({ padding: 0.15, duration: 300 });
      } else {
        fitView({ nodes: newNodes.filter(n => neighbors.has(n.id)), padding: 0.4, duration: 400, maxZoom: 2 });
      }
    });
  }, [inputNodes, inputEdges, selectedNodeId, setNodes, setEdges, fitView]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
      onNodeClick?.(node.id);
    },
    [onNodeClick]
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    onNodeClick?.('');
  }, [onNodeClick]);

  if (inputNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#8888a0]">
        No graph data available
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      nodeTypes={nodeTypes}
      colorMode="dark"
      minZoom={0.1}
      maxZoom={3}
      nodesConnectable={false}
      nodesDraggable={true}
      elementsSelectable={true}
      onlyRenderVisibleElements={true}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
});

export default function ReactFlowGraph(props: ReactFlowGraphProps) {
  return (
    <ReactFlowProvider>
      <ReactFlowGraphInner {...props} />
    </ReactFlowProvider>
  );
}
