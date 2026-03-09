## Context

nano-brain's `serve` command starts an MCP server in daemon mode that serves multiple workspaces. The current implementation has two issues:

1. **Primary workspace selection** (`server.ts:1434-1440`): In daemon mode, `startServer()` always picks `Object.keys(config.workspaces)[0]` — the first workspace listed in `~/.nano-brain/config.yml`. It ignores `process.cwd()`, so starting `serve` from `/path/to/zengamingx` still serves `/path/to/nano-brain` if that's listed first.

2. **code_* tools lack workspace parameter**: `code_context`, `code_impact`, and `code_detect_changes` only resolve workspace from `file_path`. Without it, they fall back to `deps.db` (the primary workspace's symbol database). Memory tools (`memory_search`, `memory_query`, etc.) already have a `workspace` parameter — code tools don't.

The memory tools already handle multi-workspace correctly:
- Line 220: `workspace: z.string().optional()` parameter
- Line 227: `const defaultWorkspace = deps.daemon ? 'all' : currentProjectHash;`
- `resolveWorkspace()` (lines 62-96) can resolve by workspace hash, path, or file path prefix

## Goals / Non-Goals

**Goals:**
- Daemon mode uses `cwd` as primary workspace when it matches a configured workspace
- `code_context`, `code_impact`, `code_detect_changes` accept a `workspace` parameter
- Backward compatible — no breaking changes to existing tool signatures or behavior

**Non-Goals:**
- Multi-workspace symbol search (querying ALL workspace DBs and merging) — too complex, not needed now
- Adding `--root` flag to the `serve` CLI command — cwd detection is sufficient
- Changing how memory tools handle workspace — they already work correctly

## Decisions

### 1. Use cwd-first resolution for daemon primary workspace

**Current** (server.ts:1434):
```typescript
if (daemon && config?.workspaces) {
  resolvedWorkspaceRoot = Object.keys(config.workspaces)[0]; // always first
}
```

**New:**
```typescript
if (daemon && config?.workspaces) {
  const cwd = process.cwd();
  const configuredPaths = Object.keys(config.workspaces);
  resolvedWorkspaceRoot = configuredPaths.includes(cwd)
    ? cwd
    : configuredPaths[0];
}
```

**Rationale:** The user starts `serve` from a specific directory for a reason. If that directory is a configured workspace, use it. Otherwise fall back to first (existing behavior). No config changes needed.

**Alternative considered:** Adding `--root` flag to `serve` command. Rejected because it adds CLI complexity and the cwd convention is more natural — you `cd` into a project and run `serve`.

### 2. Add `workspace` parameter to code_* tools following memory tool pattern

The memory tools use this pattern (line 220-228):
```typescript
workspace: z.string().optional().describe('Filter by workspace hash. Omit for current workspace, "all" for cross-workspace search'),
// ...
const defaultWorkspace = deps.daemon ? 'all' : currentProjectHash;
const effectiveWorkspace = workspace === 'all' ? 'all' : (workspace || defaultWorkspace);
```

For code_* tools, the pattern is slightly different because they need a **single database**, not a filter. The resolution order:

1. Explicit `workspace` param → resolve to that workspace's DB
2. `file_path` param → resolve by longest-prefix match (existing behavior)
3. Neither → use `deps.db` (primary workspace)

**Note:** Unlike memory tools, code_* tools do NOT default to `'all'` in daemon mode. Symbol graphs are per-workspace and merging across workspaces is not supported. The default is the primary workspace.

**Alternative considered:** Defaulting to `'all'` and searching all workspace DBs. Rejected because symbol graph queries are workspace-specific (project hashes, file paths) and merging results across workspaces would produce confusing output.

### 3. Extend `resolveWorkspace()` to return database handle

Currently `resolveWorkspace()` returns a `ResolvedWorkspace` with `store` (document store) but code_* tools need a `Database` handle for the symbol graph. Rather than duplicating resolution logic, we add a `db` field to `ResolvedWorkspace`:

```typescript
export interface ResolvedWorkspace {
  store: Store
  db?: Database.Database  // NEW: symbol graph database handle
  workspaceRoot: string
  projectHash: string
  needsClose: boolean
}
```

This avoids the current pattern of opening a second Database connection after resolveWorkspace (lines 1064-1067).

## Risks / Trade-offs

- **[Risk] cwd may not match any configured workspace** → Mitigation: Fall back to first configured workspace (existing behavior). Log a warning so the user knows.
- **[Risk] Database handle leak in resolveWorkspace** → Mitigation: The existing `needsClose` pattern already handles cleanup. Adding `db` to the return type follows the same lifecycle.
- **[Risk] Spawned daemon loses cwd** → Low risk. Node.js `spawn()` with `detached: true` inherits cwd from parent. Verified in index.ts line 348 — no `cwd` override in spawn options.
