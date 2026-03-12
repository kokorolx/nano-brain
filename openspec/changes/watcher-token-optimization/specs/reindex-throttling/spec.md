## ADDED Requirements

### Requirement: Global reindex cooldown
The watcher SHALL enforce a minimum interval between completed reindexes. If `triggerReindex()` is called within the cooldown window of the last completed reindex, it SHALL skip the reindex and log the skip.

#### Scenario: Reindex skipped during cooldown
- **WHEN** a reindex completed less than `reindexCooldownMs` (default 600000ms) ago
- **AND** `triggerReindex()` is called without `force=true`
- **THEN** the reindex SHALL be skipped
- **AND** the system SHALL log: `Reindex skipped: cooldown active (Xm remaining)`

#### Scenario: Reindex allowed after cooldown expires
- **WHEN** a reindex completed more than `reindexCooldownMs` ago
- **AND** `triggerReindex()` is called
- **THEN** the reindex SHALL proceed normally

#### Scenario: First reindex after startup
- **WHEN** the watcher starts and no previous reindex has completed (`lastReindexAt` is null)
- **AND** `triggerReindex()` is called
- **THEN** the reindex SHALL proceed without cooldown

#### Scenario: Force bypass ignores cooldown
- **WHEN** `triggerReindex()` is called with `force=true`
- **THEN** the reindex SHALL proceed regardless of cooldown state

### Requirement: Embedding quiet period
The embed cycle SHALL skip embedding when file changes occurred recently. This prevents re-embedding files that are being actively edited.

#### Scenario: Embedding skipped during active editing
- **WHEN** a file change was detected less than `embedQuietPeriodMs` (default 60000ms) ago
- **AND** the embed cycle fires
- **THEN** `embedPendingCodebase()` SHALL NOT be called
- **AND** the system SHALL log: `Embedding skipped: quiet period active (Xs remaining)`

#### Scenario: Embedding proceeds after quiet period
- **WHEN** no file changes have been detected for at least `embedQuietPeriodMs`
- **AND** the embed cycle fires
- **THEN** `embedPendingCodebase()` SHALL proceed normally

#### Scenario: Startup embedding bypasses quiet period
- **WHEN** the watcher starts and the initial 5-second embedding timeout fires
- **THEN** embedding SHALL proceed without checking the quiet period

### Requirement: Configurable throttling parameters
The watcher SHALL accept `reindexCooldownMs` and `embedQuietPeriodMs` in `WatcherConfig` with sensible defaults.

#### Scenario: Default configuration
- **WHEN** `reindexCooldownMs` is not specified in config
- **THEN** the default value SHALL be 600000 (10 minutes)

#### Scenario: Default quiet period
- **WHEN** `embedQuietPeriodMs` is not specified in config
- **THEN** the default value SHALL be 60000 (60 seconds)

#### Scenario: Custom configuration
- **WHEN** `reindexCooldownMs` is set to 300000 in config
- **THEN** the cooldown SHALL be 5 minutes instead of 10

### Requirement: Exclude /tmp from codebase indexing
The system SHALL exclude `/tmp/**` from codebase indexing by default to prevent indexing temporary cloned repositories.

#### Scenario: Files in /tmp are not indexed
- **WHEN** a file exists at `/tmp/some-repo/src/index.ts`
- **AND** the codebase scanner runs
- **THEN** the file SHALL NOT be indexed or embedded

### Requirement: Overlapping workspace detection
The system SHALL warn on startup when workspace paths overlap (one is a prefix of another).

#### Scenario: Overlapping workspaces detected
- **WHEN** workspace A is `/Users/tamlh/workspaces/ShareX`
- **AND** workspace B is `/Users/tamlh/workspaces/ShareX/src`
- **THEN** the system SHALL log a warning: `Overlapping workspaces detected: ShareX/src is inside ShareX — consider removing one`

### Requirement: Throttling observability
All throttling decisions SHALL be logged for debugging and monitoring.

#### Scenario: Cooldown skip logged
- **WHEN** a reindex is skipped due to cooldown
- **THEN** the log SHALL include the remaining cooldown time

#### Scenario: Quiet period skip logged
- **WHEN** embedding is skipped due to quiet period
- **THEN** the log SHALL include the time since last file change

#### Scenario: Stats include throttling state
- **WHEN** `getStats()` is called
- **THEN** the result SHALL include `lastReindexAt`, `lastFileChangeAt`, and whether cooldown/quiet period is active
