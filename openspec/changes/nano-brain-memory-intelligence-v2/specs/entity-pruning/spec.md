## ADDED Requirements

### Requirement: Schema migration adds pruned_at column
The system SHALL migrate memory_entities table from user_version 7 to 8 by adding a nullable `pruned_at TEXT` column.

#### Scenario: Fresh database initialization
- **WHEN** nano-brain initializes on a new database
- **THEN** memory_entities table includes pruned_at column and user_version is 8

#### Scenario: Existing database migration
- **WHEN** nano-brain starts with user_version 7 database
- **THEN** system adds pruned_at column to memory_entities and sets user_version to 8

### Requirement: Background pruning job runs periodically
The system SHALL run a pruning job in watcher.ts every 6 hours (configurable via pruning.interval_ms).

#### Scenario: Pruning job scheduled
- **WHEN** watcher starts with pruning.enabled = true
- **THEN** pruning job is scheduled to run every pruning.interval_ms milliseconds

#### Scenario: Pruning disabled
- **WHEN** watcher starts with pruning.enabled = false
- **THEN** no pruning job is scheduled

### Requirement: Contradicted entities are soft-deleted after TTL
The system SHALL soft-delete entities marked as contradicted that are older than pruning.contradicted_ttl_days by setting pruned_at to current timestamp.

#### Scenario: Contradicted entity past TTL
- **WHEN** pruning job runs
- **AND** entity has contradicted = true
- **AND** entity created_at is older than 30 days (default)
- **THEN** entity pruned_at is set to current datetime

#### Scenario: Contradicted entity within TTL
- **WHEN** pruning job runs
- **AND** entity has contradicted = true
- **AND** entity created_at is within 30 days
- **THEN** entity pruned_at remains NULL

### Requirement: Orphan entities are soft-deleted after TTL
The system SHALL soft-delete entities with no edges that are older than pruning.orphan_ttl_days.

#### Scenario: Orphan entity past TTL
- **WHEN** pruning job runs
- **AND** entity has zero edges (neither source nor target)
- **AND** entity created_at is older than 90 days (default)
- **THEN** entity pruned_at is set to current datetime

#### Scenario: Entity with edges not pruned
- **WHEN** pruning job runs
- **AND** entity has at least one edge
- **THEN** entity pruned_at remains NULL regardless of age

### Requirement: Hard delete removes soft-deleted entities after retention
The system SHALL permanently delete entities where pruned_at is older than pruning.hard_delete_after_days via weekly job.

#### Scenario: Hard delete after retention period
- **WHEN** weekly hard-delete job runs
- **AND** entity pruned_at is older than 30 days (default)
- **THEN** entity is permanently deleted from memory_entities

#### Scenario: Cascade delete edges
- **WHEN** entity is hard-deleted
- **THEN** all edges referencing that entity (source_id or target_id) are deleted

### Requirement: Pruning processes in batches
The system SHALL process at most pruning.batch_size entities per pruning cycle to avoid long SQLite locks.

#### Scenario: Batch limit respected
- **WHEN** pruning job runs
- **AND** 500 entities qualify for soft-delete
- **AND** batch_size is 100
- **THEN** only 100 entities are soft-deleted in this cycle

### Requirement: Pruned entities excluded from graph queries
The system SHALL exclude entities where pruned_at IS NOT NULL from all knowledge graph queries.

#### Scenario: Graph query excludes pruned
- **WHEN** memory_graph query is executed
- **AND** some entities have pruned_at set
- **THEN** those entities are not returned in results

### Requirement: Pruning configuration
The system SHALL support pruning configuration with defaults:
- enabled: true
- interval_ms: 21600000 (6 hours)
- contradicted_ttl_days: 30
- orphan_ttl_days: 90
- batch_size: 100
- hard_delete_after_days: 30

#### Scenario: Default configuration applied
- **WHEN** no pruning config is provided
- **THEN** system uses default values for all pruning settings
