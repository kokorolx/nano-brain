## ADDED Requirements

### Requirement: ReactFlow graph canvas renders nodes and edges
The system SHALL render graph data using `@xyflow/react` with nodes positioned via a synchronous d3-force simulation. The canvas SHALL support pan, zoom, and node drag interactions out of the box.

#### Scenario: Graph renders with positioned nodes
- **WHEN** `ReactFlowGraph` receives a non-empty `nodes` and `edges` array
- **THEN** all nodes are displayed at their pre-computed x/y positions within the canvas

#### Scenario: Empty graph shows placeholder
- **WHEN** `ReactFlowGraph` receives an empty `nodes` array
- **THEN** the canvas displays a "No graph data available" message instead of an empty canvas

### Requirement: Type-based color palette for entity nodes
The system SHALL assign distinct colors to Knowledge Graph nodes based on their entity type. At minimum 7 entity types SHALL have unique colors. Unrecognized types SHALL fall back to a default color.

#### Scenario: Known entity type gets type color
- **WHEN** a node has `data.entityType` matching a known type (e.g., "person", "concept", "technology")
- **THEN** the node pill background uses the color defined for that type

#### Scenario: Unknown entity type gets fallback color
- **WHEN** a node has `data.entityType` not in the color map
- **THEN** the node pill background uses the default fallback color (`#64748b`)

### Requirement: Degree-centrality node sizing
The system SHALL size nodes proportionally to their degree (number of connected edges). Hub nodes with many connections SHALL appear larger than leaf nodes.

#### Scenario: High-degree node is larger
- **WHEN** a node has 10+ connected edges
- **THEN** its rendered size is visually larger than a node with 1 connected edge

#### Scenario: Minimum node size enforced
- **WHEN** a node has 0 connected edges
- **THEN** its rendered size is at least the minimum size (not invisible)

### Requirement: Edge highlighting on node selection
The system SHALL highlight edges connected to the selected node and dim all other edges when a node is clicked.

#### Scenario: Connected edges animate on selection
- **WHEN** a user clicks a node
- **THEN** edges connected to that node become `animated: true` and full opacity
- **AND** all other edges have reduced opacity (≤ 0.2)

#### Scenario: Deselection restores all edges
- **WHEN** a user clicks the canvas background (deselects)
- **THEN** all edges return to their default non-animated, full-opacity state

### Requirement: d3-force layout computed synchronously
The system SHALL compute node positions using a synchronous d3-force simulation (fixed iterations) before returning graph data from `graph-adapter.ts`. No async tick callbacks SHALL be used.

#### Scenario: Nodes have valid positions after adapter call
- **WHEN** any `build*Graph` function in `graph-adapter.ts` is called
- **THEN** every returned node has finite numeric `position.x` and `position.y` values

#### Scenario: Layout completes within acceptable time
- **WHEN** `buildEntityGraph` is called with 50 nodes
- **THEN** the function returns within 100ms

### Requirement: graph-adapter returns ReactFlow node/edge format
The system SHALL change all four builder functions (`buildEntityGraph`, `buildCodeGraph`, `buildSymbolGraph`, `buildConnectionGraph`) to return `{ nodes: Node[], edges: Edge[] }` using types from `@xyflow/react`. The graphology `Graph` return type SHALL be removed.

#### Scenario: buildEntityGraph returns ReactFlow format
- **WHEN** `buildEntityGraph` is called with valid `GraphEntitiesResponse` data
- **THEN** the return value has `nodes` array where each item has `id`, `position`, `data`, and `type` fields
- **AND** the return value has `edges` array where each item has `id`, `source`, `target` fields

### Requirement: Sigma.js and graphology dependencies removed
The system SHALL remove `@react-sigma/core`, `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-layout-noverlap`, and `graphology-types` from `src/web/package.json`.

#### Scenario: Build succeeds without Sigma.js packages
- **WHEN** `pnpm build` is run in `src/web/`
- **THEN** the build completes without errors referencing sigma or graphology packages
