## 1. Config & Types

- [x] 1.1 Add `reindexCooldownMs` and `embedQuietPeriodMs` to `WatcherConfig` in `src/types.ts`
- [x] 1.2 Add `reindexCooldownMs` and `embedQuietPeriodMs` to `WatcherOptions` interface in `src/watcher.ts` (lines 15-34)
- [x] 1.3 Wire new config fields through `src/server.ts` where `startWatcher()` is called (pass from config to options)
- [x] 1.4 Destructure new options with defaults in `startWatcher()`: `reindexCooldownMs = 600000, embedQuietPeriodMs = 60000`

## 2. Global Reindex Cooldown

- [x] 2.1 Add cooldown guard at top of `triggerReindex()`: skip if `lastReindexAt && Date.now() - lastReindexAt < reindexCooldownMs` and `force !== true`. Log skip with remaining time. (Uses existing `lastReindexAt` state variable at line 78)
- [x] 2.2 Add `force?: boolean` parameter to `triggerReindex()` function signature and the public `Watcher.triggerReindex()` interface
- [x] 2.3 Wire `force=true` through `memory_update` MCP tool handler in `src/server.ts` — N/A: `memory_update` does inline indexing, doesn't use watcher's `triggerReindex()`, already bypasses cooldown by design
- [x] 2.4 Wire `force=true` through `npx nano-brain update` CLI command handler — N/A: CLI `handleUpdate()` in `src/index.ts` does inline indexing, already bypasses cooldown by design

## 3. Embedding Quiet Period

- [x] 3.1 Add `lastFileChangeAt: number = 0` state variable in `startWatcher()` (near line 78 in `watcher.ts`)
- [x] 3.2 Update `handleFileChange()` to set `lastFileChangeAt = Date.now()` on every file change
- [x] 3.3 Add quiet period check in embed cycle (before `embedPendingCodebase()` call at line ~344): skip if `lastFileChangeAt > 0 && Date.now() - lastFileChangeAt < embedQuietPeriodMs`. Log skip with time since last change.
- [x] 3.4 Ensure startup initial embedding (5s timeout, lines 412-426) bypasses the quiet period by checking `lastFileChangeAt === 0` — satisfied by design: startup embedding calls embedPendingCodebase() directly, and lastFileChangeAt starts at 0

## 4. Exclude Patterns

- [x] 4.1 Add `/tmp/**` to `BUILTIN_EXCLUDE_PATTERNS` in `src/codebase.ts` (after line 129, in the "Logs & tmp" section)

## 5. Observability

- [x] 5.1 Add `lastFileChangeAt` to `WatcherStats` interface and `getStats()` return value
- [x] 5.2 Add overlapping workspace detection on startup: after loading `allWorkspaces`, check if any path is a prefix of another and log warning

## 6. Validation

- [x] 6.1 Run `lsp_diagnostics` on all changed files (`types.ts`, `watcher.ts`, `codebase.ts`, `server.ts`) — zero type errors ✓
- [x] 6.2 Run `npx tsc --noEmit` to verify full project compiles — zero errors in changed files (6 pre-existing errors in bench.ts and treesitter.ts unrelated to this change)
- [ ] 6.3 Verify log output: start the server, make a file change, confirm cooldown/quiet-period skip messages appear in logs — manual verification needed
