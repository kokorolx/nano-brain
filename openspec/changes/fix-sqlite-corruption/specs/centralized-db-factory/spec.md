## ADDED Requirements

### Requirement: Centralized openDatabase() helper
The system SHALL provide a single `openDatabase(path: string)` function in store.ts that creates a Database instance with all required PRAGMAs applied.

#### Scenario: openDatabase applies all PRAGMAs
- **WHEN** openDatabase(path) is called
- **THEN** the returned Database has the following PRAGMAs set:
  - `journal_mode=WAL`
  - `foreign_keys=ON`
  - `busy_timeout=15000`
  - `synchronous=NORMAL`
  - `wal_autocheckpoint=1000`
  - `journal_size_limit=67108864`

#### Scenario: openDatabase runs quick_check
- **WHEN** openDatabase(path) is called on an existing database
- **THEN** `PRAGMA quick_check` is executed
- **AND** if quick_check fails, corruption recovery is triggered (see corruption-recovery spec)

### Requirement: No raw new Database() calls
The codebase SHALL NOT contain any `new Database()` calls outside of openDatabase(). All database creation MUST go through openDatabase().

#### Scenario: createStore uses openDatabase
- **WHEN** createStore() creates a database
- **THEN** it calls openDatabase() internally
- **AND** does not call `new Database()` directly

#### Scenario: All 24 Database calls replaced
- **WHEN** the codebase is searched for `new Database(`
- **THEN** only openDatabase() contains this pattern
- **AND** the following files use openDatabase() instead:
  - index.ts (15 calls)
  - server.ts (4 calls)
  - watcher.ts (1 call)
  - harvester.ts (2 calls)
  - eval/harness.ts (1 call)

### Requirement: Store exposes getDb() method
The Store interface SHALL expose a `getDb(): Database` method to allow reuse of the database connection.

#### Scenario: getDb returns the store's database
- **WHEN** store.getDb() is called
- **THEN** it returns the same Database instance used by the store
- **AND** callers can use it for read operations without creating new connections
