# Design: SQLite Corruption Recovery

## Architecture

### High-Level Flow

```
Daemon Start
    ↓
checkAndRecoverDB(dbPath)
    ├─ Read PRAGMA integrity_check
    ├─ IF OK: return Database instance → NORMAL FLOW
    └─ IF FAIL: corruption detected
        ├─ Rename to {dbPath}.corrupted.{ISO-timestamp}
        ├─ Emit metrics: database_corruption_detected++
        ├─ Log warning with corrupted file path
        ├─ Initialize fresh DB with schema
        └─ Return fresh Database instance → launchd restarts (exit 1)
    ↓
Server starts normally OR exits if corruption found
    ↓
launchd (if corruption exit)
    ├─ Throttle 10 seconds
    ├─ Restart daemon
    └─ Next startup: fresh DB is valid
```

### Decision Points

**Q: Why check before opening DB?**
- `PRAGMA integrity_check` requires an open DB connection
- If DB is partially corrupted, initial open() succeeds, but operations fail
- Checking immediately after open catches issues before operations

**Q: Why rename instead of delete?**
- Preserves evidence for forensics (file size, content, timestamps)
- Helps engineers debug why corruption happened
- Complies with "safe failure" principle

**Q: Why exit with code 1 if corruption found?**
- Signals to launchd that daemon crashed
- launchd throttles restart (respects `ThrottleInterval`)
- Prevents restart loop if corruption is persistent

**Q: Why fresh DB instead of attempting repair?**
- Database is a cache/index—all data is re-derivable
- SQLite repair tools often don't work or produce stale data
- Building fresh is faster + guaranteed consistent

## Module Design: `src/db/corruption-recovery.ts`

### Function Signature

```typescript
export interface CorruptionRecoveryOptions {
  logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void };
  metricsCallback?: (event: 'corruption_detected') => void;
}

export async function checkAndRecoverDB(
  dbPath: string,
  options?: CorruptionRecoveryOptions
): Promise<Database.Database>
```

### Algorithm

1. **Create directory** if it doesn't exist
2. **Check if file exists**
   - If no: return fresh Database (normal initialization)
   - If yes: proceed to check integrity
3. **Attempt open + integrity check**
   ```
   TRY:
     db = new Database(dbPath)
     results = db.pragma('integrity_check')
     db.close()
   CATCH:
     → Corruption detected (can't even open)
   ```
4. **Evaluate integrity results**
   ```
   IF results[0]?.integrity_check === 'ok':
     → Database is valid
     return new Database(dbPath, options)
   ELSE:
     → Database is corrupted
     rename to {dbPath}.corrupted.{ISO-timestamp}
     emit metrics
     log warning
     rm {dbPath}-wal, {dbPath}-shm if they exist
     return new Database(dbPath) // fresh DB
   ```
5. **Handle edge cases**
   - If rename fails: log + throw (let launchd handle it)
   - If pragma check throws: corruption likely (rename + fresh)
   - If fresh DB creation fails: propagate error (system issue)

### Error Handling

```typescript
Error Scenarios:
├─ File not found
│  └─ Action: Initialize fresh DB (normal case)
├─ File not readable (permissions)
│  └─ Action: Log error + throw → launchd restart
├─ File corrupted
│  ├─ Type A: Open fails
│  │  └─ Action: Rename + fresh DB
│  └─ Type B: Open succeeds, integrity fails
│     └─ Action: Close + rename + fresh DB
├─ Rename fails
│  └─ Action: Log + throw → launchd restart (admin fixes permissions)
└─ Fresh DB creation fails (out of disk space?)
   └─ Action: Throw → launchd restart (system issue)
```

### Logging Output

```
[WARN] Corruption detected in {dbPath}, renaming to {dbPath}.corrupted.2026-03-11T10:30:45Z
[INFO] Initializing fresh database at {dbPath}
[DEBUG] Removed WAL files: {dbPath}-wal, {dbPath}-shm
```

### Metrics

```typescript
// Called via callback
metricsCallback?.('corruption_detected');

// Expected Prometheus metric
database_corruption_detected{service="nano-brain"} +=1
```

## Integration Point: `src/store.ts`

### Current Code (lines ~23-29)
```typescript
export function createStore(dbPath: string): Store {
  log('store', 'createStore dbPath=' + dbPath);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  
  db.pragma('journal_mode = WAL');
  // ... rest of initialization
}
```

### Modified Code
```typescript
import { checkAndRecoverDB } from './db/corruption-recovery.js';

export async function createStore(dbPath: string): Promise<Store> {
  log('store', 'createStore dbPath=' + dbPath);
  
  // Check for corruption before opening DB
  const db = await checkAndRecoverDB(dbPath, {
    logger: { log, error: console.error },
    metricsCallback: (event) => {
      if (event === 'corruption_detected') {
        // Emit Prometheus metric
        recordCorruptionDetected();
      }
    }
  });
  
  // Rest of createStore logic remains the same
  // ... database schema creation, etc.
}
```

