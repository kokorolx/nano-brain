## Why

Every CLI invocation that calls `createStore()` triggers `PRAGMA quick_check` on the SQLite database. On a 10K-document (~600MB) database this takes **7-8 seconds** — every time, even for fast commands like `get` or `graph-stats` that finish their actual work in under 100ms.

The existing in-process deduplication (`checkedPaths` Set) already prevents re-checking within the same process, but each CLI invocation is a new process, so the set is always empty at startup.

## What Changes

Add a **mtime-based stamp file** to `src/db/corruption-recovery.ts`:

- After a successful integrity check, write `{dbPath}.checked` containing `{timestamp}\t{db_mtime}`
- On the next call to `checkAndRecoverDB`:
  - If stamp file exists, stamp age < 30 min, AND DB mtime matches → skip `PRAGMA quick_check`
  - Otherwise → run full check as today
- Self-invalidating: any write to the DB changes its mtime, invalidating the stamp and forcing re-check on next open

The stamp file lives next to the DB (same directory, same filesystem), so there is no risk of cross-filesystem inconsistency.

## Non-Goals

- Does not affect corruption detection — if DB is modified or stamp is stale, full check runs
- Does not change the recovery path — corrupt DB handling is unchanged
- Does not skip the check on first-ever open of a DB
- Does not require server awareness or async context
