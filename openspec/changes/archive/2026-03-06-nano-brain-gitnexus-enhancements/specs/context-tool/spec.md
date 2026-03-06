## ADDED Requirements

### Requirement: Context tool provides 360-degree symbol view
The system SHALL provide a `context` MCP tool that, given a symbol name, returns a comprehensive view: the symbol's metadata, all incoming references (callers, importers), all outgoing references (callees, imports), cluster membership, and process participation.

#### Scenario: Context for a function
- **WHEN** the user calls `context` with name "validateUser"
- **THEN** the system returns: symbol kind (Function), file path, start/end lines, incoming CALLS edges (who calls it), outgoing CALLS edges (what it calls), cluster ID and label, and list of execution flows it participates in

#### Scenario: Ambiguous symbol name
- **WHEN** the user calls `context` with name "handle" and multiple symbols match
- **THEN** the system returns a disambiguation list with each matching symbol's file path, kind, and line number, prompting the user to specify

#### Scenario: Symbol with infrastructure connections
- **WHEN** the target symbol's source code contains infrastructure symbol usage (e.g., redis.get, db.query)
- **THEN** the context result includes a section listing connected infrastructure symbols (type, pattern, operation)

#### Scenario: Symbol not found
- **WHEN** the user calls `context` with a name that matches no indexed symbol
- **THEN** the system returns a clear "not found" message suggesting the user run a search query instead

### Requirement: Context tool supports file path disambiguation
The system SHALL accept an optional `file_path` parameter to disambiguate symbols with the same name across different files.

#### Scenario: Same-name symbols in different files
- **WHEN** the user calls `context` with name "validate" and file_path "src/auth/validate.ts"
- **THEN** the system returns context for the specific "validate" symbol in that file only
