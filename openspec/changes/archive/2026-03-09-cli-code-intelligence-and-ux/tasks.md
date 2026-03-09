## 1. CLI Code Intelligence Commands

- [x] 1.1 Add `handleContext` CLI handler in `src/index.ts` — parse `--file`, `--json` flags, open Database, call `SymbolGraph.handleContext()`, format and print result
- [x] 1.2 Add `handleCodeImpact` CLI handler in `src/index.ts` — parse `--direction`, `--max-depth`, `--min-confidence`, `--file`, `--json` flags, call `SymbolGraph.handleImpact()`
- [x] 1.3 Add `handleDetectChanges` CLI handler in `src/index.ts` — parse `--scope`, `--json` flags, call `SymbolGraph.handleDetectChanges()`
- [x] 1.4 Register `context`, `code-impact`, `detect-changes` in the CLI command switch statement
- [x] 1.5 Add empty symbol graph warning check — query `code_symbols` count before each command, print warning if 0
- [x] 1.6 Update `showHelp()` to document the three new commands

## 2. CLI Reindex Command

- [x] 2.1 Add `handleReindex` CLI handler — parse `--root` flag, open store + Database, call `indexCodebase()` with db, print file and symbol graph stats
- [x] 2.2 Register `reindex` in the CLI command switch statement
- [x] 2.3 Update `showHelp()` to document the reindex command

## 3. Status Symbol Graph Enhancement

- [x] 3.1 Add "Code Intelligence" section to `handleStatus` — query code_symbols count, symbol_edges count, execution_flows count, check `isTreeSitterAvailable()`
- [x] 3.2 Show actionable message when symbol graph is empty ("run `nano-brain reindex`")

## 4. Loud Failure Logging

- [x] 4.1 Add warning log in `indexCodebase()` when `db` is undefined but tree-sitter is available
- [x] 4.2 Add warning log in `indexCodebase()` when `db` is provided but tree-sitter is not available

## 5. Tests and Verification

- [x] 5.1 Add CLI tests for `context`, `code-impact`, `detect-changes` commands in `test/cli.test.ts`
- [x] 5.2 Add CLI test for `reindex` command
- [x] 5.3 Run full test suite (`npx vitest run`) — all tests pass (900/900)
- [x] 5.4 Run `lsp_diagnostics` on all changed files — no errors

## 6. Daemon Workspace Fix

- [x] 6.1 Fix server.ts daemon workspace resolution — check cwd against config workspaces before falling back to first
- [x] 6.2 Add `root?: string` to `ServerOptions` interface
- [x] 6.3 Add `--root` flag to `handleMcp` (forward to startServer)
- [x] 6.4 Add `--root` flag to `handleServe` (forward to spawned child process)
