## 1. ServerDeps Multi-Workspace Interface

- [x] 1.1 Add `allWorkspaces`, `dataDir`, and `daemon` fields to `ServerDeps` interface in `server.ts`
- [x] 1.2 Add `resolveWorkspace(filePath?: string)` helper function that returns `{ store, workspaceRoot, projectHash }` — uses three-tier resolution: explicit param → path-based inference → cross-workspace default
- [x] 1.3 Refactor `startServer()` initialization (lines 1263-1349): when `daemon=true`, skip `process.cwd()` binding — set `workspaceRoot` to empty string, load all workspace configs from `config.yml`, open global store for shared collections

## 2. MCP Tool Handlers — Workspace Routing

- [x] 2.1 Update `memory_status` handler to aggregate stats across all configured workspaces in daemon mode (codebase docs, graph stats) instead of reporting from a single workspace store
- [x] 2.2 Update `memory_index_codebase` handler to resolve workspace from `root` parameter and open the correct per-workspace store
- [x] 2.3 Update `memory_focus` handler to resolve workspace from `filePath` parameter via path-based inference
- [x] 2.4 Update `memory_graph_stats` handler to aggregate graph data across all workspace stores in daemon mode
- [x] 2.5 Update `code_detect_changes` handler to resolve workspace from params and run git diff in the correct workspace directory
- [x] 2.6 Update `code_context` and `code_impact` handlers to resolve workspace from `file_path` parameter
- [x] 2.7 Update search tools (`memory_search`, `memory_vsearch`, `memory_query`) to default `workspace` to `"all"` in daemon mode when no explicit workspace filter is provided

## 3. Watcher — Multi-Workspace Codebase Indexing

- [x] 3.1 Extend `triggerReindex()` in `watcher.ts` to iterate all configured workspaces with `codebase.enabled: true` — open per-workspace store, call `indexCodebase()`, close store (same pattern as embedding loop at lines 322-348)
- [x] 3.2 Extend symbol graph building in the reindex cycle to cover all configured workspaces (not just the single `workspaceRoot`)

## 4. CLI Entry Points

- [x] 4.1 Update `handleServe()` in `index.ts` to pass `daemon: true` and workspace config to `startServer()` instead of relying on `process.cwd()`
- [x] 4.2 Ensure `handleMcp()` (stdio mode) continues to use `process.cwd()` as workspace root — backward compatibility
- [x] 4.3 Skip early `resolveDbPath(dbPath, process.cwd())` in `main()` for daemon mode — prevents dbPath from being resolved with wrong cwd before `startServer()` can use the correct workspace root

## 5. Verification

- [x] 5.1 Run `lsp_diagnostics` on all changed files — zero type errors
- [x] 5.2 Build the project (`npm run build`) — exit code 0 (note: pre-existing errors in bench.ts and treesitter.ts unrelated to this change)
- [x] 5.3 Start `nano-brain serve --port=3100` from a non-workspace directory and verify it starts without errors
- [x] 5.4 Call `memory_status` via MCP and verify it shows real workspace data (not 0 documents)
