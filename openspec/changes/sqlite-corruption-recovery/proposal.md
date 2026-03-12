# SQLite Corruption Recovery for nano-brain Daemon

## Problem Statement

The nano-brain daemon uses SQLite (via better-sqlite3) to store its codebase index and cache. This database is the **single point of failure** for the service. If corruption occurs (file truncation, power loss, etc.), the entire daemon becomes non-functional.

### Current State
- **No corruption detection**: Silent failures or crashes
- **No recovery mechanism**: Requires manual intervention
- **No restart resilience**: Daemon stays down indefinitely
- **No diagnostics**: Operators can't tell what happened

### Why This Matters
- nano-brain is installed as a macOS launchd daemon (background service)
- End users expect "set it and forget it" operation
- Any downtime breaks IDE integration and code analysis
- Admin intervention should not be required for recoverable failures

## Proposed Solution

Implement **automatic corruption detection and recovery** using industry-proven strategies from Signal Desktop, Chrome, and other production services:

### Approach: Auto-Rename + Rebuild
1. **Startup**: Before opening DB, run `PRAGMA integrity_check`
2. **Detect**: If integrity fails, the database is corrupted
3. **Recover**: Rename corrupted file to `.corrupted.<timestamp>` for debugging
4. **Rebuild**: Initialize fresh database with same schema
5. **Restart**: launchd auto-restarts daemon within 10 seconds
6. **Monitor**: Alert if corruption occurs > 3 times in 24 hours

### Why This Strategy
✅ **Automatic** — No user dialogs or manual steps  
✅ **Safe** — Preserves corrupted file for forensics  
✅ **Proven** — Chrome, Signal, VS Code all use variants  
✅ **Fast** — Database is re-derivable (not customer data)  
✅ **Observable** — Metrics + alerts for ops team  

### What This Solves
- ✅ Silent corruption → Detected + fixed automatically
- ✅ Manual recovery → Transparent to end user
- ✅ Daemon downtime → Sub-10-second restart via launchd
- ✅ Data loss risk → Corrupted file preserved for analysis
- ✅ No monitoring → Alerting infrastructure included

## Scope

### In Scope
- ✅ Corruption detection at daemon startup
- ✅ Auto-rename corrupted database
- ✅ Fresh database initialization
- ✅ WAL mode enablement (prevents transaction corruption)
- ✅ Prometheus metrics for corruption detection
- ✅ launchd configuration for 10-second throttle on restart
- ✅ Logging for troubleshooting

### Out of Scope
- ⊘ Data recovery from corrupted database (not possible for cache)
- ⊘ User-facing UI alerts (launchd handles restart transparently)
- ⊘ Real-time corruption prevention (WAL mode + sync mode covers this)

## Success Criteria

1. **Correctness**: Corruption detected before DB operations begin
2. **Safety**: Original corrupted file preserved with timestamp
3. **Speed**: Fresh DB ready < 1 second; launchd restarts within 10 seconds
4. **Observability**: Prometheus counter tracks `database_corruption_detected`
5. **Resilience**: Daemon recovers automatically without user action
6. **Testing**: Manual test confirms rename + rebuild on truncated DB

## Implementation Approach

**Three files to create/modify:**

1. **src/db/corruption-recovery.ts** (NEW)
   - `checkAndRecoverDB(dbPath)` function
   - Runs `PRAGMA integrity_check` at startup
   - Handles corruption rename + cleanup
   - Returns ready-to-use Database instance

2. **src/store.ts** (MODIFY)
   - Call `checkAndRecoverDB()` before `new Database(dbPath)`
   - Ensures corruption check runs first

3. **config/launchd/com.tamlh.nano-brain.plist** (NEW)
   - `ThrottleInterval: 10` (minimum restart delay)
   - `KeepAlive: true` with `SuccessfulExit: true`
   - Logging paths for diagnostics

**Timeline**: 2-4 hours (module creation + integration + testing)

## Related Issues/PRs

- **Research**: Completed investigation of Signal, Chrome, VS Code, better-sqlite3
- **Decision**: Auto-rename+rebuild strategy approved for cache-based database
