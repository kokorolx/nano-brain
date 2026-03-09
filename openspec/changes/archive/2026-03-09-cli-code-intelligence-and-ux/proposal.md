## Why

The code intelligence tools (`code_context`, `code_impact`, `code_detect_changes`) are the most valuable nano-brain features for AI agents, but they're locked behind the MCP server. When the MCP isn't connected — which happens frequently in containerized environments, fresh sessions, or when the server crashes — these tools are completely inaccessible. There's no CLI fallback.

Additionally, the current UX has multiple silent failure modes: symbol graph indexing silently skips when `db` isn't passed, `status` doesn't show symbol counts, and there's no targeted codebase reindex command.

## What Changes

- Add CLI commands for tree-sitter code intelligence: `context`, `code-impact`, `detect-changes`
- Add CLI `reindex` command for targeted codebase-only reindexing (no harvest, no collections)
- Improve `status` output to show `code_symbols` and `symbol_edges` counts plus tree-sitter availability
- Add warning logs when symbol graph indexing is skipped due to missing `db` or unavailable tree-sitter
- Update SKILL.md to document CLI fallbacks for code intelligence tools
- **Fix daemon workspace resolution bug**: `serve`/`mcp --daemon` always picks the first workspace in config.yml instead of respecting cwd or `--root`

## Capabilities

### New Capabilities
- `cli-code-intelligence`: CLI commands (`context`, `code-impact`, `detect-changes`) that expose tree-sitter symbol graph queries without requiring the MCP server
- `cli-reindex`: Targeted `reindex` CLI command that only re-scans codebase files and rebuilds the symbol graph, without touching sessions, collections, or embeddings
- `status-symbol-graph`: Enhanced `status` output showing code_symbols count, symbol_edges count, and tree-sitter availability
- `loud-failure-logging`: Warning logs when symbol graph indexing is silently skipped
- `daemon-workspace-fix`: Fix daemon mode workspace resolution to respect cwd and support `--root` flag

### Modified Capabilities

## Impact

- `src/index.ts` — new CLI command handlers, updated status handler, `--root` flag for serve
- `src/server.ts` — fix daemon workspace resolution logic (lines 1433-1440)
- `src/codebase.ts` — add warning log when `db` is undefined
- `SKILL.md` — document CLI fallbacks for code intelligence
- `src/symbol-graph.ts` — reuse existing `SymbolGraph.handleContext`, `handleImpact`, `handleDetectChanges` methods
