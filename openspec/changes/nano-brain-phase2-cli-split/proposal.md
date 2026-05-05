## Why

`src/index.ts` is a 3,988-line monolith containing 29 CLI command handlers, shared utilities, and the main dispatch loop — making it impossible to read, test, or modify a single command without scrolling through thousands of lines of unrelated code. Phase 1 split `store.ts`; Phase 2 applies the same discipline to the CLI layer.

## What Changes

- `src/index.ts` is split into `src/cli/commands/<command>.ts` — one file per handler
- Shared CLI utilities (proxy helpers, container detection, port resolution) move to `src/cli/utils.ts`
- Global option parsing and types move to `src/cli/types.ts`
- The dispatch `main()` loop moves to `src/cli/index.ts`
- `src/index.ts` becomes a thin 3-line barrel shim re-exporting from `src/cli/index.ts` (identical pattern to Phase 1 `src/store.ts` shim)
- No behavior changes — pure structural refactor

## Capabilities

### New Capabilities

- `cli-command-modules`: Each of the 29 CLI commands lives in its own file under `src/cli/commands/`. Commands are: `init`, `update`, `embed`, `reindex`, `write`, `reset`, `rm`, `search`, `get`, `focus`, `context`, `symbols`, `impact`, `code-impact`, `graph-stats`, `detect-changes`, `collection`, `tags`, `harvest`, `wake-up`, `status`, `cache`, `mcp`, `logs`, `qdrant`, `docker`, `categorize-backfill`, `consolidate`, `learning`.

### Modified Capabilities

- `cli-reindex`: `handleReindex` moves from `src/index.ts` to `src/cli/commands/reindex.ts` — no behavior change, import path changes internally.
- `cli-code-intelligence`: `handleSymbols`, `handleImpact`, `handleCodeImpact`, `handleContext`, `handleDetectChanges`, `handleFocus`, `handleGraphStats` move to `src/cli/commands/` — no behavior change.

## Impact

- **Files added**: `src/cli/index.ts`, `src/cli/types.ts`, `src/cli/utils.ts`, `src/cli/commands/*.ts` (29 files)
- **Files modified**: `src/index.ts` (becomes thin shim, ~3 lines)
- **No public API changes**: CLI binary entrypoint unchanged, all `npx nano-brain <cmd>` invocations unaffected
- **No import changes for external consumers**: barrel shim preserves all existing import paths
- **Tests**: No test changes required — handlers are tested indirectly via CLI integration tests
