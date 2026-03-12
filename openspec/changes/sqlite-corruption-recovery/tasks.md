# Implementation Tasks: SQLite Corruption Recovery

## Phase 1: Core Module Implementation

### Task 1.1: Create directory structure
- [ ] Create `src/db/` directory
- [ ] Verify `src/db/` doesn't already exist

**Expected output:**
```
src/db/
└── corruption-recovery.ts
```

---

### Task 1.2: Implement `corruption-recovery.ts`
- [ ] Create file `src/db/corruption-recovery.ts`
- [ ] Define types: `CorruptionRecoveryOptions`, `IntegrityCheckResult`
- [ ] Implement `checkAndRecoverDB()` function
- [ ] Handle all error cases from design doc
- [ ] Add comprehensive logging

**Function checklist:**
- [ ] Create db directory if missing
- [ ] Check if database file exists
- [ ] If missing: return fresh Database (normal case)
- [ ] If exists: open + run `PRAGMA integrity_check`
- [ ] Parse integrity results
- [ ] If OK: return opened DB
- [ ] If corrupted:
  - [ ] Generate ISO timestamp for filename
  - [ ] Rename file to `.corrupted.{timestamp}`
  - [ ] Clean up WAL/SHM files
  - [ ] Emit metrics callback
  - [ ] Log warning
  - [ ] Initialize fresh DB
  - [ ] Return fresh instance
- [ ] Handle exceptions during integrity check
- [ ] Handle rename failures

**Testing in module:**
- [ ] Write JSDoc examples showing typical usage
- [ ] Document error scenarios in JSDoc

---

## Phase 2: Integration

### Task 2.1: Update `src/store.ts` - Add import
- [ ] Add import statement: `import { checkAndRecoverDB } from './db/corruption-recovery.js';`
- [ ] Verify import works (no circular dependencies)

**Expected:** No build errors

---

### Task 2.2: Update `src/store.ts` - Call recovery function
- [ ] Find `export function createStore(dbPath: string): Store {`
- [ ] Make function async: `export async function createStore(dbPath: string): Promise<Store> {`
- [ ] Remove existing directory creation (moved to recovery function)
- [ ] Replace `const db = new Database(dbPath)` with:
  ```typescript
  const db = await checkAndRecoverDB(dbPath, {
    logger: { log, error: console.error },
    metricsCallback: (event) => {
      if (event === 'corruption_detected') {
        // TODO: Emit Prometheus metric
      }
    }
  });
  ```

**Testing checklist:**
- [ ] Build succeeds: `npm run build`
- [ ] No TypeScript errors
- [ ] No runtime errors on startup

---

### Task 2.3: Update callers of `createStore()`
- [ ] Find all calls to `createStore()` in the codebase
- [ ] Update to use `await` (if not already async context)
- [ ] Check `src/index.ts`
- [ ] Check `src/server.ts`
- [ ] Check any other files that call `createStore()`

**For each file:**
- [ ] Make calling function async if needed
- [ ] Add `await` before `createStore()`
- [ ] Verify no dangling promises

**Expected locations:**
- `src/index.ts` - main daemon initialization
- `src/server.ts` - server startup

---

## Phase 3: Metrics Integration

### Task 3.1: Set up metrics callback
- [ ] Locate Prometheus setup in `src/server.ts` or telemetry module
- [ ] Create metric: `database_corruption_detected` (counter)
- [ ] Update `createStore()` callback to increment counter
- [ ] Verify metric is exposed on `/metrics` endpoint (if Prometheus is used)

**Expected metric:**
```
# HELP database_corruption_detected Total number of database corruptions detected
# TYPE database_corruption_detected counter
database_corruption_detected 0
```

**If Prometheus not yet available:**
- [ ] Log to file instead: `~/.nano-brain/corruption-events.jsonl`
- [ ] Add TODO comment for future metrics setup

---

### Task 3.2: Add monitoring constants
- [ ] Define corruption alert thresholds in config (or as constants)
- [ ] Example: 3 per 24h triggers alert
- [ ] Document in README/ops guide

---

## Phase 4: Configuration

### Task 4.1: Create launchd plist
- [ ] Create directory: `~/.config/nano-brain/launchd/`
- [ ] Create file: `com.tamlh.nano-brain.plist`
- [ ] Use template from design.md
- [ ] Update paths to actual nano-brain installation:
  - [ ] `ProgramArguments` → correct Node.js path
  - [ ] `ProgramArguments` → correct dist/index.js path
  - [ ] `StandardOutPath` → `/var/log/nano-brain.out.log`
  - [ ] `StandardErrorPath` → `/var/log/nano-brain.err.log`
  - [ ] `EnvironmentVariables.HOME` → correct user home

**Verification:**
- [ ] File is valid XML (use `plutil -lint` to verify)
- [ ] No hardcoded incorrect paths

---

### Task 4.2: Installation instructions
- [ ] Document how to install plist:
  ```
  cp com.tamlh.nano-brain.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.tamlh.nano-brain.plist
  ```
- [ ] Document uninstall procedure
- [ ] Document how to check status: `launchctl list | grep nano-brain`
- [ ] Document log monitoring: `tail -f /var/log/nano-brain.*.log`

---

## Phase 5: Testing

