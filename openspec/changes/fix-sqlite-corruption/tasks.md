## Phase 0: Centralize Database Creation

- [x] 0.1 Create `openDatabase(path: string): Database` helper in store.ts with all PRAGMAs: WAL, foreign_keys, busy_timeout=15000, synchronous=NORMAL, wal_autocheckpoint=1000, journal_size_limit=67108864
- [x] 0.2 Update createStore() to use openDatabase() internally instead of `new Database()`
- [x] 0.3 Replace all 15 unsafe `new Database()` calls in index.ts with openDatabase()
- [x] 0.4 Replace all 4 unsafe `new Database()` calls in server.ts with openDatabase()
- [x] 0.5 Replace 1 unsafe `new Database()` call in watcher.ts with openDatabase()
- [x] 0.6 Replace 2 unsafe `new Database()` calls in harvester.ts with openDatabase()
- [x] 0.7 Refactor 4 `new Database()` calls in db/corruption-recovery.ts to use openDatabase() (existing recovery module — integrate with new rename+rebuild policy)
- [x] 0.8 Skip eval/harness.ts — uses :memory: DB, no PRAGMAs needed
- [x] 0.9 Remove duplicate connection: server.ts:1995 symbolGraphDb - use store.getDb() instead of separate Database
- [x] 0.10 Remove duplicate connection: watcher.ts:208 - use wsStore.getDb() instead of new Database(wsDbPath)
- [x] 0.11 Add `getDb(): Database` method to Store interface to expose internal db for reuse

## Phase 1: Graceful Exit and Service Safety

- [x] 1.1 Update process.exit(1) at server.ts:1930 (unhandledRejection) to call cleanup() first
- [x] 1.2 Update process.exit(1) at server.ts:1950 (unhandledRejection threshold) to call cleanup() first
- [x] 1.3 Update process.exit(1) at server.ts:2022 (vector dimension mismatch) to call cleanup() first
- [x] 1.4 Add WAL checkpoint `db.pragma('wal_checkpoint(PASSIVE)')` in cleanup() before db.close()
- [x] 1.5 Add WAL checkpoint in Store.close() method before db.close()
- [x] 1.6 Add ThrottleInterval=30 to LaunchAgent plist in service-installer.ts (macOS)
- [x] 1.7 Add StartLimitBurst=5 and StartLimitIntervalSec=600 to systemd unit in service-installer.ts (Linux)

## Phase 2: Corruption Detection and Recovery

- [x] 2.1 Add `PRAGMA quick_check` in openDatabase() - if fails, trigger corruption recovery
- [x] 2.2 Implement corruption recovery: fs.renameSync(X.sqlite, X.sqlite.corrupt.{ISO8601}), create fresh DB with schema
- [x] 2.3 Write/append to ~/.nano-brain/CORRUPTION_NOTICE.md on recovery with timestamp, paths, instructions
- [x] 2.4 Add corruption_recovered flag and recovered_at timestamp to /health endpoint response
- [x] 2.5 First MCP tool call after recovery returns warning message about rebuild (clear flag after first call)
- [x] 2.6 Remove silent auto-recovery from openWorkspaceStore() (store.ts:2032-2045) - replaced by rename+rebuild policy

## Phase 3: Init Force Cleanup

- [x] 3.1 Extend init --force --all filter in index.ts to delete `-wal` and `-shm` files
- [x] 3.2 Make init --force (without --all) delete+recreate workspace DB file instead of soft-delete in handleInit()

## Phase 4: Daemon Coordination

- [x] 4.1 Add POST /api/maintenance/prepare endpoint in server.ts: wait for in-flight, pause watcher, checkpoint WAL, set flag
- [x] 4.2 Add POST /api/maintenance/resume endpoint in server.ts: reopen DB, restart watcher, clear flag (atomic check-and-clear)
- [x] 4.3 Return 503 for new MCP/API requests while maintenance flag is active
- [x] 4.4 Add maintenance timeout (5 minutes) that auto-resumes with atomic flag to prevent double-resume race
- [x] 4.5 Reject concurrent maintenance requests with 409 response
- [x] 4.6 Update CLI init --force in index.ts (host only) to call maintenance endpoints when daemon is running
- [x] 4.7 Add fallback when daemon unreachable on host: warn user, suggest stopping daemon via launchctl

## Phase 5: Container HTTP Routing

- [x] 5.1 Add container detection in CLI: check for /.dockerenv file existence
- [x] 5.2 Add HTTP API endpoints for write operations: POST /api/write, POST /api/init, POST /api/reindex, POST /api/embed
- [x] 5.3 Route container CLI through HTTP for ALL operations (query, search, write, init, reindex, embed)
- [x] 5.4 Container CLI refuses direct DB access - error "Daemon not running. Start it on the host." if daemon unreachable
- [x] 5.5 Container CLI refuses destructive ops (init --force) - must coordinate via HTTP maintenance endpoints
