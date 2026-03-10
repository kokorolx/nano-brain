## Context

nano-brain's `serve` command starts an MCP server in daemon mode that serves multiple workspaces. The current implementation has a systemic issue: **most tools are broken in daemon mode** because they either hardcode `currentProjectHash` or silently default to searching all workspaces.

1. **Startup workspace selection** (`server.ts:1434-1440`): Always picks `Object.keys(config.workspaces)[0]` — ignores `process.cwd()`.

2. **10 tools lack proper daemon-mode workspace handling:**
   - `code_context`, `code_impact`, `code_detect_changes` — use startup workspace DB, no `workspace` param
   - `memory_symbols`, `memory_impact` — hardcode `currentProjectHash`
   - `memory_write` — stamps entries with `currentProjectHash`
   - `memory_search`, `memory_vsearch`, `memory_query` — silently default to `'all'`
   - `memory_graph_stats` — iterates all workspaces (OK but inconsistent)

Since the daemon serves multiple AI agent sessions from different workspaces, there's no way to auto-detect the caller's workspace. The agent already knows its cwd, so the fix is simple: **require `workspace` param in daemon mode, error if missing.**

## Goals / Non-Goals

**Goals:**
- Daemon mode startup uses `cwd` when it matches a configured workspace
- ALL 10 workspace-scoped tools require `workspace` param in daemon mode
- Missing `workspace` in daemon mode → error with available workspaces list (agent self-corrects)
- Non-daemon mode (stdio) unchanged — defaults to cwd workspace
- Backward compatible for non-daemon users

**Non-Goals:**
- Auto-detecting workspace from MCP protocol roots — unnecessary complexity
- Adding `--root` flag to `serve` CLI — cwd detection is sufficient
- Multi-workspace symbol search (searching ALL DBs and merging) — not needed, explicit is better

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

### 2. Require `workspace` parameter in daemon mode for ALL workspace-scoped tools

**Universal pattern for daemon mode:**
```typescript
// At the top of every workspace-scoped tool handler:
if (deps.daemon && !workspace) {
  const available = Object.keys(deps.allWorkspaces || {})
    .map(p => `  - ${path.basename(p)} (${crypto.createHash('sha256').update(p).digest('hex').substring(0, 12)}) — ${p}`)
    .join('\n')
  return {
    content: [{ type: 'text', text: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${available}` }],
    isError: true,
  }
}
const effectiveWorkspace = workspace || currentProjectHash  // non-daemon fallback
```

**Workspace param accepts:** a path (`/path/to/zengamingx`), a hash (`d1915ee19311`), or `'all'` (for search/query tools only — searches all workspaces).

**Tool categories:**

| Category | Tools | `workspace` accepts | Notes |
|----------|-------|-------------------|-------|
| Search | `memory_search`, `memory_vsearch`, `memory_query` | path, hash, `'all'` | Change: error instead of defaulting to `'all'` |
| Code | `code_context`, `code_impact` | path, hash | Also accepts `file_path` for resolution |
| Code (git) | `code_detect_changes` | path, hash | Needs specific directory for git diff |
| Cross-repo | `memory_symbols`, `memory_impact` | path, hash, `'all'` | Currently hardcodes `currentProjectHash` |
| Write | `memory_write` | path, hash | Stamps entry with correct workspace |
| Graph | `memory_graph_stats` | path, hash, `'all'` | Currently iterates all in daemon |

**Non-daemon mode (stdio):** `workspace` param is optional, defaults to `currentProjectHash`. No behavior change.

**Alternative considered:** Auto-searching all workspaces when `workspace` is missing. Rejected — the user explicitly decided that implicit behavior is confusing. Explicit `workspace` param with helpful error is simpler and more reliable.

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
- **[Risk] Breaking change for search tools** → Search tools (`memory_search/vsearch/query`) currently default to `'all'` in daemon mode. After this change, they'll error if `workspace` is missing. This is intentional — agents must be updated to pass `workspace`. The error message lists available workspaces, so agents self-correct on first call.
- **[Risk] `memory_write` workspace mismatch** → Currently stamps entries with startup workspace hash. After fix, entries get stamped with the correct workspace. Old entries remain with wrong hash — acceptable, not worth migrating.
