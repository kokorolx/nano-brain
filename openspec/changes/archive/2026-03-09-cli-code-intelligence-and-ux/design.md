## Context

nano-brain's code intelligence features (`code_context`, `code_impact`, `code_detect_changes`) are implemented in `src/symbol-graph.ts` as methods on the `SymbolGraph` class. Currently these are only exposed via MCP tools in `src/server.ts`. The CLI (`src/index.ts`) has no access to them.

The `SymbolGraph` class already has clean handler methods (`handleContext`, `handleImpact`, `handleDetectChanges`) that accept params and return structured results. The CLI just needs thin wrappers that open the database, call these methods, and format output.

Similarly, `status` already queries most tables but skips `code_symbols` and `symbol_edges`. The `indexCodebase` function silently skips symbol graph indexing when `db` is undefined — no warning is logged.

## Goals / Non-Goals

**Goals:**
- Expose `code_context`, `code_impact`, `code_detect_changes` as CLI commands usable without MCP server
- Add `reindex` CLI command for targeted codebase-only reindexing
- Show symbol graph health in `status` output
- Log warnings when symbol graph indexing is skipped

**Non-Goals:**
- Changing MCP tool behavior (MCP tools remain unchanged)
- Adding new code intelligence capabilities (only exposing existing ones)
- Changing the SymbolGraph class internals
- Making the CLI a full replacement for the MCP server

## Decisions

### 1. Reuse SymbolGraph handler methods directly

The `SymbolGraph` class already has `handleContext()`, `handleImpact()`, and `handleDetectChanges()` that return typed result objects. CLI handlers will instantiate `SymbolGraph` with a `Database` instance and call these methods directly.

Alternative: Duplicate the SQL queries in CLI handlers. Rejected — unnecessary duplication.

### 2. CLI command naming

- `context <name>` — maps to `code_context` MCP tool
- `code-impact <target>` — maps to `code_impact` MCP tool (not `impact` which is already taken by cross-repo infrastructure symbols)
- `detect-changes` — maps to `code_detect_changes` MCP tool
- `reindex` — new command, no MCP equivalent

Alternative: Use `code-context` / `code-impact` / `code-detect-changes` for consistency. Chose shorter names since CLI favors brevity, and `context` is unambiguous. `code-impact` keeps the prefix to avoid collision with existing `impact` command.

### 3. Database access pattern

Each CLI handler opens a `Database` instance from `globalOpts.dbPath`, creates a `SymbolGraph`, calls the method, then closes the database. Same pattern used by existing CLI commands like `handleFocus`.

### 4. Output format

All three commands support `--json` flag for machine-readable output. Default is human-readable text. Follows existing CLI conventions (see `handleImpact`, `handleSymbols`).

### 5. Reindex command scope

`reindex` runs only `indexCodebase()` with a `db` parameter, then reports results. It does NOT harvest sessions, index collections, or generate embeddings. For full reindex, use `init`.

## Risks / Trade-offs

- [Risk] CLI opens a separate Database connection while MCP server may also be running → SQLite WAL mode handles concurrent readers safely, no mitigation needed.
- [Risk] `context` command name could conflict with future commands → Low risk, can rename later if needed.
- [Trade-off] `reindex` doesn't embed new chunks → Acceptable, `embed` command exists separately for that.
