## ADDED Requirements

### Requirement: CLI detects container runtime via cgroups fallback
The CLI SHALL detect whether it is running inside a container by checking both `/.dockerenv` (Docker) and `/proc/self/cgroup` content (containerd, Docker-in-Docker, and other OCI runtimes). The result SHALL be cached after first evaluation.

#### Scenario: Detection in standard Docker container
- **WHEN** the CLI runs inside a container that has `/.dockerenv` present
- **THEN** `isInsideContainer()` SHALL return `true`

#### Scenario: Detection in containerd-only environment
- **WHEN** the CLI runs inside a container where `/.dockerenv` is absent but `/proc/self/cgroup` contains `docker` or `containerd`
- **THEN** `isInsideContainer()` SHALL return `true`

#### Scenario: Detection on host machine
- **WHEN** the CLI runs on a macOS or Linux host with neither `/.dockerenv` nor container cgroup markers
- **THEN** `isInsideContainer()` SHALL return `false`

#### Scenario: Result is cached
- **WHEN** `isInsideContainer()` is called multiple times in the same process
- **THEN** the filesystem checks SHALL be performed only once

### Requirement: CLI routes HTTP calls to host.docker.internal inside containers
The CLI SHALL use `host.docker.internal` as the HTTP server host when running inside any container, and `localhost` when running on the host.

#### Scenario: Host resolution inside container
- **WHEN** a CLI command executes inside a container and calls `getHttpHost()`
- **THEN** the returned host SHALL be `host.docker.internal`

#### Scenario: Host resolution on macOS host
- **WHEN** a CLI command executes on the macOS host and calls `getHttpHost()`
- **THEN** the returned host SHALL be `localhost`

### Requirement: Container-specific duplicate proxy functions are removed
The CLI SHALL NOT expose `proxyPostContainer`, `proxyGetContainer`, or `detectRunningServerContainer` functions. All container-awareness SHALL be encapsulated inside `proxyPost`, `proxyGet`, and `detectRunningServer` via `getHttpHost()`.

#### Scenario: No Container-suffixed imports in command files
- **WHEN** any CLI command file is compiled
- **THEN** it SHALL NOT import any symbol ending in `Container` from `cli/utils`

### Requirement: docker.ts health checks use dynamic host resolution
The `docker status`, `docker start`, and `docker stop` commands SHALL resolve the nano-brain server host dynamically using `getHttpHost()` rather than hardcoding `localhost`.

#### Scenario: docker status from inside container
- **WHEN** `npx nano-brain docker status` runs inside a container
- **THEN** the health check request SHALL target `http://host.docker.internal:3100/health`

#### Scenario: docker status from host
- **WHEN** `npx nano-brain docker status` runs on the macOS host
- **THEN** the health check request SHALL target `http://localhost:3100/health`

### Requirement: User config qdrant URL is migrated on docker start
On `npx nano-brain docker start`, if `~/.nano-brain/config.yml` contains `vector.url: http://host.docker.internal:6333`, the CLI SHALL rewrite it to `http://qdrant:6333` and log a migration notice.

#### Scenario: Legacy qdrant URL is migrated
- **WHEN** `docker start` runs and config contains `vector.url: http://host.docker.internal:6333`
- **THEN** config SHALL be updated to `http://qdrant:6333` before containers start
- **AND** a migration notice SHALL be printed to stdout

#### Scenario: Already-correct qdrant URL is not modified
- **WHEN** `docker start` runs and config already contains `vector.url: http://qdrant:6333`
- **THEN** config SHALL NOT be modified
