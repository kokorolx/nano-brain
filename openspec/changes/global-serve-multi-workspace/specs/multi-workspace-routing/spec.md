## ADDED Requirements

### Requirement: Daemon mode SHALL NOT use process.cwd() for workspace resolution
The serve daemon (`nano-brain serve`) SHALL NOT use `process.cwd()` to determine the active workspace. When running in daemon mode (HTTP server), the daemon SHALL operate as a workspace-agnostic global service that derives workspace context from config and tool parameters.

#### Scenario: Daemon started from arbitrary directory
- **WHEN** `nano-brain serve --port=3100` is started from `/tmp` or any non-workspace directory
- **THEN** the daemon SHALL start successfully and serve all configured workspaces from `config.yml`

#### Scenario: Daemon started via shared-mcp-proxy npx cache
- **WHEN** the daemon is started by shared-mcp-proxy (cwd = proxy's npx cache path)
- **THEN** the daemon SHALL NOT create or use a database named after the proxy cache directory
- **AND** the daemon SHALL use the global database for shared collections and per-workspace databases for codebase operations

### Requirement: Global database for shared collections
The daemon SHALL use a deterministic global database for workspace-independent collections (memory, sessions). This database SHALL NOT be derived from `process.cwd()`.

#### Scenario: Memory search in daemon mode
- **WHEN** a client calls `memory_search` or `memory_query` without a workspace filter
- **THEN** the daemon SHALL search across all workspace databases (equivalent to `workspace="all"`)

#### Scenario: Session harvesting data accessible
- **WHEN** sessions have been harvested into the sessions collection
- **THEN** the daemon SHALL be able to query harvested sessions regardless of which directory it was started from

### Requirement: Per-workspace database routing for codebase operations
Codebase-scoped operations (indexing, graph queries, focus, detect changes) SHALL route to the correct per-workspace database based on workspace resolution.

#### Scenario: Codebase index for specific workspace
- **WHEN** a client calls `memory_index_codebase` with a `root` parameter matching a configured workspace path
- **THEN** the daemon SHALL open that workspace's database and index files from that workspace root

#### Scenario: Code detect changes with file path
- **WHEN** a client calls `code_detect_changes` and the workspace root is resolved
- **THEN** the daemon SHALL run `git diff` in the resolved workspace directory, not in `process.cwd()`

#### Scenario: Memory focus with file path
- **WHEN** a client calls `memory_focus` with a `filePath` under a configured workspace root
- **THEN** the daemon SHALL resolve the workspace from the file path and query that workspace's graph database

### Requirement: Three-tier workspace resolution
The daemon SHALL resolve workspace context using a three-tier strategy in order of priority:

1. **Explicit parameter**: If the tool call includes a `workspace` or `root` parameter, use it directly
2. **Path-based inference**: If the tool call includes a `filePath` parameter, match it against configured workspace roots
3. **Cross-workspace default**: If no workspace can be determined, default to searching across all configured workspaces

#### Scenario: Explicit workspace parameter takes priority
- **WHEN** a client calls `memory_search` with `workspace="abc123"` (a specific project hash)
- **THEN** the daemon SHALL search only that workspace's database

#### Scenario: File path infers workspace
- **WHEN** a client calls `memory_focus` with `filePath="/Users/tamlh/workspaces/self/AI/Tools/nano-brain/src/server.ts"`
- **AND** the config has a workspace with root `/Users/tamlh/workspaces/self/AI/Tools`
- **THEN** the daemon SHALL resolve to the `Tools` workspace

#### Scenario: No workspace context defaults to cross-workspace
- **WHEN** a client calls `memory_query` with no workspace filter and no file path
- **THEN** the daemon SHALL search across all configured workspaces

#### Scenario: File path outside all configured workspaces
- **WHEN** a client calls `memory_focus` with a file path that does not fall under any configured workspace root
- **THEN** the daemon SHALL return a clear error indicating the workspace could not be resolved

### Requirement: Watcher indexes all configured workspaces
The watcher's codebase indexing cycle SHALL iterate all configured workspaces that have `codebase.enabled: true`, indexing each workspace's files into its respective per-workspace database.

#### Scenario: Multiple workspaces with codebase enabled
- **WHEN** the watcher runs its reindex cycle
- **AND** config.yml has 3 workspaces with `codebase.enabled: true`
- **THEN** the watcher SHALL index all 3 workspaces, each into their own per-workspace database

#### Scenario: Workspace with codebase disabled
- **WHEN** the watcher runs its reindex cycle
- **AND** a workspace has `codebase.enabled: false` or no codebase config
- **THEN** the watcher SHALL skip codebase indexing for that workspace

### Requirement: Symbol graph built for all configured workspaces
The watcher SHALL build and maintain symbol graphs for all configured workspaces that have codebase enabled, not just the workspace matching `process.cwd()`.

#### Scenario: Graph stats reflect all workspaces
- **WHEN** a client calls `memory_graph_stats` after the watcher has completed a cycle
- **THEN** the response SHALL include graph data from all indexed workspaces

### Requirement: Backward compatibility for stdio mode
When running in stdio mode (non-daemon, e.g., `nano-brain mcp` invoked directly by a single client), the system SHALL continue to use `process.cwd()` as the workspace root, preserving existing behavior.

#### Scenario: Stdio mode uses cwd
- **WHEN** `nano-brain mcp` is invoked from `/Users/tamlh/workspaces/self/AI/Tools`
- **THEN** the MCP server SHALL use `/Users/tamlh/workspaces/self/AI/Tools` as the workspace root
- **AND** behavior SHALL be identical to the current implementation

### Requirement: memory_status reflects correct workspace data
The `memory_status` tool SHALL report accurate statistics for the resolved workspace, not for a phantom workspace derived from `process.cwd()`.

#### Scenario: Status in daemon mode shows real data
- **WHEN** a client calls `memory_status` in daemon mode
- **THEN** the response SHALL show document counts, graph stats, and collection info from the actual configured workspaces
- **AND** SHALL NOT show 0 documents when data exists in per-workspace databases
