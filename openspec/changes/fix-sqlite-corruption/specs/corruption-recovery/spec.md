## ADDED Requirements

### Requirement: Corruption triggers rename and rebuild
When database corruption is detected via quick_check, the system SHALL rename the corrupt file and create a fresh database.

#### Scenario: Corrupt database is renamed
- **WHEN** openDatabase() detects corruption via quick_check
- **THEN** the corrupt file is renamed to `{original}.corrupt.{ISO8601_timestamp}`
- **AND** a new empty database is created at the original path
- **AND** schema migrations are applied to the new database
- **AND** the function returns the new healthy database

#### Scenario: Rename preserves corrupt file for forensics
- **WHEN** corruption recovery occurs
- **THEN** the corrupt file remains on disk with .corrupt.{timestamp} suffix
- **AND** the file is NOT deleted

### Requirement: Multi-channel corruption notification
When corruption recovery occurs, the system SHALL notify through multiple channels.

#### Scenario: Corruption logged to stderr
- **WHEN** corruption recovery occurs
- **THEN** an ERROR level log is written with:
  - Original file path
  - New corrupt file path
  - Timestamp
  - Message: "Database corruption detected and recovered"

#### Scenario: CORRUPTION_NOTICE.md updated
- **WHEN** corruption recovery occurs
- **THEN** ~/.nano-brain/CORRUPTION_NOTICE.md is created or appended
- **AND** entry includes:
  - Timestamp
  - Original file path
  - Corrupt file path
  - Instructions for user

#### Scenario: /health endpoint reports recovery
- **WHEN** corruption recovery has occurred since daemon start
- **THEN** GET /health returns `{"corruption_recovered": true, "recovered_at": "<timestamp>", ...}`
- **AND** the response includes the path of the recovered database

#### Scenario: First MCP tool call shows warning
- **WHEN** corruption recovery has occurred
- **AND** the first MCP tool call is made after recovery
- **THEN** the tool response includes a warning message about the recovery
- **AND** subsequent tool calls do NOT include the warning

### Requirement: Same policy for main and workspace DBs
Both the main database and workspace databases SHALL use the same corruption recovery policy.

#### Scenario: Main DB corruption triggers recovery
- **WHEN** main database corruption is detected at startup
- **THEN** rename + rebuild + notify policy is applied
- **AND** daemon continues running with fresh database

#### Scenario: Workspace DB corruption triggers recovery
- **WHEN** workspace database corruption is detected
- **THEN** rename + rebuild + notify policy is applied
- **AND** workspace operations continue with fresh database

### Requirement: Remove silent auto-recovery
The existing silent auto-delete logic in openWorkspaceStore() (store.ts:2032-2045) SHALL be removed and replaced with the rename+rebuild policy.

#### Scenario: No silent deletion
- **WHEN** corruption is detected
- **THEN** the corrupt file is NEVER silently deleted
- **AND** the corrupt file is renamed (preserved)
- **AND** user is notified through all channels
