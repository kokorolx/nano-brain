## Context

nano-brain's `serve` command starts a global HTTP daemon (port 3100) that serves MCP tools to any connected client. In production, the shared-mcp-proxy starts it via `npx nano-brain serve --port=3100`, which means `process.cwd()` resolves to the proxy's npx cache directory — not any real workspace.

Currently, `startServer()` in `server.ts:1263` does:
```typescript
const resolvedWorkspaceRoot = process.cwd();
```

This single value flows into: database selection, codebase config, project hash, watcher config, and all MCP tool handlers. The result is that the daemon operates on a phantom workspace (`shared-mcp-proxy-f30222d32423.sqlite`) while the real workspace databases (`Tools-aeedd3af6f8d.sqlite`, `zengamingx-d1915ee19311.sqlite`, etc.) sit unused.

Key existing infrastructure:
- `config.yml` already has a `workspaces` section mapping paths to per-workspace configs
- `openWorkspaceStore(dataDir, workspacePath)` already opens per-workspace databases
- The watcher's embedding loop already iterates `allWorkspaces` for cross-workspace embedding
- MCP search tools already accept a `workspace` parameter ("all" for cross-workspace)

## Goals / Non-Goals

**Goals:**
- The serve daemon operates without binding to any single workspace
- All configured workspaces are indexed, embedded, and searchable
- MCP tools route to the correct per-workspace database automatically
- Workspace-specific tools (codebase, graph, code_detect_changes) work for all configured workspaces
- Zero config changes required — existing `config.yml` workspaces section is sufficient
- Backward compatible: stdio MCP mode (non-daemon) still uses `process.cwd()` as before

**Non-Goals:**
- Dynamic workspace registration at runtime (workspaces are defined in config.yml)
- Per-connection workspace binding (MCP protocol doesn't support this cleanly)
- Changing the shared-mcp-proxy to pass workspace context

## Decisions

### D1: Global database for shared collections, per-workspace databases for codebase

**Decision**: Use a deterministic "global" database for workspace-independent data (memory, sessions collections) and open per-workspace databases on-demand for codebase/graph operations.

**Rationale**: Memory notes and harvested sessions are not workspace-scoped — they're personal knowledge. Codebase data IS workspace-scoped (different repos have different files). The per-workspace databases already exist and contain the right data.

**Alternative considered**: Single mega-database for everything — rejected because it would break the existing per-workspace isolation and require data migration.

**Implementation**: When `daemon=true` (serve mode), use a fixed global database path like `global-{configHash}.sqlite` or simply pick the first configured workspace's DB. For codebase operations, open the target workspace's DB via `openWorkspaceStore()`.

### D2: Workspace resolution strategy for MCP tools

**Decision**: Three-tier resolution:
1. **Explicit parameter**: Tools that accept a `workspace` param use it directly (already exists for search tools)
2. **Path-based inference**: Tools like `memory_focus`, `code_detect_changes` that receive a file path can infer the workspace by matching against configured workspace roots
3. **Cross-workspace default**: Search tools default to `workspace="all"` in daemon mode instead of a single project hash

**Rationale**: This requires minimal API changes. Most search tools already support `workspace="all"`. Path-based inference is natural for file-oriented tools.

**Alternative considered**: Requiring every tool call to pass an explicit workspace — rejected because it would break existing MCP clients and add friction.

### D3: Codebase indexing for all workspaces in the watcher

**Decision**: Extend the watcher's reindex cycle to iterate all configured workspaces (not just the "current" one). Each workspace gets its own `indexCodebase()` call with its own store, config, and project hash.

**Rationale**: The embedding loop already does this pattern (watcher.ts:322-348). Codebase indexing should follow the same pattern.

**Alternative considered**: Separate indexing daemon per workspace — rejected as over-engineered; the watcher already handles multi-workspace embedding.

### D4: ServerDeps becomes workspace-aware

**Decision**: Replace the single `workspaceRoot`/`currentProjectHash` in `ServerDeps` with:
- `allWorkspaces`: the full workspace config map
- `dataDir`: path to the data directory for opening per-workspace stores
- `globalStore`: the store for shared collections (memory, sessions)
- A `resolveWorkspace(filePath?: string)` helper that returns `{ store, workspaceRoot, projectHash }` for a given context

**Rationale**: This is the minimal structural change that enables multi-workspace routing without rewriting every tool handler.

## Risks / Trade-offs

- **[Risk] Multiple open database connections** → Mitigate by opening workspace stores on-demand and closing after use (the `openWorkspaceStore` pattern already does this in the embedding loop)
- **[Risk] Backward compatibility for stdio mode** → Mitigate by keeping `process.cwd()` behavior when `daemon=false` (stdio mode is always workspace-local)
- **[Risk] Performance of cross-workspace search** → Already handled: search tools iterate all workspace stores when `workspace="all"`. No new performance concern.
- **[Trade-off] Path-based workspace inference may fail for files outside configured workspaces** → Acceptable: unconfigured workspaces are explicitly unsupported. Return clear error message.
