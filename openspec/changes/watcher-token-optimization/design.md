## Context

nano-brain's file watcher (`src/watcher.ts`) monitors 6 configured workspaces via chokidar. Any file change sets a `dirty` flag, and three independent timers trigger reindexing/embedding:

- **Poll interval** (5 min): checks `dirty` → calls `triggerReindex()`
- **Session poll** (2 min): harvests sessions → calls `triggerReindex()` if new sessions found
- **Embed cycle** (60s, adaptive): calls `embedPendingCodebase()` for ALL workspaces

`triggerReindex()` scans ALL collections and ALL workspaces sequentially, then embeds. There is no cooldown between runs — only an `isReindexing` mutex prevents concurrent execution.

Content hash dedup (SHA-256) correctly skips unchanged files during indexing. Embedding dedup (`WHERE cv.hash IS NULL`) correctly skips already-embedded content. The token burn comes from the sheer frequency of reindex+embed cycles during active coding sessions (374 reindexes in 5 hours on March 11, 2026).

## Goals / Non-Goals

**Goals:**
- Reduce embedding token consumption by 90%+ during active coding sessions
- Add configurable cooldown between reindexes (default 10 min)
- Add configurable embedding quiet period (default 60s after last file change)
- Allow manual reindex to bypass cooldown
- Add `/tmp` to default exclude patterns
- Log all throttling decisions for observability
- Warn on startup about overlapping workspace configurations

**Non-Goals:**
- Per-workspace cooldowns (v2 — requires refactoring `triggerReindex()` to be workspace-aware)
- Incremental reindex — only scanning the changed workspace (v2)
- Embedding queue prioritization (v2)
- Duplicate workspace auto-fix (document only)

## Decisions

### D1: Global cooldown via timestamp check in `triggerReindex()`

**Approach:** Add a simple `Date.now() - lastReindexAt < cooldownMs` guard at the top of `triggerReindex()`, after the existing `isReindexing` check. Skip with a log message if within cooldown.

**Why not per-workspace:** `triggerReindex()` is inherently global — it iterates ALL collections and ALL workspaces in a single function. Making it workspace-aware requires splitting it into per-workspace functions, which is a larger refactor deferred to v2.

**Why not rate limiting:** A simple timestamp comparison is sufficient and follows the existing guard pattern (`isReindexing`). No need for token bucket or sliding window.

**Alternatives considered:**
- Debounce the reindex trigger itself → Rejected: the 2s debounce already exists but only delays `onUpdate`, not the reindex
- Reduce poll intervals → Rejected: doesn't prevent session-harvest-triggered reindexes

### D2: Embedding quiet period via `lastFileChangeAt` timestamp

**Approach:** Track `lastFileChangeAt` in `handleFileChange()`. In the embed cycle, check `Date.now() - lastFileChangeAt < quietPeriodMs` before calling `embedPendingCodebase()`. If within quiet period, skip and reschedule.

**Why embedding only, not reindex:** Reindexing is cheap (local file reads + SHA-256 hash compare). Embedding is expensive (Voyage AI API calls = tokens). Throttling reindex via cooldown is sufficient; embedding needs the additional quiet period to avoid re-embedding files mid-edit.

**Why global, not per-workspace:** Simpler implementation. Any file change in any workspace resets the quiet period for all. Acceptable because the quiet period is short (60s) and the cost of a false skip is just a 60s delay.

### D3: Force bypass via parameter

**Approach:** Add `force?: boolean` parameter to `triggerReindex()`. When `force=true`, skip the cooldown check. Wire this through the `memory_update` MCP tool handler and `npx nano-brain update` CLI command.

**Why:** Users expect manual commands to work immediately. The cooldown is for automatic triggers only.

### D4: `/tmp` exclusion as absolute path pattern

**Approach:** Add `/tmp/**` to `BUILTIN_EXCLUDE_PATTERNS` in `codebase.ts`. This is a glob pattern consumed by `fast-glob` and converted to regex for chokidar.

**Why absolute path:** The existing `**/tmp/**` pattern (line 128) matches relative `tmp/` dirs inside projects. `/tmp/**` matches the filesystem root `/tmp` where pr-review-code clones repos.

### D5: Overlapping workspace detection on startup

**Approach:** After loading workspace configs, check if any workspace path is a prefix of another. Log a warning if detected.

**Why not auto-fix:** Config is user-owned. We warn, they decide.

## Interaction Model

Cooldown and quiet period are **independent** checks on different operations:
- **Cooldown** gates `triggerReindex()` — prevents frequent full-workspace scans
- **Quiet period** gates `embedPendingCodebase()` — prevents embedding files mid-edit

They don't interact. A reindex can proceed while the quiet period is active (reindex is cheap, embedding is expensive). Embedding can proceed while cooldown is active (embed cycle runs independently of reindex).

## Risks / Trade-offs

- **Stale search results during cooldown** → Acceptable: FTS still works on existing index. Max 10 min stale. Embeddings catch up when editing stops.
- **Session harvest delayed by cooldown** → Acceptable: Sessions are on disk, just not indexed for up to 10 min. Session poll still harvests files to disk.
- **Long edit session delays embeddings indefinitely** → By design: FTS covers search during editing. Embeddings are for semantic search quality, not real-time.
- **Quiet period resets on ANY file change globally** → Acceptable for v1. Per-workspace tracking is v2.
- **Force bypass could be abused by automated tools** → Low risk: only manual CLI/MCP triggers use force.

## Open Questions

None — all design decisions resolved during Metis/Oracle analysis.
