## Why

The `serve` daemon uses `process.cwd()` to determine its workspace, locking it to a single directory. When started via shared-mcp-proxy (the standard deployment), it resolves to the proxy's npx cache path — not any real workspace. This causes: wrong database selected, codebase indexing targeting wrong directory, `code_detect_changes` running git diff in wrong directory, `memory_status` showing 0 documents, and all workspace-scoped operations failing silently. The serve command is a global daemon and must serve ALL configured workspaces, not bind to one.

## What Changes

- **BREAKING**: `startServer()` no longer uses `process.cwd()` as workspace root. Instead it operates in a workspace-agnostic "global" mode.
- `ServerDeps` loses its single `workspaceRoot` / `currentProjectHash` binding. Replaced with a multi-workspace resolver that routes to the correct per-workspace database.
- MCP tools that need workspace context (`memory_search`, `memory_vsearch`, `memory_query`, `memory_status`, `memory_index_codebase`, `memory_focus`, `memory_graph_stats`, `code_detect_changes`, `code_context`, `code_impact`) gain workspace resolution — either from an explicit parameter or by searching across all configured workspaces.
- The watcher's codebase indexing loop (already iterates `allWorkspaces` for embedding) is extended to also index codebases and build symbol graphs for all configured workspaces.
- The "global" database (used for shared collections: memory, sessions) is selected deterministically — not based on `process.cwd()`.

## Capabilities

### New Capabilities
- `multi-workspace-routing`: Dynamic workspace resolution for the serve daemon — route MCP tool calls to the correct per-workspace database based on config, tool parameters, or cross-workspace search.

### Modified Capabilities

## Impact

- `src/server.ts`: `startServer()` initialization, `ServerDeps` interface, `createMcpServer()` deps — remove single-workspace binding, add multi-workspace resolver
- `src/watcher.ts`: Extend codebase indexing and graph building to iterate all configured workspaces (embedding loop already does this)
- `src/symbol-graph.ts`: `handleDetectChanges` must accept workspace path dynamically instead of using a fixed `workspaceRoot`
- `src/index.ts`: `handleServe()` / `handleMcp()` — pass workspace config instead of relying on `process.cwd()`
- `src/store.ts`: `openWorkspaceStore()` already exists and is sufficient
- Config: `~/.nano-brain/config.yml` workspaces section already defines per-workspace settings — no config changes needed
