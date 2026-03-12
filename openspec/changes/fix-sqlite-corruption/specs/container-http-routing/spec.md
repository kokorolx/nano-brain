## ADDED Requirements

### Requirement: Container detection
The CLI SHALL detect when running inside a container via the presence of `/.dockerenv` file.

#### Scenario: Container detected via /.dockerenv
- **WHEN** CLI starts
- **AND** `/.dockerenv` file exists
- **THEN** CLI operates in container mode

#### Scenario: Host detected when no /.dockerenv
- **WHEN** CLI starts
- **AND** `/.dockerenv` file does not exist
- **THEN** CLI operates in host mode

### Requirement: Container CLI routes ALL operations through HTTP
When running in container mode, the CLI SHALL route ALL operations through the daemon HTTP API at `http://host.docker.internal:3100/api/*`.

#### Scenario: Container query goes through HTTP
- **WHEN** `npx nano-brain query "term"` is run in container
- **THEN** request is sent to `http://host.docker.internal:3100/api/query`
- **AND** no direct database access occurs

#### Scenario: Container write goes through HTTP
- **WHEN** `npx nano-brain write "content"` is run in container
- **THEN** request is sent to `http://host.docker.internal:3100/api/write`
- **AND** no direct database access occurs

#### Scenario: Container init goes through HTTP
- **WHEN** `npx nano-brain init` is run in container
- **THEN** request is sent to `http://host.docker.internal:3100/api/init`
- **AND** no direct database access occurs

#### Scenario: Container reindex goes through HTTP
- **WHEN** `npx nano-brain reindex` is run in container
- **THEN** request is sent to `http://host.docker.internal:3100/api/reindex`
- **AND** no direct database access occurs

### Requirement: No direct DB access from container
The CLI in container mode SHALL NOT access SQLite database files directly.

#### Scenario: Container refuses direct DB access
- **WHEN** CLI is in container mode
- **AND** an operation would require direct database access
- **THEN** the operation is routed through HTTP instead
- **AND** no `new Database()` or `openDatabase()` calls are made

### Requirement: Container CLI errors when daemon unreachable
When the daemon is not reachable from a container, the CLI SHALL return a clear error.

#### Scenario: Daemon unreachable from container
- **WHEN** CLI is in container mode
- **AND** `http://host.docker.internal:3100` is not reachable
- **THEN** CLI prints error: "Daemon not running. Start it on the host: npx nano-brain daemon"
- **AND** command exits with non-zero status
- **AND** no fallback to direct DB access is attempted

### Requirement: Host CLI can access DB directly
When running on the host (not in container), the CLI SHALL be permitted to access the database directly.

#### Scenario: Host CLI direct access
- **WHEN** CLI is in host mode
- **AND** daemon is not running
- **THEN** CLI can access database files directly via openDatabase()

#### Scenario: Host CLI prefers daemon when running
- **WHEN** CLI is in host mode
- **AND** daemon is detected running
- **THEN** CLI routes through HTTP for coordination
- **OR** CLI uses maintenance endpoints for destructive operations
