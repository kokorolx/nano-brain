## ADDED Requirements

### Requirement: Maintenance prepare endpoint
The server SHALL expose `POST /api/maintenance/prepare` that pauses the watcher, checkpoints WAL, and sets a maintenance flag.

#### Scenario: Successful prepare
- **WHEN** POST /api/maintenance/prepare is called and no maintenance is active
- **THEN** watcher is paused
- **AND** WAL checkpoint is executed
- **AND** maintenance flag is set
- **AND** response is 200 with `{"status": "prepared"}`

#### Scenario: Concurrent prepare rejected
- **WHEN** POST /api/maintenance/prepare is called while maintenance is already active
- **THEN** response is 409 with `{"error": "maintenance already in progress"}`

### Requirement: Maintenance resume endpoint
The server SHALL expose `POST /api/maintenance/resume` that reopens the database, restarts the watcher, and clears the maintenance flag.

#### Scenario: Successful resume
- **WHEN** POST /api/maintenance/resume is called while maintenance is active
- **THEN** database is reopened
- **AND** watcher is restarted
- **AND** maintenance flag is cleared
- **AND** response is 200 with `{"status": "resumed"}`

#### Scenario: Resume without active maintenance
- **WHEN** POST /api/maintenance/resume is called with no active maintenance
- **THEN** response is 400 with `{"error": "no maintenance in progress"}`

### Requirement: Maintenance timeout
The server SHALL automatically resume after 5 minutes if no resume call is received after prepare.

#### Scenario: Auto-resume after timeout
- **WHEN** POST /api/maintenance/prepare is called
- **AND** 5 minutes pass without a resume call
- **THEN** server automatically resumes (reopens DB, restarts watcher, clears flag)
- **AND** logs warning: "Maintenance auto-resumed after timeout (no resume call received)"

#### Scenario: Manual resume races with auto-resume timeout
- **WHEN** auto-resume timeout fires
- **AND** CLI calls POST /api/maintenance/resume simultaneously
- **THEN** one operation succeeds and the other is a no-op
- **AND** system ends in consistent resumed state (maintenance flag cleared, watcher running)
- **NOTE**: Implementation SHALL use atomic flag check-and-clear to prevent double-resume

### Requirement: In-flight requests during maintenance
The server SHALL allow in-flight requests to complete before entering maintenance mode. New requests received after maintenance is active SHALL receive 503 responses.

#### Scenario: In-flight requests complete during prepare
- **WHEN** POST /api/maintenance/prepare is called
- **AND** requests are currently being processed
- **THEN** in-flight requests complete normally
- **AND** new requests after prepare returns receive 503 with `{"error": "maintenance in progress"}`

### Requirement: Container CLI refuses destructive operations
The CLI SHALL detect when running inside a container (via `/.dockerenv` or equivalent) and refuse destructive operations (`init --force`, `init --force --all`). Destructive operations MUST be run on the host directly.

#### Scenario: init --force from container
- **WHEN** `init --force` is executed from inside a container
- **THEN** CLI prints error: "Destructive operations must be run on the host, not from containers. Run this command directly on the host."
- **AND** command exits with non-zero status
- **AND** no maintenance/prepare call is made
- **AND** no database files are modified

### Requirement: CLI calls maintenance endpoints on host
The CLI `init --force` command (running on host) SHALL call maintenance endpoints when a daemon is detected running.

#### Scenario: init --force on host with running daemon
- **WHEN** `init --force` is executed on the host
- **AND** daemon is detected via detectRunningServer()
- **THEN** CLI calls POST /api/maintenance/prepare
- **AND** waits for 200 response
- **AND** performs destructive operation
- **AND** calls POST /api/maintenance/resume

#### Scenario: init --force on host with unreachable daemon
- **WHEN** `init --force` is executed on the host
- **AND** daemon is detected but maintenance/prepare fails
- **THEN** CLI prints warning: "Daemon detected but unreachable. Stop the daemon first: launchctl unload ~/Library/LaunchAgents/com.nano-brain.server.plist"
- **AND** command exits with non-zero status

#### Scenario: init --force on host with no daemon
- **WHEN** `init --force` is executed on the host
- **AND** no daemon is detected
- **THEN** CLI proceeds with destructive operation directly
