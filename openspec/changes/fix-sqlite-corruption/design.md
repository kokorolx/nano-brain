## Context

nano-brain uses SQLite with WAL mode for per-workspace databases. The daemon runs on the host via launchctl (port 3100), while CLI commands may run from containers connecting via `host.docker.internal:3100`. Eight confirmed bugs contribute to corruption:

**B1**: symbolGraphDb opens same DB file without PRAGMAs (server.ts:1995) - duplicate connection without WAL/busy_timeout
**B2**: process.exit(1) bypasses cleanup (server.ts:1930, 1950, 2022) - 3 exit paths skip cleanup()
**B3**: LaunchAgent plist has no ThrottleInterval - crash loop on corrupt DB
**B4**: 26 `new Database()` calls without PRAGMAs - only createStore() applies them
**B5**: No corruption recovery - daemon crash loops on corrupt DB
**B6**: CLI init --force doesn't stop daemon
**B7**: init --force --all leaves orphaned WAL/SHM files
**B8**: Watcher duplicate DB connection (watcher.ts:202-208)

Existing infrastructure: `detectRunningServer()`, `proxyPost()`, `proxyGet()` in index.ts. Note: `src/db/corruption-recovery.ts` already implements `checkAndRecoverDB()` with integrity checks and rename+rebuild logic — this module will be refactored to use `openDatabase()` and integrated with the multi-channel notification system.

## Goals / Non-Goals

**Goals:**
- Prevent corruption through centralized DB factory with proper PRAGMAs
- Eliminate duplicate connections to same DB file
- Ensure all exit paths go through cleanup with WAL checkpoint
- Detect corruption early via integrity checks on store open
- Recover from corruption automatically (rename + fresh DB + notify)
- Prevent crash loops via service restart limits
- Coordinate CLI destructive operations with running daemon
- Route container CLI through daemon HTTP API (no direct DB access)

**Non-Goals:**
- Changing from WAL mode (corruption is from coordination, not WAL)
- Changing per-workspace DB architecture (sound design, isolates corruption)
- Adding distributed locking (single daemon model is sufficient)
- Repairing corrupted data (rename + rebuild is the policy)

## Decisions

### D1: Centralized openDatabase() helper
**Decision**: Create single `openDatabase()` function in store.ts that creates Database with ALL PRAGMAs: WAL, foreign_keys, busy_timeout=15000, synchronous=NORMAL, wal_autocheckpoint=1000, journal_size_limit=67108864. Replace ALL 24 `new Database()` calls across codebase. createStore() uses openDatabase() internally.
**Rationale**: Single point of configuration ensures all connections have proper settings. Eliminates B4 (23 unsafe connections).
**Alternative considered**: Wrapper class - rejected as overkill; simple function is sufficient.

### D2: No duplicate connections to same file
**Decision**: server.ts:1995 symbolGraphDb must reuse store's db via getDb(). watcher.ts:208 must reuse wsStore's db via getDb().
**Rationale**: Eliminates B1 (symbolGraphDb) and B8 (watcher) duplicate connections.
**Alternative considered**: Connection pooling - rejected as overkill for single-process model.

### D3: All exit paths go through cleanup
**Decision**: uncaughtException handler, unhandledRejection threshold, and vector dimension mismatch all call cleanup() before exit. cleanup() does WAL checkpoint (PASSIVE) + db.close().
**Rationale**: Eliminates B2 (3 exit paths bypassing cleanup). Ensures WAL is flushed on any exit.
**Alternative considered**: atexit hook - rejected as unreliable in Node.js.

### D4: ThrottleInterval in LaunchAgent plist
**Decision**: Add ThrottleInterval=30 to macOS plist. Add StartLimitBurst=5 and StartLimitIntervalSec=600 to systemd unit.
**Rationale**: Eliminates B3 (crash loop on corrupt DB). Gives 30s between restarts on macOS, max 5 restarts per 10 minutes on Linux.
**Alternative considered**: Exponential backoff - rejected as launchd doesn't support it natively.

