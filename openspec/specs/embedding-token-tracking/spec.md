# embedding-token-tracking Specification

## Purpose
TBD - created by archiving change enhance-status-command. Update Purpose after archive.
## Requirements
### Requirement: Token usage is captured from embedding API responses
The system SHALL extract `usage.total_tokens` from each successful embedding API response and accumulate it per model in persistent storage.

#### Scenario: Successful embedding with usage data
- **WHEN** an embedding API call returns a response with `usage.total_tokens`
- **THEN** the system SHALL increment the cumulative token count for that model in the `token_usage` SQLite table and increment the request count by 1

#### Scenario: Embedding response without usage data
- **WHEN** an embedding API call returns a response without a `usage` field (e.g., Ollama)
- **THEN** the system SHALL NOT write to the token_usage table and SHALL NOT error

### Requirement: Token usage is persisted in SQLite
The system SHALL store cumulative token usage in a `token_usage` table with columns: model (TEXT PRIMARY KEY), total_tokens (INTEGER), request_count (INTEGER), last_updated (TEXT).

#### Scenario: First embedding for a new model
- **WHEN** the first embedding response is received for a model not yet in the table
- **THEN** the system SHALL insert a new row with the token count and request_count=1

#### Scenario: Subsequent embeddings for existing model
- **WHEN** an embedding response is received for a model already in the table
- **THEN** the system SHALL atomically increment total_tokens and request_count, and update last_updated

### Requirement: CLI status displays token usage
The `status` CLI command SHALL display a "Token Usage" section showing per-model cumulative tokens, request count, and last updated timestamp when token usage data exists.

#### Scenario: Token usage data exists
- **WHEN** user runs `npx nano-brain status` and the token_usage table has rows
- **THEN** status output SHALL include a "Token Usage" section listing each model with its total tokens, request count, and last updated time

#### Scenario: No token usage data
- **WHEN** user runs `npx nano-brain status` and the token_usage table is empty
- **THEN** the "Token Usage" section SHALL be omitted from the output

### Requirement: Token usage callback is non-blocking
The token usage recording SHALL NOT block or slow down the embedding pipeline. Recording failures SHALL be logged but SHALL NOT cause embedding operations to fail.

#### Scenario: SQLite write fails during token recording
- **WHEN** the token_usage table write fails (e.g., disk full)
- **THEN** the embedding operation SHALL complete successfully and a warning SHALL be logged

