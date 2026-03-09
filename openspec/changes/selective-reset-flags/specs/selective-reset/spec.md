## ADDED Requirements

### Requirement: Category flags for selective deletion
The `reset` command SHALL support category flags to selectively delete specific data types.

#### Scenario: Single category flag
- **WHEN** `nano-brain reset --databases --confirm` is run
- **THEN** only SQLite files in `~/.nano-brain/data/` are deleted
- **AND** sessions, memory, logs, and vectors are preserved

#### Scenario: Multiple category flags
- **WHEN** `nano-brain reset --databases --sessions --confirm` is run
- **THEN** SQLite files AND sessions directory are deleted
- **AND** memory, logs, and vectors are preserved

#### Scenario: Memory flag
- **WHEN** `nano-brain reset --memory --confirm` is run
- **THEN** only `~/.nano-brain/memory/` directory is deleted

#### Scenario: Logs flag
- **WHEN** `nano-brain reset --logs --confirm` is run
- **THEN** only `~/.nano-brain/logs/` directory is deleted

#### Scenario: Vectors flag
- **WHEN** `nano-brain reset --vectors --confirm` is run
- **THEN** only Qdrant collection is deleted (if reachable)

### Requirement: Backward compatibility
The `reset` command SHALL maintain backward compatibility when no category flags are provided.

#### Scenario: No flags deletes all
- **WHEN** `nano-brain reset --confirm` is run without category flags
- **THEN** ALL categories are deleted (databases, sessions, memory, logs, vectors)
- **AND** behavior is identical to previous implementation

### Requirement: Dry-run with category flags
The `--dry-run` flag SHALL work with category flags to preview selective deletion.

#### Scenario: Dry-run with single flag
- **WHEN** `nano-brain reset --databases --dry-run` is run
- **THEN** only database deletion is previewed
- **AND** no data is deleted

#### Scenario: Dry-run with multiple flags
- **WHEN** `nano-brain reset --databases --sessions --dry-run` is run
- **THEN** database and session deletion are previewed
- **AND** no data is deleted
