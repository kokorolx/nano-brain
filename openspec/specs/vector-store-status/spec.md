# vector-store-status Specification

## Purpose
TBD - created by archiving change enhance-status-command. Update Purpose after archive.
## Requirements
### Requirement: CLI status displays vector store health
The `status` CLI command SHALL display a "Vector Store" section showing the active provider, connectivity status, vector count, and dimensions when a vector store is configured.

#### Scenario: Qdrant is healthy
- **WHEN** user runs `npx nano-brain status` and Qdrant is configured and reachable
- **THEN** status output SHALL include a "Vector Store" section with provider=qdrant, status=✅ connected, vector count, and dimensions

#### Scenario: Qdrant is unreachable
- **WHEN** user runs `npx nano-brain status` and Qdrant is configured but unreachable
- **THEN** status output SHALL include a "Vector Store" section with provider=qdrant, status=❌ unreachable, and the error message

#### Scenario: sqlite-vec is active
- **WHEN** user runs `npx nano-brain status` and sqlite-vec is the vector provider (default)
- **THEN** status output SHALL include a "Vector Store" section with provider=sqlite-vec, status=✅ built-in, and vector count from the local vectors table

#### Scenario: No vector store configured
- **WHEN** user runs `npx nano-brain status` and no vector configuration exists
- **THEN** status output SHALL show provider=sqlite-vec with built-in status (default behavior)

### Requirement: Vector store health check has timeout
The vector store health check SHALL complete within 5 seconds. If the check exceeds the timeout, the status command SHALL report the vector store as unreachable rather than blocking.

#### Scenario: Qdrant health check times out
- **WHEN** Qdrant health check takes longer than 5 seconds
- **THEN** status SHALL display status=❌ unreachable (timeout) and continue displaying remaining status sections

### Requirement: All-workspaces mode includes vector store
The `status --all` command SHALL display a single vector store health summary after the workspace table, since the vector store is shared across workspaces.

#### Scenario: Status --all with Qdrant
- **WHEN** user runs `npx nano-brain status --all` with Qdrant configured
- **THEN** a single "Vector Store" section SHALL appear after the workspace summary table showing provider, status, and total vector count

