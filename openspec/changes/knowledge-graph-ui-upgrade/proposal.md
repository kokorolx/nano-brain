## Why

The current graph views (Knowledge Graph, Code Dependencies, Symbol Call Graph) use Sigma.js + graphology, which renders via WebGL but provides limited interactivity — no edge highlighting, no animated transitions, and a clunky side-panel UX for node details. The goclaw project demonstrates a significantly better pattern using ReactFlow + d3-force: pill-shaped typed nodes, animated edge highlighting on selection, degree-centrality-based node sizing, and a clean entity detail panel — all in a familiar React component model that is easier to extend.

## What Changes

- **Replace** `@react-sigma/core`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-layout-noverlap`, `graphology-types` with `@xyflow/react` + `d3-force` + `@types/d3-force`
- **New** `ReactFlowGraph` component replaces `GraphCanvas` as the shared graph renderer
- **New** type-based color palette (7 entity types, dual dark/light theme) for Knowledge Graph nodes
- **New** animated edge highlighting: selecting a node dims unrelated edges and highlights connected ones
- **New** degree-centrality node sizing (hub nodes appear larger)
- **New** `EntityDetailPanel` component replaces the `NodeDetail` side panel for the Knowledge Graph view — shows entity metadata, relation list, and a "traverse" action
- **New** table ↔ graph toggle in `GraphExplorer` (Knowledge Graph view)
- **Modify** `graph-adapter.ts` — replace graphology `Graph` return types with ReactFlow `Node[]` / `Edge[]` format for all four builders (`buildEntityGraph`, `buildCodeGraph`, `buildSymbolGraph`, `buildConnectionGraph`)
- **Modify** `CodeGraph.tsx` and `SymbolGraph.tsx` to use the new `ReactFlowGraph` component
- **Modify** `ConnectionsView.tsx` to use the new `ReactFlowGraph` component

## Capabilities

### New Capabilities

- `reactflow-graph-renderer`: Shared ReactFlow + d3-force graph canvas component with pan/zoom, node drag, edge highlighting, and type-based color palette
- `entity-detail-panel`: Entity detail panel for Knowledge Graph showing metadata, relations, and graph traversal

### Modified Capabilities

<!-- No existing spec-level behavior changes — this is a pure UI layer replacement -->

## Impact

**Dependencies removed:** `@react-sigma/core`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-layout-noverlap`, `graphology-types`

**Dependencies added:** `@xyflow/react`, `d3-force`, `@types/d3-force`

**Files modified:**
- `src/web/src/components/GraphCanvas.tsx` → replaced by `ReactFlowGraph.tsx`
- `src/web/src/lib/graph-adapter.ts` — return types change from `Graph` to `{ nodes: Node[], edges: Edge[] }`
- `src/web/src/views/GraphExplorer.tsx` — add table/graph toggle, use new panel
- `src/web/src/views/CodeGraph.tsx` — swap GraphCanvas → ReactFlowGraph
- `src/web/src/views/SymbolGraph.tsx` — swap GraphCanvas → ReactFlowGraph
- `src/web/src/views/ConnectionsView.tsx` — swap GraphCanvas → ReactFlowGraph
- `src/web/package.json` — dependency changes

**No backend/API changes.** The server API (`/api/v1/graph/*`) is unchanged.
