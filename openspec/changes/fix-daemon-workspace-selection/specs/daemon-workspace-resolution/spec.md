# daemon-workspace-resolution Specification

## Purpose

Smart primary workspace selection in daemon mode — use cwd if it matches a configured workspace, fall back to first configured workspace otherwise.

## ADDED Requirements

### Requirement: Daemon mode primary workspace resolves from cwd

When `startServer()` runs in daemon mode, the primary workspace SHALL be resolved by checking `process.cwd()` against configured workspaces. If cwd matches a configured workspace path, that workspace SHALL be used as primary. Otherwise, the first configured workspace SHALL be used as fallback.

#### Scenario: cwd matches a configured workspace

- **WHEN** the server starts in daemon mode with `process.cwd()` = `/path/to/zengamingx`
- **AND** `config.workspaces` contains `/path/to/zengamingx`
- **THEN** `resolvedWorkspaceRoot` SHALL be `/path/to/zengamingx`
- **THEN** `effectiveDbPath` SHALL point to the zengamingx database file
- **THEN** the server SHALL log `primary workspace = /path/to/zengamingx`

#### Scenario: cwd does not match any configured workspace

- **WHEN** the server starts in daemon mode with `process.cwd()` = `/tmp/random`
- **AND** `config.workspaces` contains `/path/to/nano-brain` and `/path/to/zengamingx`
- **THEN** `resolvedWorkspaceRoot` SHALL be `/path/to/nano-brain` (first configured)
- **THEN** the server SHALL log a warning indicating cwd did not match any configured workspace

#### Scenario: No workspaces configured

- **WHEN** the server starts in daemon mode
- **AND** `config.workspaces` is empty or undefined
- **THEN** `resolvedWorkspaceRoot` SHALL be `process.cwd()`
- **THEN** behavior SHALL match the existing non-daemon fallback

#### Scenario: Spawned daemon inherits cwd

- **WHEN** `npx nano-brain serve` is run from `/path/to/zengamingx`
- **THEN** the spawned daemon process SHALL inherit the parent's cwd
- **THEN** the daemon SHALL resolve primary workspace as `/path/to/zengamingx`
