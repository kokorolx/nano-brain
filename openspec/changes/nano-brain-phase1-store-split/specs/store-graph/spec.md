## ADDED Requirements

### Requirement: Graph module owns all code graph and symbol operations
The system SHALL extract file edge storage, memory entity/connection management, infrastructure symbol indexing, and graph analytics from `store.ts` into `src/store/graph.ts`.

#### Scenario: File import edges are stored and queryable
- **WHEN** `insertFileEdge(source, target, edgeType, projectHash)` is called
- **THEN** the edge is persisted and `getFileEdges(projectHash)` returns it in subsequent calls

#### Scenario: Memory entities are scoped per project
- **WHEN** `insertOrUpdateEntity(name, type, description, projectHash)` is called
- **THEN** the entity is created or updated and `getMemoryEntities(projectHash)` returns it

#### Scenario: Infrastructure symbols are queryable by type and pattern
- **WHEN** `querySymbols({ type: 'redis_key', pattern: 'session:*', projectHash })` is called
- **THEN** only symbols matching the type and pattern glob are returned

#### Scenario: Graph stats reflect current state
- **WHEN** `getGraphStats()` is called
- **THEN** accurate counts for nodes, edges, clusters, and cycles are returned based on current DB state

#### Scenario: Circular dependency detection works
- **WHEN** `findCycles()` is called
- **THEN** all cycles in the file edge graph are returned as arrays of file paths

### Requirement: Document flows are managed in the graph module
The system SHALL include `getDocFlows`, `upsertDocFlow`, `getFlowsWithSteps`, and `getFlowSteps` in `graph.ts` as they model document relationship graphs.

#### Scenario: Flow steps are retrievable after creation
- **WHEN** `upsertDocFlow(flow)` is called followed by `getFlowSteps(flowId)`
- **THEN** the flow's steps are returned in order
