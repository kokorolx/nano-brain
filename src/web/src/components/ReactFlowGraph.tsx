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

  // Build neighbor set helper
  const buildNeighbors = useCallback((nodeId: string) => {
    const s = new Set<string>([nodeId]);
    for (const e of inputEdges) {
      if (e.source === nodeId) s.add(e.target);
      if (e.target === nodeId) s.add(e.source);
    }
    return s;
  }, [inputEdges]);

  // Sync nodes from props — also apply current focus state so dimming survives data refresh
  useEffect(() => {
    if (!selectedNodeId) {
      setNodes(inputNodes.map((n) => ({
        ...n,
        data: { ...n.data, dimmed: false, focused: false },
      })));
    } else {
      const neighbors = buildNeighbors(selectedNodeId);
      setNodes(inputNodes.map((n) => ({
        ...n,
        data: { ...n.data, dimmed: !neighbors.has(n.id), focused: n.id === selectedNodeId },
      })));
    }
    // Only fit view on fresh data load — skip when user has a node selected
    // to avoid jarring viewport reset mid-focus-mode.
    if (!selectedNodeId) {
      requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
    }
  }, [inputNodes, setNodes, fitView, selectedNodeId, buildNeighbors]);

  // Sync edges from props
  useEffect(() => {
    setEdges(inputEdges);
  }, [inputEdges, setEdges]);

  // Focus mode: dim/hide unrelated nodes (via data.dimmed) + fade edges
  useEffect(() => {
    if (!selectedNodeId) {
      setEdges((eds) => eds.map((e) => ({
        ...e, animated: false,
        label: ((e.data as any)?.edgeType as string | undefined) ?? e.label,
        style: { ...e.style, opacity: 0.6, strokeWidth: 2 },
        labelStyle: { opacity: 1 },
      })));
      return;
    }

    const neighbors = buildNeighbors(selectedNodeId);

    // Node dimming is handled via data.dimmed in each node component — no opacity on style
    setNodes((nds) => nds.map((n) => ({
      ...n,
      data: { ...n.data, dimmed: !neighbors.has(n.id), focused: n.id === selectedNodeId },
    })));

    setEdges((eds) => eds.map((e) => {
      const connected = e.source === selectedNodeId || e.target === selectedNodeId;
      return connected
        ? { ...e, animated: true, label: ((e.data as any)?.edgeType as string | undefined) ?? e.label, style: { ...e.style, opacity: 0.9, strokeWidth: 3 }, labelStyle: { opacity: 1 } }
        : { ...e, animated: false, label: '', style: { ...e.style, opacity: 0.04, strokeWidth: 1 }, labelStyle: { opacity: 0 } };
    }));
  }, [selectedNodeId, buildNeighbors, setNodes, setEdges]);

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
