## Context

nano-brain's web UI has four graph views: Knowledge Graph (entity relations), Code Dependencies (file imports), Symbol Call Graph (function/class calls), and Connections (document links). All four currently share a single `GraphCanvas.tsx` component backed by Sigma.js (WebGL) + graphology. The graph data is built in `graph-adapter.ts` which returns graphology `Graph` objects.

The goclaw project has a polished graph UI using `@xyflow/react` (ReactFlow v12) + `d3-force` for layout. Key UX improvements it demonstrates:
- Pill-shaped nodes with per-type color coding
- Edge highlighting on node selection (connected edges brighten, others dim)
- Degree-centrality-based node sizing
- Entity detail panel with relation list (not just a metadata sidebar)
- Table ↔ graph toggle for the entity list

This design covers replacing the Sigma.js stack with ReactFlow across all four graph views.

## Goals / Non-Goals

**Goals:**
- Replace Sigma.js + graphology with `@xyflow/react` + `d3-force` for all graph views
- Implement type-based color palette for Knowledge Graph nodes (7 entity types)
- Implement animated edge highlighting on node selection
- Implement degree-centrality node sizing
- Add table ↔ graph toggle to GraphExplorer (Knowledge Graph)
- Add `EntityDetailPanel` with entity metadata + relation list
- Refactor `graph-adapter.ts` to return `{ nodes: Node[], edges: Edge[] }` (ReactFlow format)
- Remove all Sigma.js / graphology dependencies from `package.json`

**Non-Goals:**
- 3D graph rendering (goclaw uses 2D ReactFlow, not Three.js)
- Backend API changes
- New graph views beyond the existing four
- Mobile-specific layout optimizations

## Decisions

### D1: ReactFlow + d3-force over Sigma.js + graphology

**Decision:** Migrate to `@xyflow/react` + `d3-force`.

**Rationale:**
- ReactFlow is a React-native component — nodes are React elements, enabling rich per-node UI (pill shapes, icons, badges) without custom WebGL shaders
- d3-force is the standard physics simulation library; it's already used in goclaw and is well-understood
- Sigma.js is powerful for very large graphs (100k+ nodes) but overkill for nano-brain's typical graph sizes (< 1000 nodes); the WebGL abstraction makes custom node shapes difficult
- Removing graphology eliminates ~6 packages from the bundle

**Alternatives considered:**
- Keep Sigma.js, add custom node renderers: possible but complex; Sigma's renderer API is low-level
- Use Cytoscape.js: mature but heavier, less React-idiomatic
- Use vis-network: older API, less TypeScript-friendly

### D2: Shared `ReactFlowGraph` component for all four views

**Decision:** Create a single `ReactFlowGraph.tsx` that accepts `nodes`, `edges`, `onNodeClick`, and optional `nodeTypes` prop.

**Rationale:** All four views need the same pan/zoom/drag behavior and edge highlighting logic. The only difference is node shape (entity pill vs file node vs symbol node). Custom node types are passed in via the `nodeTypes` prop, keeping the component generic.

### D3: d3-force layout computed outside React render

**Decision:** Run the d3-force simulation synchronously (fixed iterations) in `graph-adapter.ts` before returning nodes, setting `x`/`y` positions directly on the node objects.

**Rationale:** Async simulation with tick callbacks would require managing simulation state in React, adding complexity. For graphs < 1000 nodes, 300 synchronous iterations complete in < 50ms. This matches goclaw's approach (`computeForceLayout` runs synchronously).

**Alternatives considered:**
- Web Worker for simulation: better for large graphs but adds complexity; not needed at current scale
- ReactFlow's built-in layout: ReactFlow doesn't include a force layout; it requires external positioning

### D4: Node limit for Knowledge Graph (GRAPH_LIMIT = 50 for initial render)

**Decision:** Default node limit for Knowledge Graph is 50 (degree-centrality ranked), with a slider to increase up to 500.

**Rationale:** ReactFlow renders nodes as DOM elements (not WebGL), so performance degrades faster than Sigma.js at high node counts. 50 nodes renders instantly; 200+ may feel sluggish on low-end hardware. The existing slider UI is preserved.

### D5: Edge highlighting via React state (not CSS classes)

**Decision:** On node selection, recompute `edges` array with updated `animated` and `style.opacity` properties, triggering a React re-render.

**Rationale:** ReactFlow's edge rendering is React-controlled. Setting `animated: true` on connected edges and `style: { opacity: 0.15 }` on unconnected edges is the idiomatic approach. This avoids direct DOM manipulation.

### D6: `graph-adapter.ts` returns ReactFlow types

**Decision:** Change all four builder functions to return `{ nodes: Node[], edges: Edge[] }` where `Node` and `Edge` are from `@xyflow/react`.

**Rationale:** Centralizing the data transformation in `graph-adapter.ts` keeps view components thin. The graphology `Graph` object is no longer needed anywhere.

## Risks / Trade-offs

- **[Risk] ReactFlow DOM performance at high node counts** → Mitigation: Keep default GRAPH_LIMIT at 50 for KG view; add a warning when limit > 200. Code/Symbol graphs already have their own limits.
- **[Risk] d3-force layout quality varies** → Mitigation: Tune `forceLink.distance`, `forceManyBody.strength`, and `forceCollide.radius` per graph type (entity vs file vs symbol). Copy proven values from goclaw.
- **[Risk] Breaking change to `graph-adapter.ts` API** → Mitigation: All callers are in the same repo (GraphExplorer, CodeGraph, SymbolGraph, ConnectionsView). Update all callers in the same PR.
- **[Risk] `@xyflow/react` CSS import required** → Mitigation: Import `@xyflow/react/dist/style.css` in the root `App.tsx` or `main.tsx`.
- **[Risk] ReactFlow node drag conflicts with pan** → Mitigation: Use ReactFlow's built-in `nodesDraggable` prop; it handles this correctly by default.

## Migration Plan

1. Install new deps, remove old deps in `src/web/package.json`
2. Create `ReactFlowGraph.tsx` (new shared component)
3. Create custom node types: `EntityNode`, `FileNode`, `SymbolNode`, `DocumentNode`
4. Refactor `graph-adapter.ts` — change return types, add d3-force layout
5. Update `GraphExplorer.tsx` — use ReactFlowGraph, add table/graph toggle, add EntityDetailPanel
6. Update `CodeGraph.tsx`, `SymbolGraph.tsx`, `ConnectionsView.tsx` — swap GraphCanvas → ReactFlowGraph
7. Delete `GraphCanvas.tsx` (replaced)
8. Run `pnpm build` to verify no TypeScript errors
9. Manual smoke test: open each graph view, verify nodes render, click a node, verify edge highlighting

**Rollback:** The old `GraphCanvas.tsx` and graphology deps can be restored from git. No database or API changes to roll back.

## Open Questions

- Should `EntityDetailPanel` include a "show neighbors" button that re-queries the API for related entities? (Nice-to-have; can be deferred to a follow-up change)
- Should the table view in GraphExplorer be paginated or virtualized? (Current entity counts are small enough that a simple list is fine for now)
