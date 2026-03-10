# workspace-scoping Delta Specification

## Core Rule

In daemon mode, ALL workspace-scoped tools SHALL require a `workspace` parameter. If `workspace` is not provided in daemon mode, the tool SHALL return an error listing available workspaces (path, hash, basename). In non-daemon mode (stdio), `workspace` is optional and defaults to the current workspace.

The `workspace` parameter accepts: a workspace path (`/path/to/zengamingx`), a workspace hash (`d1915ee19311`), or `'all'` (for search/query tools only).

## ADDED Requirements

---

### Requirement: Daemon mode requires workspace parameter (universal)

#### Scenario: workspace not provided in daemon mode

- **WHEN** any workspace-scoped tool is called without `workspace` in daemon mode
- **THEN** the tool SHALL return `isError: true` with message: "workspace parameter is required in daemon mode. Available workspaces:\n  - {basename} ({hash}) — {path}\n  ..."
- **THEN** the tool SHALL list ALL configured workspaces

#### Scenario: workspace parameter does not match any configured workspace

- **WHEN** any workspace-scoped tool is called with `workspace="nonexistent"`
- **THEN** the tool SHALL return `isError: true` with message: "Workspace not found: nonexistent. Available workspaces: ..."
- **THEN** the tool SHALL list available workspace paths and hashes

#### Scenario: workspace not provided in non-daemon mode (stdio)

- **WHEN** any workspace-scoped tool is called without `workspace` in non-daemon mode
- **THEN** the tool SHALL use `currentProjectHash` (same as today, no change)

---

### Requirement: memory_search, memory_vsearch, memory_query require workspace in daemon mode

These 3 search tools already have a `workspace` parameter. The change is: in daemon mode, they SHALL error if `workspace` is not provided (instead of silently defaulting to `'all'`).

#### Scenario: workspace provided in daemon mode

- **WHEN** `memory_search` is called with `workspace="d1915ee19311"` in daemon mode
- **THEN** the tool SHALL search only that workspace's documents

#### Scenario: workspace='all' in daemon mode

- **WHEN** `memory_search` is called with `workspace="all"` in daemon mode
- **THEN** the tool SHALL search across all workspaces (existing behavior preserved)

#### Scenario: workspace not provided in daemon mode

- **WHEN** `memory_search` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: code_context accepts workspace parameter

The `code_context` MCP tool SHALL accept an optional `workspace` parameter (string).

#### Scenario: workspace parameter specifies a workspace path

- **WHEN** `code_context` is called with `workspace="/path/to/zengamingx"` and `name="sellService"`
- **THEN** the tool SHALL open the zengamingx workspace's symbol graph database
- **THEN** the tool SHALL query symbols from that database
- **THEN** the database handle SHALL be closed after the query completes

#### Scenario: workspace parameter specifies a workspace hash

- **WHEN** `code_context` is called with `workspace="d1915ee19311"` and `name="sellService"`
- **THEN** the tool SHALL resolve the hash to the matching workspace path
- **THEN** the tool SHALL open that workspace's symbol graph database

#### Scenario: workspace parameter not provided, file_path provided

- **WHEN** `code_context` is called with `name="sellService"` and `file_path="/path/to/zengamingx/src/service.js"`
- **AND** no `workspace` parameter is provided
- **THEN** the tool SHALL resolve workspace from `file_path` using longest-prefix match (existing behavior)
- **NOTE** In daemon mode, `file_path` alone satisfies the workspace requirement (workspace is inferred)

#### Scenario: neither workspace nor file_path provided in daemon mode

- **WHEN** `code_context` is called with only `name="sellService"` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

#### Scenario: neither workspace nor file_path provided in non-daemon mode

- **WHEN** `code_context` is called with only `name="sellService"` in non-daemon mode (stdio)
- **THEN** the tool SHALL use the current workspace's symbol graph database (same as today)

---

### Requirement: code_impact accepts workspace parameter

The `code_impact` MCP tool SHALL accept an optional `workspace` parameter with identical resolution behavior as `code_context` (including `file_path` fallback).

#### Scenario: workspace parameter resolves to different workspace