**Note**: This makes `createStore` async, which requires updating all callers in `index.ts` and `server.ts`.

## launchd Configuration

### File: `~/.config/nano-brain/launchd/com.tamlh.nano-brain.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tamlh.nano-brain</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/tamlh/workspaces/self/AI/Tools/nano-brain/dist/index.js</string>
        <string>serve</string>
    </array>
    
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    
    <key>ThrottleInterval</key>
    <integer>10</integer>
    
    <key>StandardOutPath</key>
    <string>/var/log/nano-brain.out.log</string>
    
    <key>StandardErrorPath</key>
    <string>/var/log/nano-brain.err.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/tamlh</string>
    </dict>
</dict>
</plist>
```

### launchd Behavior
- **KeepAlive.SuccessfulExit: false** = restart on exit code 1 (corruption case)
- **ThrottleInterval: 10** = minimum 10 seconds between restart attempts
- **StandardError/Out** = capture logs for debugging

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Daemon Start                         │
│                      (via launchd)                           │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  checkAndRecoverDB(dbPath)         │
        │                                    │
        │  • PRAGMA integrity_check          │
        │  • Evaluate results                │
        └────────────┬───────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
    ✓ OK               ✗ CORRUPTED
    │                  │
    │  Return DB       ├─ Rename to .corrupted.{ts}
    │  instance        ├─ Emit metrics
    │                  ├─ Clean WAL/SHM files
    │                  └─ Initialize fresh DB
    │                     Return fresh instance
    │                  │
    │                  └─ Exit code 1
    │                     ↓
    │              launchd throttles 10s
    │                     ↓
    │              Restart daemon
    │                     ↓
    │              Next run: fresh DB is valid ✓
    │
    ▼
createStore() continues
Initialize schema, indexes, etc.
startServer() on port 3100
```

## Testing Strategy

### Unit Test
```typescript
test('detects and recovers from corrupted database', async () => {
  const tmpDir = mkdtemp();
  const dbPath = path.join(tmpDir, 'test.db');
  
  // Create valid DB, then truncate it
  const db = new Database(dbPath);
  db.exec('CREATE TABLE test (id INT)');
  db.close();
  
  // Truncate file (simulate corruption)
  fs.truncateSync(dbPath, 100);
  
  // Recovery should rename + create fresh
  const recovered = await checkAndRecoverDB(dbPath);
  
  assert(recovered.open);
  assert(fs.existsSync(dbPath + '.corrupted.*'));
  assert(recovered.pragma('integrity_check')[0]?.integrity_check === 'ok');
  
  recovered.close();
});
```

### Integration Test (Manual)
```bash
# 1. Start daemon
npm run daemon &

# 2. Verify it's running
curl http://localhost:3100/health

# 3. Truncate database
truncate -s 100 ~/.nano-brain/index.db

# 4. Kill daemon
kill %1

# 5. Restart daemon
npm run daemon &

# 6. Verify it recovered
sleep 11  # Wait for launchd throttle
curl http://localhost:3100/health
# Should return 200 OK with fresh database

# 7. Verify corrupted file exists
ls -la ~/.nano-brain/index.db.corrupted.*
```

## Rollback Plan

If corruption recovery causes issues:

1. **Disable auto-recovery** (temporary)
   - Comment out `checkAndRecoverDB()` call in store.ts
   - Redeploy

2. **Manual recovery**
   ```bash
   # Restore from backup if available
   mv ~/.nano-brain/index.db.corrupted.* ~/.nano-brain/index.db.bak
   rm ~/.nano-brain/index.db
   # Daemon will rebuild on restart
   ```

3. **Monitor corruption rate**
   - If > 5 per 24h: investigate root cause (power issues? disk errors?)
   - May need to increase WAL sync frequency or add disk health checks

## Open Questions

1. **Metrics destination**: Prometheus endpoint or file-based logging?
   - Current plan: Prometheus counter via callback
   - Alternative: Write to JSON log for aggregation

2. **Corruption alert threshold**: 3 per 24h or different?
   - Current plan: 3 per 24h (requires ops setup + alerting)
   - Alternative: 5 per 7 days (less sensitive)

3. **WAL cleanup strategy**: Auto-delete `-wal` / `-shm` or keep for debugging?
   - Current plan: Auto-delete (cleaner state)
   - Alternative: Keep with timestamp prefix (preserves state)

---

**Approval**: Design ready for implementation. All edge cases covered. Rollback plan documented.