### D5: Corruption recovery (rename + fresh + multi-channel notify)
**Decision**: On corruption at startup:
1. fs.renameSync(X.sqlite, X.sqlite.corrupt.{ISO8601})
2. Create fresh empty DB with schema
3. Log ERROR with full details
4. Write/append to ~/.nano-brain/CORRUPTION_NOTICE.md
5. /health returns {"corruption_recovered": true, ...}
6. First MCP tool call returns warning about rebuild
Same policy for main DB and workspace DBs (both are caches).
**Rationale**: Eliminates B5 (crash loop). Preserves corrupt file for forensics. Multi-channel notification ensures user is informed.
**Alternative considered**: Block and error (D8 in old design) - rejected as it causes crash loops with KeepAlive=true.

### D6: Container CLI routes ALL operations through daemon HTTP API
**Decision**: Container detection via /.dockerenv. In container: ALL ops (query, search, write, init, reindex) go through http://host.docker.internal:3100/api/*. No fallback to direct DB access from container. If daemon unreachable: error "Daemon not running. Start it on the host." Host CLI: can access DB directly (same PID namespace).
**Rationale**: Containers cannot safely access host SQLite files. HTTP API provides proper coordination.
**Alternative considered**: Volume mount with file locking - rejected as SQLite locking doesn't work reliably across container boundaries.

### D7: HTTP maintenance endpoints for CLI-daemon coordination
**Decision**: Add `/api/maintenance/prepare` and `/api/maintenance/resume` endpoints.
- `prepare`: Pauses watcher, checkpoints WAL, sets maintenance flag, returns success
- `resume`: Reopens DB, restarts watcher, clears flag
- Reject concurrent requests with 409
- Timeout after 5 minutes with auto-resume
**Rationale**: CLI can safely perform destructive ops when daemon has released DB.
**Alternative considered**: File-based locking - rejected as less reliable across container boundaries.

### D8: Delete WAL/SHM files in init --force --all
**Decision**: Extend file filter to include `-wal` and `-shm` suffixes.
**Rationale**: Eliminates B7 (orphaned WAL/SHM files poison new databases).

### D9: init --force deletes+recreates workspace DB
**Decision**: `init --force` (without `--all`) deletes and recreates the workspace DB file, not soft-delete rows.
**Rationale**: Clean slate is more reliable than row deletion for corruption recovery.

### D10: CLI calls maintenance endpoints when daemon running
**Decision**: `init --force` calls `POST /api/maintenance/prepare` before destructive ops, `POST /api/maintenance/resume` after.
**Rationale**: Coordinates with daemon without requiring daemon restart. Addresses B6.
**Fallback**: If daemon unreachable, warn user and suggest running on host directly.

## Risks / Trade-offs

**[Risk] Maintenance endpoint abuse** - Malicious actor could call prepare and never resume.
Mitigation: Add timeout (5 minutes) that auto-resumes if no resume call received.

**[Risk] quick_check adds startup latency** - May slow down store opening.
Mitigation: quick_check is fast (subset of integrity_check); acceptable for corruption prevention.

**[Risk] Corruption recovery loses data** - Renaming corrupt file and creating fresh DB loses cached data.
Mitigation: Both main DB and workspace DBs are caches (can be rebuilt from source). CORRUPTION_NOTICE.md informs user. Corrupt file preserved for forensics.

**[Risk] Container CLI depends on daemon** - If daemon is down, container CLI cannot operate.
Mitigation: Clear error message with instructions to start daemon on host. This is intentional - containers should not access host SQLite directly.

**[Trade-off] 15s busy_timeout vs responsiveness** - Longer timeout means slower failure detection.
Accepted: Corruption prevention outweighs slightly slower error reporting.

**[Trade-off] ThrottleInterval=30 vs fast recovery** - 30s delay between restarts on macOS.
Accepted: Prevents crash loops; 30s is acceptable for a background daemon.