- **WHEN** `code_impact` is called with `workspace="/path/to/zengamingx"` and `target="processPayment"`
- **THEN** the tool SHALL query the zengamingx workspace's symbol graph database

#### Scenario: workspace not provided in daemon mode

- **WHEN** `code_impact` is called without `workspace` or `file_path` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: code_detect_changes accepts workspace parameter

The `code_detect_changes` MCP tool SHALL accept an optional `workspace` parameter.

#### Scenario: workspace parameter specifies a workspace

- **WHEN** `code_detect_changes` is called with `workspace="/path/to/zengamingx"`
- **THEN** the tool SHALL use `/path/to/zengamingx` as the git working directory
- **THEN** the tool SHALL query the zengamingx workspace's symbol graph database

#### Scenario: workspace not provided in daemon mode

- **WHEN** `code_detect_changes` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: memory_symbols accepts workspace parameter

The `memory_symbols` MCP tool SHALL accept an optional `workspace` parameter. Currently hardcodes `currentProjectHash` (line 926).

#### Scenario: workspace provided

- **WHEN** `memory_symbols` is called with `workspace="/path/to/zengamingx"`
- **THEN** the tool SHALL query symbols with that workspace's project hash

#### Scenario: workspace='all'

- **WHEN** `memory_symbols` is called with `workspace="all"`
- **THEN** the tool SHALL query symbols across all workspaces (no projectHash filter)

#### Scenario: workspace not provided in daemon mode

- **WHEN** `memory_symbols` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: memory_impact accepts workspace parameter

The `memory_impact` MCP tool SHALL accept an optional `workspace` parameter. Currently hardcodes `currentProjectHash` (line 988).

#### Scenario: workspace provided

- **WHEN** `memory_impact` is called with `workspace="/path/to/zengamingx"` and `type="redis_key"` and `pattern="sinv:*"`
- **THEN** the tool SHALL query symbol impact with that workspace's project hash

#### Scenario: workspace not provided in daemon mode

- **WHEN** `memory_impact` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: memory_write accepts workspace parameter

The `memory_write` MCP tool SHALL accept an optional `workspace` parameter. Currently stamps entries with `currentProjectHash` (line 466).

#### Scenario: workspace provided

- **WHEN** `memory_write` is called with `workspace="/path/to/zengamingx"` and `content="..."`
- **THEN** the entry SHALL be stamped with the zengamingx workspace hash and name
- **THEN** the entry header SHALL show `**Workspace:** zengamingx (d1915ee19311)`

#### Scenario: workspace not provided in daemon mode

- **WHEN** `memory_write` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: memory_graph_stats accepts workspace parameter

The `memory_graph_stats` MCP tool SHALL accept an optional `workspace` parameter. Currently has no params and iterates all workspaces in daemon mode.

#### Scenario: workspace provided

- **WHEN** `memory_graph_stats` is called with `workspace="/path/to/zengamingx"`
- **THEN** the tool SHALL return graph stats for only that workspace

#### Scenario: workspace='all'

- **WHEN** `memory_graph_stats` is called with `workspace="all"`
- **THEN** the tool SHALL iterate all workspaces and return combined stats (current daemon behavior)

#### Scenario: workspace not provided in daemon mode

- **WHEN** `memory_graph_stats` is called without `workspace` in daemon mode
- **THEN** the tool SHALL return error listing available workspaces

---

### Requirement: resolveWorkspace returns database handle

The `resolveWorkspace()` function SHALL return an optional `db` field (`Database.Database`) on the `ResolvedWorkspace` interface.

#### Scenario: Resolved to a different workspace

- **WHEN** `resolveWorkspace()` resolves to workspace B (not the startup workspace)
- **THEN** the returned `ResolvedWorkspace` SHALL include `db` pointing to workspace B's database
- **THEN** `needsClose` SHALL be `true`

#### Scenario: Resolved to the startup workspace

- **WHEN** `resolveWorkspace()` resolves to the startup workspace
- **THEN** the returned `ResolvedWorkspace` SHALL include `db` pointing to `deps.db`
- **THEN** `needsClose` SHALL be `false`
