## NEW Requirements

### Requirement: Reset command deletes all nano-brain data
The `reset` command SHALL delete all SQLite databases, harvested session files, and Qdrant vectors when invoked with `--confirm`.

#### Scenario: Reset with --confirm
- **WHEN** `nano-brain reset --confirm` is run
- **THEN** all `.sqlite` files in the data directory are deleted
- **AND** the harvested sessions directory is deleted recursively
- **AND** the Qdrant `nano-brain` collection is deleted (if reachable)
- **AND** a summary of deletions is printed

#### Scenario: Reset without --confirm
- **WHEN** `nano-brain reset` is run without `--confirm`
- **THEN** the command prints an error message requiring `--confirm`
- **AND** no data is deleted

#### Scenario: Reset with --dry-run
- **WHEN** `nano-brain reset --dry-run` is run
- **THEN** the command prints what would be deleted
- **AND** no data is actually deleted

#### Scenario: Qdrant unreachable during reset
- **WHEN** `nano-brain reset --confirm` is run and Qdrant is not reachable
- **THEN** SQLite and session files are still deleted
- **AND** a warning is printed about Qdrant being unreachable
