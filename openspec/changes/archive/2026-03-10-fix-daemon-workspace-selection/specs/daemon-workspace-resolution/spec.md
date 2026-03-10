# daemon-workspace-resolution Specification

## Purpose

The daemon server SHALL be workspace-agnostic — it serves ALL configured workspaces equally. There is no "primary workspace" concept. Each tool call resolves its workspace from explicit parameters or client context. The server startup still needs ONE database for initialization, but this is an implementation detail, not a workspace preference.

## ADDED Requirements

### Requirement: Daemon startup database resolves from cwd

When `startServer()` runs in daemon mode, the startup database SHALL be resolved by checking `process.cwd()` against configured workspaces. If cwd matches a configured workspace path, that workspace's database SHALL be used for initialization. Otherwise, the first configured workspace SHALL be used as fallback. This only affects which database is opened at startup — all workspaces are equally accessible via tool parameters.

#### Scenario: cwd matches a configured workspace

- **WHEN** the server starts in daemon mode with `process.cwd()` = `/path/to/zengamingx`
- **AND** `config.workspaces` contains `/path/to/zengamingx`
- **THEN** the startup database SHALL be the zengamingx database file
- **THEN** the server SHALL log `startup workspace = /path/to/zengamingx`

#### Scenario: cwd does not match any configured workspace

- **WHEN** the server starts in daemon mode with `process.cwd()` = `/tmp/random`
- **AND** `config.workspaces` contains `/path/to/nano-brain` and `/path/to/zengamingx`
- **THEN** the startup database SHALL use the first configured workspace
- **THEN** the server SHALL log a warning indicating cwd did not match any configured workspace

#### Scenario: No workspaces configured

- **WHEN** the server starts in daemon mode
- **AND** `config.workspaces` is empty or undefined
- **THEN** the startup database SHALL use `process.cwd()` as workspace root
- **THEN** behavior SHALL match the existing non-daemon fallback

#### Scenario: Spawned daemon inherits cwd

- **WHEN** `npx nano-brain serve` is run from `/path/to/zengamingx`
- **THEN** the spawned daemon process SHALL inherit the parent's cwd
- **THEN** the startup database SHALL be the zengamingx database
