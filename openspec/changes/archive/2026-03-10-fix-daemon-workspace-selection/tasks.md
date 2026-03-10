## 1. Fix daemon startup database selection

- [ ] 1.1 In `server.ts` `startServer()` (line 1434), replace `Object.keys(config.workspaces)[0]` with cwd-first resolution: check if `process.cwd()` is in `config.workspaces`, use it if so, otherwise fall back to first entry
- [ ] 1.2 Log a warning when cwd does not match any configured workspace and falling back to first

## 2. Extend resolveWorkspace to return database handle

- [ ] 2.1 Add optional `db?: Database.Database` field to `ResolvedWorkspace` interface (line 55-60)
- [ ] 2.2 In `resolveWorkspace()`, when resolving to a different workspace, open the database and set `db` on the return value
- [ ] 2.3 When resolving to the current startup workspace, set `db` to `deps.db` with `needsClose: false`

## 3. Create shared daemon workspace guard helper

- [ ] 3.1 Create `requireDaemonWorkspace(deps, workspace)` helper that returns `{ error: string } | { projectHash, workspaceRoot, db?, needsClose }` — encapsulates the "error if missing in daemon mode" pattern
- [ ] 3.2 Helper resolves workspace by path, hash, or 'all' (where applicable)
- [ ] 3.3 Helper returns formatted error with available workspaces list when workspace is missing in daemon mode

## 4. Update search tools (memory_search, memory_vsearch, memory_query)

- [ ] 4.1 In `memory_search` handler (line 225-228), replace `const defaultWorkspace = deps.daemon ? 'all' : currentProjectHash` with daemon workspace guard — error if missing in daemon mode
- [ ] 4.2 Same change for `memory_vsearch` handler (line 261-264)
- [ ] 4.3 Same change for `memory_query` handler (line 332-335)

## 5. Add workspace parameter to code_context

- [ ] 5.1 Add `workspace: z.string().optional()` to `code_context` tool schema (line 1053-1056)
- [ ] 5.2 In daemon mode: if no `workspace` AND no `file_path` → return error with available workspaces. If `file_path` provided → resolve workspace from it (existing behavior).
- [ ] 5.3 Use resolved workspace's DB for symbol graph queries instead of `deps.db`

## 6. Add workspace parameter to code_impact

- [ ] 6.1 Add `workspace: z.string().optional()` to `code_impact` tool schema (line 1166-1171)
- [ ] 6.2 Same daemon workspace guard pattern as code_context
- [ ] 6.3 Use resolved workspace's DB for impact analysis

## 7. Add workspace parameter to code_detect_changes

- [ ] 7.1 Add `workspace: z.string().optional()` to `code_detect_changes` tool schema (line 1288-1289)
- [ ] 7.2 In daemon mode without `workspace` → return error with available workspaces
- [ ] 7.3 When `workspace` is provided, resolve workspace root and database, use for git diff directory
- [ ] 7.4 Remove hardcoded `Object.keys(deps.allWorkspaces)[0]` (line 1301-1302)

## 8. Add workspace parameter to memory_symbols

- [ ] 8.1 Add `workspace: z.string().optional()` to `memory_symbols` tool schema (line 914-917)
- [ ] 8.2 Apply daemon workspace guard — error if missing in daemon mode
- [ ] 8.3 Replace hardcoded `currentProjectHash` (line 926) with resolved workspace hash
- [ ] 8.4 Support `workspace='all'` — query without projectHash filter

## 9. Add workspace parameter to memory_impact

- [ ] 9.1 Add `workspace: z.string().optional()` to `memory_impact` tool schema (line 982-984)
- [ ] 9.2 Apply daemon workspace guard — error if missing in daemon mode
- [ ] 9.3 Replace hardcoded `currentProjectHash` (line 988) with resolved workspace hash

## 10. Add workspace parameter to memory_write

- [ ] 10.1 Add `workspace: z.string().optional()` to `memory_write` tool schema (line 453-456)
- [ ] 10.2 Apply daemon workspace guard — error if missing in daemon mode
- [ ] 10.3 Replace hardcoded `currentProjectHash` and `workspaceRoot` (line 465-466) with resolved workspace values
- [ ] 10.4 Entry header should show correct workspace name and hash

## 11. Add workspace parameter to memory_graph_stats

- [ ] 11.1 Add `workspace: z.string().optional()` to `memory_graph_stats` tool schema (line 831-832)
- [ ] 11.2 Apply daemon workspace guard — error if missing in daemon mode
- [ ] 11.3 When `workspace='all'` → iterate all workspaces (current daemon behavior)
- [ ] 11.4 When specific workspace → return stats for only that workspace

## 12. Update tool descriptions for daemon-aware agents

- [ ] 12.1 Update `workspace` param description on search tools to: `'Workspace path, hash, or "all". Required in daemon mode.'`
- [ ] 12.2 Add `workspace` param description on new tools: `'Workspace path or hash. Required in daemon mode.'`

## 13. Verify

- [ ] 13.1 Start `serve` from zengamingx directory, verify startup log shows `startup workspace = .../zengamingx`
- [ ] 13.2 Call `code_context(name="sellService")` without workspace in daemon mode → should return error with available workspaces
- [ ] 13.3 Call `code_context(name="sellService", workspace="/path/to/zengamingx")` → should find symbol
- [ ] 13.4 Call `memory_search(query="test")` without workspace in daemon mode → should return error
- [ ] 13.5 Call `memory_search(query="test", workspace="all")` → should search all workspaces
- [ ] 13.6 Call `memory_symbols(type="redis_key", workspace="/path/to/zengamingx")` → should query correct workspace
- [ ] 13.7 Call `memory_write(content="test", workspace="/path/to/zengamingx")` → entry should show zengamingx workspace
- [ ] 13.8 Call `code_detect_changes(workspace="/path/to/zengamingx")` → should work with zengamingx git dir
- [ ] 13.9 Verify non-daemon mode (stdio) still works — all tools default to current workspace without requiring `workspace` param
