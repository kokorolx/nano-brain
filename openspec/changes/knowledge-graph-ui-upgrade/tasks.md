## 1. Dependencies

- [ ] 1.1 Remove `@react-sigma/core`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-layout-noverlap`, `graphology-types` from `src/web/package.json`
- [ ] 1.2 Add `@xyflow/react`, `d3-force`, `@types/d3-force` to `src/web/package.json`
- [ ] 1.3 Run `pnpm install` in `src/web/` to update lockfile

## 2. ReactFlow Graph Component

- [ ] 2.1 Create `src/web/src/components/ReactFlowGraph.tsx` — shared canvas accepting `nodes`, `edges`, `onNodeClick`, `nodeTypes` props with pan/zoom/drag
- [ ] 2.2 Implement edge highlighting logic in `ReactFlowGraph`: on node click, set `animated: true` + full opacity on connected edges, dim others; deselect restores defaults
- [ ] 2.3 Import `@xyflow/react/dist/style.css` in `src/web/src/main.tsx` or `App.tsx`

## 3. Custom Node Types

- [ ] 3.1 Create `EntityNode` — pill-shaped node with type-based background color and label, sized by degree
- [ ] 3.2 Create `FileNode` — compact node for code dependency graph, colored by cluster
- [ ] 3.3 Create `SymbolNode` — node for symbol call graph, colored by symbol kind
- [ ] 3.4 Create `DocumentNode` — node for connections graph, colored by relationship type
- [ ] 3.5 Define `TYPE_COLORS` record in `src/web/src/lib/colors.ts` with 7 entity type colors (dual dark/light palette)

## 4. graph-adapter Refactor

- [ ] 4.1 Refactor `buildEntityGraph` to return `{ nodes: Node[], edges: Edge[] }` (ReactFlow types); add d3-force layout (forceLink + forceManyBody + forceCenter + forceCollide); keep degree-centrality node sizing
- [ ] 4.2 Refactor `buildCodeGraph` to return `{ nodes: Node[], edges: Edge[] }`; add d3-force layout
- [ ] 4.3 Refactor `buildSymbolGraph` to return `{ nodes: Node[], edges: Edge[] }`; add d3-force layout; preserve cluster mode logic
- [ ] 4.4 Refactor `buildConnectionGraph` to return `{ nodes: Node[], edges: Edge[] }`; add d3-force layout
- [ ] 4.5 Remove all graphology imports from `graph-adapter.ts`

## 5. EntityDetailPanel Component

- [ ] 5.1 Create `src/web/src/components/EntityDetailPanel.tsx` — shows entity name, type badge (with type color), description, and timestamps
- [ ] 5.2 Add relations list to `EntityDetailPanel` — shows edge type + connected entity name for all edges connected to the selected node; scrollable when > 10 items
- [ ] 5.3 Handle null/missing fields gracefully (show "—" for missing timestamps, hide description if null)

## 6. GraphExplorer View Update

- [ ] 6.1 Replace `GraphCanvas` import with `ReactFlowGraph` in `GraphExplorer.tsx`
- [ ] 6.2 Replace `NodeDetail` side panel with `EntityDetailPanel` in `GraphExplorer.tsx`
- [ ] 6.3 Add table ↔ graph toggle buttons to `GraphExplorer.tsx` header
- [ ] 6.4 Implement table view in `GraphExplorer.tsx` — list all entities with type badge and description; row click updates selected entity
- [ ] 6.5 Pass `edges` data to `EntityDetailPanel` so it can render the relations list

## 7. Other Graph Views Update

- [ ] 7.1 Replace `GraphCanvas` with `ReactFlowGraph` in `CodeGraph.tsx`; pass `FileNode` as custom node type
- [ ] 7.2 Replace `GraphCanvas` with `ReactFlowGraph` in `SymbolGraph.tsx`; pass `SymbolNode` as custom node type
- [ ] 7.3 Replace `GraphCanvas` with `ReactFlowGraph` in `ConnectionsView.tsx`; pass `DocumentNode` as custom node type

## 8. Cleanup

- [ ] 8.1 Delete `src/web/src/components/GraphCanvas.tsx`
- [ ] 8.2 Remove graphology imports from `src/web/src/lib/graph-adapter.ts` (verify none remain)
- [ ] 8.3 Run `pnpm build` in `src/web/` — fix any TypeScript errors

## 9. Verification

- [ ] 9.1 Smoke test: open Knowledge Graph view — verify nodes render with type colors, edge highlighting works on click
- [ ] 9.2 Smoke test: toggle table view — verify entity list renders, row click updates detail panel
- [ ] 9.3 Smoke test: open Code Dependencies view — verify file nodes render with cluster colors
- [ ] 9.4 Smoke test: open Symbol Call Graph view — verify symbol nodes render, cluster mode toggle works
- [ ] 9.5 Smoke test: open Connections view — verify document nodes and relation edges render
