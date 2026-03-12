# Database Corruption Recovery Specification

## ADDED Requirements

### Requirement: System SHALL detect corruption at startup
The daemon SHALL run `PRAGMA integrity_check` before opening the database to detect file corruption.

#### Scenario: Database integrity check detects corruption
- **WHEN** daemon starts with a corrupted database file
- **THEN** PRAGMA integrity_check is executed before any operations
- **AND** corruption is detected and flagged

#### Scenario: Fresh database created when file missing
- **WHEN** daemon starts with no database file present
- **THEN** a fresh database is created without triggering recovery

#### Scenario: Valid database passes check normally
- **WHEN** daemon starts with a valid existing database
- **THEN** PRAGMA integrity_check returns 'ok'
- **AND** database opens normally

### Requirement: System SHALL rename corrupted database with timestamp
When corruption is detected, the original file SHALL be renamed to preserve it for forensics.

#### Scenario: Corrupted file renamed to backup
- **WHEN** corruption is detected
- **THEN** original file is renamed to {dbPath}.corrupted.{ISO-8601-timestamp}
- **AND** rename completes before fresh database creation

#### Scenario: Fresh database created after corruption rename
- **WHEN** corrupted file has been renamed
- **THEN** a new database is created at the original path
- **AND** new database passes integrity check

#### Scenario: WAL and SHM files cleaned up
- **WHEN** corrupted database is renamed
- **THEN** associated {dbPath}-wal and {dbPath}-shm files are deleted

### Requirement: System SHALL emit metrics on corruption detection
Corruption events SHALL trigger metric callbacks for monitoring and alerting.

#### Scenario: Metrics callback invoked on corruption
- **WHEN** database corruption is detected
- **THEN** metricsCallback('corruption_detected') is called
- **AND** monitoring systems can track and alert on this event

#### Scenario: Structured logging of recovery operations
- **WHEN** corruption is detected
- **THEN** warning is logged with timestamp and corrupted file path
- **AND** logs are machine-parseable for aggregation

### Requirement: System SHALL handle all error cases gracefully
Error conditions (unopenable files, permission errors, disk space) SHALL be logged and propagated.

#### Scenario: Unopenable database treated as corrupted
- **WHEN** database file cannot be opened
- **THEN** exception is caught and file is marked corrupted
- **AND** recovery proceeds with rename and fresh init

#### Scenario: Permission errors are logged and propagated
- **WHEN** rename fails due to permissions
- **THEN** error is logged with context
- **AND** exception is thrown so daemon can restart via launchd

#### Scenario: Integrity check respects busy_timeout
- **WHEN** PRAGMA integrity_check is running
- **THEN** SQLite busy_timeout (5 seconds) is respected
- **AND** recovery completes within 10 seconds

### Requirement: System SHALL integrate with daemon startup
The recovery function SHALL be called before database schema initialization.

#### Scenario: checkAndRecoverDB called before createStore
- **WHEN** daemon starts
- **THEN** checkAndRecoverDB() runs before any schema operations
- **AND** database validity is guaranteed first

#### Scenario: createStore becomes async
- **WHEN** createStore is called
- **THEN** function is async and awaited by callers
- **AND** index.ts and server.ts use await

#### Scenario: Daemon exits with code 1 on unrecoverable failure
- **WHEN** recovery cannot complete
- **THEN** daemon logs error and exits with code 1
- **AND** launchd detects failure and restarts

### Requirement: System SHALL restart via launchd after corruption
The daemon configuration SHALL enable automatic restart with throttling.

#### Scenario: launchd restarts daemon after corruption exit
- **WHEN** daemon exits with code 1
- **THEN** launchd waits at least 10 seconds (ThrottleInterval)
- **AND** daemon is restarted automatically
- **AND** second startup finds fresh database

#### Scenario: KeepAlive configuration prevents downtime
- **WHEN** daemon crashes
- **THEN** KeepAlive.SuccessfulExit = false triggers restart
- **AND** daemon stays running until manually stopped

#### Scenario: Logs captured for troubleshooting
- **WHEN** daemon runs
- **THEN** stdout captured to /var/log/nano-brain.out.log
- **AND** stderr captured to /var/log/nano-brain.err.log

## MODIFIED Requirements

### Requirement: System SHALL enable WAL mode
Write-Ahead Logging SHALL be enabled to prevent partial transaction loss.

#### Scenario: WAL mode prevents transaction corruption
- **WHEN** database is initialized
- **THEN** PRAGMA journal_mode = WAL is set
- **AND** partial writes are prevented on power loss

### Requirement: System SHALL set synchronous mode
Synchronous mode SHALL be configured for durability and consistency.

#### Scenario: Synchronous mode ensures metadata durability
- **WHEN** database operations complete
- **THEN** PRAGMA synchronous = NORMAL or FULL
- **AND** metadata is flushed to disk

### Requirement: System SHALL set busy timeout
Lock contention SHALL be resolved with 5-second timeout.

#### Scenario: Busy timeout prevents SQLITE_BUSY errors
- **WHEN** database is locked
- **THEN** PRAGMA busy_timeout = 5000 is applied
- **AND** operation retries automatically

---

## Notes
- All timestamps: ISO-8601 format (YYYY-MM-DDTHH:MM:SSZ)
- Corruption recovery is cache-specific (data re-derivable)
- No user interaction required
- Alert if corruption > 3 times per 24 hours
