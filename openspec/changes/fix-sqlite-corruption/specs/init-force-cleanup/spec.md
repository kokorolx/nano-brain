## ADDED Requirements

### Requirement: init --force deletes and recreates workspace DB
The `init --force` command (without `--all`) SHALL delete the workspace database file and recreate it, rather than soft-deleting rows.

#### Scenario: init --force recreates workspace DB
- **WHEN** `init --force` is executed for a workspace
- **THEN** the workspace .sqlite file is deleted
- **AND** a new empty database is created
- **AND** schema migrations are applied

#### Scenario: init --force handles missing DB
- **WHEN** `init --force` is executed
- **AND** the workspace database file does not exist
- **THEN** a new database is created normally

### Requirement: init --force --all deletes WAL and SHM files
The `init --force --all` command SHALL delete `-wal` and `-shm` files in addition to `.sqlite` files.

#### Scenario: init --force --all cleans all SQLite artifacts
- **WHEN** `init --force --all` is executed
- **THEN** all `.sqlite` files are deleted
- **AND** all `-wal` files are deleted
- **AND** all `-shm` files are deleted

#### Scenario: init --force --all handles orphaned WAL/SHM
- **WHEN** `init --force --all` is executed
- **AND** orphaned `-wal` or `-shm` files exist without corresponding `.sqlite`
- **THEN** the orphaned files are deleted

### Requirement: Cleanup respects daemon coordination
The cleanup operations SHALL only proceed after successful daemon coordination (if daemon is running).

#### Scenario: Cleanup waits for daemon prepare
- **WHEN** `init --force` or `init --force --all` is executed
- **AND** daemon is running
- **THEN** cleanup waits for successful /api/maintenance/prepare response before deleting files
