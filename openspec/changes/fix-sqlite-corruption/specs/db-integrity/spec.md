## ADDED Requirements

### Requirement: Integrity check on store open
The system SHALL run `PRAGMA quick_check` when opening a database via openDatabase(). If the check fails, the system SHALL trigger corruption recovery (see corruption-recovery spec).

#### Scenario: Healthy database opens successfully
- **WHEN** openDatabase() is called on a healthy database
- **THEN** quick_check passes and database opens normally

#### Scenario: Corrupted database triggers recovery
- **WHEN** openDatabase() is called on a corrupted database
- **THEN** quick_check fails and corruption recovery is triggered
- **AND** corrupt file is renamed to .corrupt.{timestamp}
- **AND** fresh database is created and returned
- **AND** multi-channel notification occurs (see corruption-recovery spec)

### Requirement: Daemon startup with corrupted database
The daemon SHALL recover from corruption at startup using the rename+rebuild policy. The daemon SHALL NOT exit due to corruption.

#### Scenario: Daemon startup with corrupted main database
- **WHEN** daemon starts and main store quick_check fails
- **THEN** corruption recovery is triggered (rename + rebuild)
- **AND** daemon logs ERROR with recovery details
- **AND** daemon continues running with fresh database
- **AND** HTTP server starts normally

#### Scenario: Daemon startup with corrupted secondary workspace
- **WHEN** daemon starts and a secondary workspace store quick_check fails
- **THEN** corruption recovery is triggered for that workspace
- **AND** daemon logs ERROR with recovery details
- **AND** daemon continues running with fresh workspace database

### Requirement: Corruption recovery replaces silent auto-recovery
The existing silent auto-delete logic in openWorkspaceStore() (store.ts:2032-2045) SHALL be replaced with the rename+rebuild+notify policy.

#### Scenario: Corrupted workspace store recovers
- **WHEN** openWorkspaceStore() encounters a corrupted database
- **THEN** corruption recovery is triggered
- **AND** corrupt file is renamed (preserved for forensics)
- **AND** fresh database is created
- **AND** user is notified through all channels

#### Scenario: MCP tool receives recovery warning
- **WHEN** corruption recovery has occurred
- **AND** the first MCP tool call is made after recovery
- **THEN** the tool response includes a warning about the recovery
- **AND** subsequent calls do NOT include the warning

#### Scenario: CLI command sees recovery notification
- **WHEN** corruption recovery has occurred
- **AND** a CLI command is run
- **THEN** the command may see the recovery notification in CORRUPTION_NOTICE.md
- **AND** /health endpoint shows corruption_recovered=true

### Requirement: WAL checkpoint on close
The system SHALL run `PRAGMA wal_checkpoint(PASSIVE)` before closing a database connection.

#### Scenario: Store close checkpoints WAL
- **WHEN** Store.close() is called
- **THEN** WAL checkpoint is executed before db.close()
- **AND** the database closes successfully

### Requirement: Proper SQLite PRAGMAs
The system SHALL configure SQLite with the following PRAGMAs in createStore(): `synchronous=NORMAL`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864`, `busy_timeout=15000`.

#### Scenario: New store has correct PRAGMAs
- **WHEN** createStore() creates a new database
- **THEN** all specified PRAGMAs are set

### Requirement: Single database connection per workspace
The watcher SHALL reuse the Store's database instance instead of creating duplicate connections.

#### Scenario: Watcher reuses store connection
- **WHEN** watcher.reindex() processes a secondary workspace
- **THEN** it uses the Store's exposed `getDb(): Database` method
- **AND** no `new Database()` connection is created to the workspace file
- **NOTE**: Add `getDb(): Database` method to Store interface. Watcher receives Store instance and calls `store.getDb()` instead of `new Database(wsDbPath)`
