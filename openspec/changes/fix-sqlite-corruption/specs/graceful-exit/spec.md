## ADDED Requirements

### Requirement: All exit paths go through cleanup
The daemon SHALL call cleanup() before any process.exit() call. No exit path SHALL bypass cleanup.

#### Scenario: uncaughtException calls cleanup
- **WHEN** an uncaught exception occurs
- **THEN** cleanup() is called before process.exit(1)
- **AND** WAL checkpoint is executed
- **AND** database connections are closed

#### Scenario: unhandledRejection calls cleanup
- **WHEN** unhandled rejection threshold is reached (server.ts:1930, 1950)
- **THEN** cleanup() is called before process.exit(1)
- **AND** WAL checkpoint is executed
- **AND** database connections are closed

#### Scenario: Vector dimension mismatch calls cleanup
- **WHEN** vector dimension mismatch is detected (server.ts:2022)
- **THEN** cleanup() is called before process.exit(1)
- **AND** WAL checkpoint is executed
- **AND** database connections are closed

#### Scenario: SIGTERM/SIGINT continue to use cleanup
- **WHEN** SIGTERM or SIGINT is received
- **THEN** cleanup() is called (existing behavior)
- **AND** process exits after cleanup completes

### Requirement: cleanup() performs WAL checkpoint
The cleanup() function SHALL execute `PRAGMA wal_checkpoint(PASSIVE)` before closing database connections.

#### Scenario: cleanup checkpoints WAL
- **WHEN** cleanup() is called
- **THEN** `db.pragma('wal_checkpoint(PASSIVE)')` is executed for each open database
- **AND** then db.close() is called
- **AND** checkpoint errors are logged but do not prevent close

### Requirement: Store.close() performs WAL checkpoint
The Store.close() method SHALL execute WAL checkpoint before closing the database.

#### Scenario: Store close checkpoints WAL
- **WHEN** Store.close() is called
- **THEN** `db.pragma('wal_checkpoint(PASSIVE)')` is executed
- **AND** then db.close() is called
