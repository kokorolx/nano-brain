## ADDED Requirements

### Requirement: Entity detail panel shows metadata on node selection
The system SHALL display an `EntityDetailPanel` when a node is selected in the Knowledge Graph view. The panel SHALL show the entity's name, type, description, and timestamps (first learned, last confirmed, contradicted).

#### Scenario: Panel appears on node click
- **WHEN** a user clicks a node in the Knowledge Graph
- **THEN** the `EntityDetailPanel` renders with the selected entity's name as the title
- **AND** the entity type is shown as a colored badge matching the node's type color

#### Scenario: Panel shows placeholder when no node selected
- **WHEN** no node is selected in the Knowledge Graph
- **THEN** the panel area shows "Select a node to inspect details." placeholder text

#### Scenario: Panel shows all available metadata
- **WHEN** an entity has description, firstLearnedAt, and lastConfirmedAt values
- **THEN** all three fields are displayed in the panel

#### Scenario: Panel handles missing optional fields gracefully
- **WHEN** an entity has null description or null timestamps
- **THEN** those fields are either hidden or shown as "—" without errors

### Requirement: Entity detail panel shows related edges
The system SHALL display a list of edges (relations) connected to the selected entity in the `EntityDetailPanel`. Each relation SHALL show the edge type and the name of the connected entity.

#### Scenario: Relations list shows connected entities
- **WHEN** a node with outgoing and incoming edges is selected
- **THEN** the panel shows a list of relations with edge type labels and connected entity names

#### Scenario: Relations list is empty for isolated nodes
- **WHEN** a node with no edges is selected
- **THEN** the panel shows "No relations" or an empty state message

#### Scenario: Relations list is scrollable for high-degree nodes
- **WHEN** a node has more than 10 connected edges
- **THEN** the relations list is scrollable and does not overflow the panel layout

### Requirement: Table ↔ graph toggle in Knowledge Graph view
The system SHALL provide a toggle in the `GraphExplorer` view that switches between a graph visualization and a tabular list of entities. Both views SHALL use the same data from the API.

#### Scenario: Default view is graph
- **WHEN** the Knowledge Graph page loads
- **THEN** the graph visualization is shown by default

#### Scenario: Toggle switches to table view
- **WHEN** a user clicks the "Table" toggle button
- **THEN** the graph canvas is replaced by a table listing all entities with their type and description

#### Scenario: Toggle switches back to graph view
- **WHEN** a user is in table view and clicks the "Graph" toggle button
- **THEN** the table is replaced by the graph canvas

#### Scenario: Node selection in graph updates panel
- **WHEN** a user is in graph view and clicks a node
- **THEN** the entity detail panel updates to show that entity's details

#### Scenario: Row click in table updates panel
- **WHEN** a user is in table view and clicks a row
- **THEN** the entity detail panel updates to show that entity's details
