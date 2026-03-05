## ADDED Requirements

### Requirement: Logger module
The system SHALL provide a `src/logger.ts` module that exports a `log(tag: string, message: string)` function for file-based logging.

#### Scenario: Logger disabled by default
- **WHEN** `NANO_BRAIN_LOG` environment variable is not set
- **THEN** all `log()` calls SHALL be no-ops with no file I/O, no string formatting, and no directory creation

#### Scenario: Logger enabled via ENV
- **WHEN** `NANO_BRAIN_LOG` is set to `1`
- **THEN** `log()` calls SHALL append formatted lines to `~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log`

#### Scenario: Log line format
- **WHEN** `log('server', 'MCP started on stdio')` is called with logging enabled
- **THEN** the output line SHALL be `[2026-03-05T07:15:53.376Z] [server] MCP started on stdio\n`

#### Scenario: Log directory auto-creation
- **WHEN** logging is enabled and `~/.nano-brain/logs/` does not exist
- **THEN** the logger SHALL create the directory recursively on first write

#### Scenario: Daily file rotation
- **WHEN** the date changes while the process is running
- **THEN** subsequent log lines SHALL be written to a new file with the current date

### Requirement: Zero overhead when disabled
The logger SHALL impose near-zero CPU overhead when `NANO_BRAIN_LOG` is not set. The guard MUST be a single boolean check before any string operations.

#### Scenario: Performance guard
- **WHEN** logging is disabled
- **THEN** calling `log()` SHALL return immediately after checking a module-level boolean, without evaluating message arguments or performing any I/O

### Requirement: Server lifecycle logging
When logging is enabled, the MCP server SHALL log all lifecycle events: startup, config loading, provider initialization, watcher start, and shutdown.

#### Scenario: Server startup
- **WHEN** the MCP server starts with logging enabled
- **THEN** the log file SHALL contain entries for: workspace path, database path, embedding provider selection, reranker loading, watcher initialization

#### Scenario: Server shutdown
- **WHEN** the MCP server receives SIGTERM or SIGINT
- **THEN** the log file SHALL contain a shutdown entry before the process exits

### Requirement: MCP tool invocation logging
When logging is enabled, every MCP tool call SHALL be logged with the tool name and key parameters.

#### Scenario: Search tool called
- **WHEN** `memory_search` is invoked via MCP with query "test"
- **THEN** the log SHALL contain `[mcp] memory_search query="test"` (or similar)

#### Scenario: Write tool called
- **WHEN** `memory_write` is invoked via MCP
- **THEN** the log SHALL contain `[mcp] memory_write` with the target path

### Requirement: Watcher event logging
When logging is enabled, the file watcher SHALL log file change detections, reindex triggers, and embedding cycles.

#### Scenario: File change detected
- **WHEN** a watched file changes
- **THEN** the log SHALL contain `[watcher] File changed: <path>`

#### Scenario: Reindex cycle
- **WHEN** a reindex cycle completes
- **THEN** the log SHALL contain the number of files scanned, indexed, and skipped

#### Scenario: Embedding cycle
- **WHEN** an embedding batch completes
- **THEN** the log SHALL contain the batch size and number of documents embedded

### Requirement: Store operation logging
When logging is enabled, key store operations SHALL be logged: document inserts, cache hits/misses, and vector operations.

#### Scenario: Document indexed
- **WHEN** a new document is indexed
- **THEN** the log SHALL contain the collection, path, and whether it was new or updated

#### Scenario: Vector search fallback
- **WHEN** vector search fails and falls back to FTS
- **THEN** the log SHALL contain the error reason

### Requirement: Existing stderr output preserved
All existing `console.error()` calls in server.ts that output MCP lifecycle messages SHALL be preserved alongside the new file logging.

#### Scenario: Dual output
- **WHEN** logging is enabled and the server starts
- **THEN** `console.error("[memory] Workspace: ...")` SHALL still appear on stderr AND the same information SHALL appear in the log file

### Requirement: Replace ad-hoc console calls
All existing `console.error("[tag] ...")`, `console.warn("[tag] ...")`, and `console.log("[tag] ...")` calls used for diagnostic output (not user-facing CLI output) SHALL be replaced with or supplemented by `log()` calls.

#### Scenario: Watcher console.log replaced
- **WHEN** the watcher logs `[embed] Embedded N document(s)`
- **THEN** this message SHALL go through the `log()` function instead of (or in addition to) `console.log`

#### Scenario: CLI user-facing output unchanged
- **WHEN** a CLI command like `nano-brain status` runs
- **THEN** `console.log()` calls that produce user-facing output SHALL NOT be replaced with logger calls
