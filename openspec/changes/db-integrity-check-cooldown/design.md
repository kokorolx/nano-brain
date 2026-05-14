## Context

`checkAndRecoverDB()` in `src/db/corruption-recovery.ts` runs `PRAGMA quick_check` on every cold-start `createStore()` call. The function already dedups within a process via `checkedPaths: Set<string>`, but process-level state dies on each CLI exit. A 10K-doc DB takes 7-8s per check.

## Decisions

### Decision 1: Stamp file format

**Choice:** Plain text, tab-separated: `{ISO timestamp}\t{DB mtime as epoch ms}`

**Rationale:** No JSON parsing overhead, readable with any tool, single line, easy to validate. Two fields are enough: when was the last check, and what was the DB's mtime at that point.

**Alternative considered:** JSON with richer metadata. Rejected — adds complexity with no benefit; the two-field format is sufficient and unambiguous.

### Decision 2: Stamp file location

**Choice:** `{dbPath}.checked` — same directory, derived name.

**Rationale:** Same filesystem as the DB (avoids cross-mount inconsistency), obvious association, cleaned up naturally when the DB is deleted. No separate cache directory to manage.

**Alternative considered:** `~/.nano-brain/cache/integrity/` central directory. Rejected — cross-mount risk, requires extra cleanup logic on DB removal.

### Decision 3: Cooldown duration

**Choice:** 30 minutes, overridable via `NANO_BRAIN_CHECK_COOLDOWN_MS` env var.

**Rationale:** Long enough to cover normal agent session workflows (multiple CLI calls in quick succession) while short enough to catch corruption from external writes. Env override allows testing with short cooldown (e.g. 0 to force check every time) and production tuning.

### Decision 4: Invalidation logic

**Choice:** Skip check only when ALL of these hold:
1. Stamp file exists and is readable
2. `Date.now() - stampTimestamp < COOLDOWN_MS`
3. `currentDbMtime === stampMtime`

If any condition fails → run full check, then write fresh stamp.

**Rationale:** The mtime check is the critical safety net. If anything writes to the DB between CLI calls (server, another CLI, external tool), mtime changes and the next CLI call re-checks. This provides automatic invalidation without requiring coordination between processes.

### Decision 5: Stamp write timing

**Choice:** Write stamp after successful `PRAGMA quick_check` AND after the in-process `checkedPaths.add()`. On corruption + recovery, write stamp for the fresh DB (which just passed its own quick_check).

**Rationale:** Only write stamp on confirmed healthy state. Never write stamp if check was skipped (stamp already current) or if an error occurred.

## Data Flow

```
checkAndRecoverDB(dbPath)
  │
  ├─ New DB (no file) → create fresh, write stamp, return
  │
  ├─ checkedPaths.has(path) → skip (in-process dedup, unchanged)
  │
  ├─ readStamp(dbPath) → { stampTs, stampMtime }
  │   ├─ stamp valid (age < 30min && mtime matches) → open DB, applyPragmas, return
  │   └─ stamp invalid/missing → fall through to PRAGMA quick_check
  │
  └─ Run PRAGMA quick_check
      ├─ PASS → checkedPaths.add, writeStamp(dbPath, currentMtime), open DB, return
      └─ FAIL → recovery path (rename, fresh DB), writeStamp for fresh DB, return
```

## Stamp File I/O

```typescript
function readStamp(dbPath: string): { ts: number; mtime: number } | null {
  const stampPath = dbPath + '.checked';
  try {
    const raw = fs.readFileSync(stampPath, 'utf-8').trim();
    const [tsStr, mtimeStr] = raw.split('\t');
    const ts = parseInt(tsStr, 10);
    const mtime = parseInt(mtimeStr, 10);
    if (!isFinite(ts) || !isFinite(mtime)) return null;
    return { ts, mtime };
  } catch { return null; }
}

function writeStamp(dbPath: string, mtime: number): void {
  const stampPath = dbPath + '.checked';
  try {
    fs.writeFileSync(stampPath, `${Date.now()}\t${mtime}`, 'utf-8');
  } catch { /* non-fatal: missing stamp → check runs next time */ }
}
```

## Error Handling

- Stamp read fails (missing, corrupt, permission) → run full check, not an error
- Stamp write fails → log warning, continue; next invocation runs full check
- DB stat fails → treat as missing mtime, run full check
- All existing error handling (ERR_DLOPEN_FAILED, corruption recovery) unchanged

## Testing

- Stamp written after successful check
- Stamp skips check on next call when DB mtime unchanged
- Stamp invalidated when DB mtime changes (write simulated via `touch`)
- Stamp invalidated when cooldown expires (via `NANO_BRAIN_CHECK_COOLDOWN_MS=0`)
- Stamp written for fresh DB after recovery
- Stamp read failure → fallback to full check (no crash)
- Stamp write failure → non-fatal, next call does full check
- Existing dedup tests (`checkedPaths`) unchanged
