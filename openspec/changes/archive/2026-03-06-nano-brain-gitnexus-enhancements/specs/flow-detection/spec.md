## ADDED Requirements

### Requirement: Execution flow detection from entry points
The system SHALL detect execution flows (processes) by finding entry points and tracing forward through CALLS edges via BFS.

#### Scenario: API route handler as entry point
- **WHEN** an exported function is identified as an entry point (no internal callers, or matches route handler patterns like express/fastapi)
- **THEN** the system traces forward through CALLS edges up to max depth, recording each step as part of a flow

#### Scenario: Flow with configurable max depth
- **WHEN** the max trace depth is set to 10 (default)
- **THEN** the system stops tracing after 10 hops from the entry point, even if more callees exist

#### Scenario: Flow with branching limit
- **WHEN** a symbol calls more than 4 other symbols (default max branching)
- **THEN** the system follows only the top 4 branches (by confidence) to prevent combinatorial explosion

### Requirement: Flows are labeled heuristically
The system SHALL assign human-readable labels to detected flows based on entry point and terminal symbol names.

#### Scenario: Flow from handleLogin to createSession
- **WHEN** a flow starts at "handleLogin" and ends at "createSession"
- **THEN** the flow label is "HandleLogin -> CreateSession"

### Requirement: Flows are classified by community span
The system SHALL classify each flow as either `intra_community` (all steps in same cluster) or `cross_community` (spans multiple clusters).

#### Scenario: Flow within a single cluster
- **WHEN** all symbols in a flow belong to the same Louvain cluster
- **THEN** the flow type is `intra_community`

#### Scenario: Flow spanning multiple clusters
- **WHEN** symbols in a flow belong to 2+ different Louvain clusters
- **THEN** the flow type is `cross_community` and the list of community IDs is included

### Requirement: Detect changes maps git diff to affected flows
The system SHALL provide a `detect_changes` MCP tool that maps uncommitted git changes to affected symbols and execution flows.

#### Scenario: Modified function affects a flow
- **WHEN** a function that participates in "LoginFlow" has uncommitted changes
- **THEN** `detect_changes` returns that function as changed and "LoginFlow" as an affected flow

#### Scenario: No uncommitted changes
- **WHEN** there are no uncommitted git changes in the workspace
- **THEN** `detect_changes` returns an empty result with a message indicating no changes detected

#### Scenario: Changed file not in symbol graph
- **WHEN** a changed file has no indexed symbols (e.g., a config file or unsupported language)
- **THEN** `detect_changes` lists the file as changed but with no affected symbols or flows