### Task 5.1: Unit tests
- [ ] Create `test/db/corruption-recovery.test.ts`
- [ ] Test: Normal DB initialization (no corruption)
- [ ] Test: Missing DB file (creates fresh)
- [ ] Test: Valid existing DB (opens + returns)
- [ ] Test: Corrupted DB (truncated file)
- [ ] Test: Corrupted DB (via integrity check failure)
- [ ] Test: Rename success (corrupted file saved)
- [ ] Test: Metrics callback called on corruption
- [ ] Test: WAL/SHM files cleaned up
- [ ] Test: Fresh DB is valid after recovery
- [ ] Run tests: `npm test -- corruption-recovery`

**Expected:** All tests pass

---

### Task 5.2: Build verification
- [ ] `npm run build`
- [ ] No TypeScript errors
- [ ] No runtime errors

---

### Task 5.3: Manual integration test
- [ ] Start daemon: `npm run daemon &`
- [ ] Verify health: `curl http://localhost:3100/health`
- [ ] Verify database exists
- [ ] Create/truncate DB to simulate corruption:
  ```bash
  truncate -s 100 ~/.nano-brain/index.db
  ```
- [ ] Kill daemon: `kill %1`
- [ ] Restart daemon: `npm run daemon &`
- [ ] Wait 12 seconds (10s throttle + buffer)
- [ ] Verify health: `curl http://localhost:3100/health`
- [ ] Verify daemon is running and responsive
- [ ] Verify corrupted file exists: `ls -la ~/.nano-brain/index.db.corrupted.*`
- [ ] Check logs for recovery messages

**Expected:**
- Daemon comes back up
- Fresh database is initialized
- Corrupted file saved with timestamp
- No errors in logs

---

## Phase 6: Documentation

### Task 6.1: README updates
- [ ] Add "SQLite Corruption Recovery" section to main README
- [ ] Document auto-recovery behavior
- [ ] Document what users/ops should do if corruption occurs frequently
- [ ] Link to troubleshooting guide

---

### Task 6.2: Troubleshooting guide
- [ ] Create `docs/TROUBLESHOOTING.md` section for database corruption
- [ ] Document symptoms of corruption
- [ ] Document recovery process
- [ ] Document how to manually rebuild DB
- [ ] Document how to clean up old `.corrupted.*` files

**Example troubleshooting section:**
```markdown
### Database Corruption Issues

**Symptoms:**
- Daemon fails to start
- Logs show "integrity check failed"
- `/var/log/nano-brain.err.log` contains SQLite errors

**Recovery (Automatic):**
The daemon automatically detects corruption and rebuilds the database.
Wait 10-30 seconds for recovery. Check daemon status:
  launchctl list | grep nano-brain

**Manual Recovery:**
If automatic recovery doesn't work:
1. Stop daemon: `launchctl unload ...`
2. Inspect corrupted file: `ls -la ~/.nano-brain/index.db.corrupted.*`
3. Delete corrupted DB: `rm ~/.nano-brain/index.db*`
4. Restart daemon: `launchctl load ...`
```

---

### Task 6.3: Operations guide
- [ ] Create `docs/OPERATIONS.md` or update existing
- [ ] Document launchd configuration
- [ ] Document how to monitor corruption events
- [ ] Document log locations and format
- [ ] Document alert thresholds (3 per 24h)

---

## Phase 7: Verification & Deployment

### Task 7.1: Pre-deployment checklist
- [ ] All tests pass
- [ ] Build succeeds
- [ ] No new warnings
- [ ] No new ESLint/TypeScript issues
- [ ] Documentation is complete
- [ ] Corruption recovery module has been reviewed
- [ ] Integration points tested
- [ ] Manual test passed

---

### Task 7.2: Create commit
- [ ] Stage all changes
- [ ] Write commit message:
  ```
  feat(db): add SQLite corruption detection and auto-recovery
  
  - Auto-detect database corruption at startup via PRAGMA integrity_check
  - Rename corrupted files to .corrupted.{ISO-timestamp} for forensics
  - Initialize fresh database on corruption (cache is re-derivable)
  - Emit metrics for monitoring and alerting
  - Add launchd configuration for daemon restart on corruption
  
  Closes: [issue number if applicable]
  ```
- [ ] Verify commit includes all necessary files
- [ ] Verify commit doesn't include debugging code

---

### Task 7.3: Final validation
- [ ] Run full test suite: `npm test`
- [ ] Run linting: `npm run lint`
- [ ] Build production: `npm run build`
- [ ] Verify dist/ is up-to-date
- [ ] Manual smoke test with real daemon

---

## Completion Checklist

- [ ] Core module: `src/db/corruption-recovery.ts` created and tested
- [ ] Integration: `src/store.ts` updated with corruption check
- [ ] All callers: async/await updated throughout codebase
- [ ] Metrics: Corruption events tracked and exposed
- [ ] Config: launchd plist created with correct paths
- [ ] Tests: Unit and manual tests passing
- [ ] Docs: README, troubleshooting, operations guides updated
- [ ] Build: `npm run build` succeeds, no errors
- [ ] Tests: `npm test` passes completely
- [ ] Commit: All changes in clean commit with good message
- [ ] Deployment: Ready to merge to main branch

---

## Estimated Time

- Phase 1 (Module): 30-45 minutes
- Phase 2 (Integration): 15-20 minutes
- Phase 3 (Metrics): 10-15 minutes
- Phase 4 (Config): 10-15 minutes
- Phase 5 (Testing): 20-30 minutes
- Phase 6 (Documentation): 20-25 minutes
- Phase 7 (Verification): 10-15 minutes

**Total: 2-3 hours**

---

## Notes

- All file paths assume macOS with default home directory structure
- Adjust paths as needed for different OS (though this is a macOS daemon specifically)
- If any phase requires design changes, pause and document decision
