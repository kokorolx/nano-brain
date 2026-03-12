## Why

The file watcher burns excessive Voyage AI embedding tokens during active coding sessions. On March 11, 2026, nano-brain consumed 10M+ embedding tokens in a single morning — 374 reindex events in 5 hours, each scanning all 6 configured workspaces regardless of which workspace had changes. Files being actively edited by AI agents get re-embedded repeatedly because there is no quiet period before embedding and no cooldown between reindexes.

## What Changes

- Add a global reindex cooldown (default 10 minutes) — `triggerReindex()` skips if a reindex completed within the cooldown window
- Add an embedding quiet period (default 60 seconds) — embedding cycle skips if file changes occurred within the quiet window, preventing re-embedding files mid-edit
- Add `force` parameter to `triggerReindex()` so manual `memory_update` / `npx nano-brain update` bypasses the cooldown
- Add `/tmp/**` to `BUILTIN_EXCLUDE_PATTERNS` to prevent indexing repos cloned by pr-review-code
- Add configurable `reindexCooldownMs` and `embedQuietPeriodMs` to `WatcherConfig`
- Log all cooldown/quiet-period skips for observability
- Add startup warning when overlapping workspaces are detected (e.g., ShareX/ and ShareX/src/)

## Capabilities

### New Capabilities
- `reindex-throttling`: Global cooldown between reindexes and embedding quiet period to prevent token waste during active editing sessions

### Modified Capabilities
- `cli-reindex`: The `memory_update` MCP tool and `npx nano-brain update` CLI must bypass the reindex cooldown via a `force` flag

## Impact

- **Files changed**: `src/watcher.ts`, `src/codebase.ts`, `src/types.ts`, `src/server.ts` (config passthrough)
- **Config**: New optional fields in `WatcherConfig` — backward compatible (defaults apply)
- **Behavior**: Reindex frequency drops from ~1/minute to ~1/10min during active sessions. Embedding delayed by 60s after last file change. No impact on search quality (FTS still works, embeddings catch up when editing stops).
- **No breaking changes**
