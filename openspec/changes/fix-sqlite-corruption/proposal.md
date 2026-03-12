## Why

nano-brain suffers recurring SQLite "database disk image is malformed" errors. Eight confirmed bugs contribute to corruption:

**B1**: symbolGraphDb opens same DB file without PRAGMAs (server.ts:1995) - `const store = createStore(effectiveDbPath)` then `const symbolGraphDb = new Database(effectiveDbPath)` creates duplicate connection without WAL mode or busy_timeout.

**B2**: process.exit(1) in rejection handler bypasses cleanup (server.ts:1930, 1950, 2022) - 3 exit paths skip cleanup(), leaving DB connections open and WAL not checkpointed. Only SIGTERM/SIGINT go through cleanup().

**B3**: LaunchAgent plist has no ThrottleInterval (service-installer.ts:58-59) - KeepAlive=true with no throttle causes crash loop on corrupt DB. systemd has only RestartSec=2, no StartLimitBurst.

**B4**: 26 `new Database()` calls without PRAGMAs across codebase - Only createStore() in store.ts applies PRAGMAs (WAL, foreign_keys, busy_timeout). 15 in index.ts, 4 in server.ts, 1 in watcher.ts, 2 in harvester.ts, 4 in db/corruption-recovery.ts. (eval/harness.ts uses :memory: — excluded.)

**B5**: No corruption recovery - crash loop on corrupt DB - Daemon detects corruption, exits, launchctl respawns, hits same corrupt DB, infinite loop.

**B6**: CLI init --force doesn't stop daemon (coordination gap).

**B7**: init --force --all leaves orphaned WAL/SHM files.

**B8**: Watcher duplicate DB connection (watcher.ts:202-208).

## What Changes

- **Centralized DB factory**: Single `openDatabase()` helper function with ALL PRAGMAs; replace all 26 unsafe `new Database()` calls (excluding :memory: in eval/harness.ts)
- **No duplicate connections**: server.ts symbolGraphDb and watcher.ts reuse Store's db via getDb()
- **Graceful exit**: All process.exit() paths call cleanup() first with WAL checkpoint
- **Service restart safety**: ThrottleInterval=30 in LaunchAgent, StartLimitBurst=5 in systemd
- **Corruption recovery**: Rename corrupt file to .corrupt.{timestamp}, create fresh DB, log loudly, write CORRUPTION_NOTICE.md, surface in /health and first MCP tool call
- **Container HTTP routing**: Container CLI routes ALL operations through daemon HTTP API (no direct DB access)
- **Init force cleanup**: Delete WAL/SHM files, coordinate with daemon via maintenance endpoints
- **BREAKING**: Remove silent auto-recovery in `openWorkspaceStore()` - replaced with rename+rebuild policy

## Capabilities

### New Capabilities

- `db-integrity`: Database integrity checking and corruption detection behavior
- `cli-daemon-coordination`: CLI-to-daemon maintenance protocol for destructive operations
- `init-force-cleanup`: Complete cleanup behavior for init --force and init --force --all
- `centralized-db-factory`: Single openDatabase() function for all DB creation with proper PRAGMAs
- `graceful-exit`: All exit paths go through cleanup with WAL checkpoint
- `corruption-recovery`: Rename corrupt file + create fresh DB + multi-channel notification
- `service-restart-safety`: ThrottleInterval and restart limits to prevent crash loops
- `container-http-routing`: Container CLI routes through daemon HTTP API, no direct DB access

### Modified Capabilities

(none - these are new behavioral contracts)

## Impact

- **Code**: store.ts (openDatabase, createStore, openWorkspaceStore, close), index.ts (handleInit, container detection), watcher.ts (reindex), server.ts (cleanup, endpoints, symbolGraphDb), service-installer.ts (plist, systemd), harvester.ts, eval/harness.ts
- **APIs**: New HTTP endpoints `/api/maintenance/prepare`, `/api/maintenance/resume`, write endpoints for container CLI
- **User-facing**: Corruption triggers automatic recovery (rename + rebuild) with multi-channel notification; users see warning on first MCP call after recovery
- **Breaking**: Existing workflows that relied on silent auto-recovery will see different behavior (rename+rebuild vs silent delete)
