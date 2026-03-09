# loud-failure-logging Specification

## Purpose
TBD - created by archiving change cli-code-intelligence-and-ux. Update Purpose after archive.
## Requirements
### Requirement: Warning when symbol graph indexing skipped due to missing db
When `indexCodebase()` is called without a `db` parameter and tree-sitter is available, it SHALL log a warning: "Symbol graph indexing skipped: no database connection provided".

#### Scenario: db is undefined but tree-sitter available
- **WHEN** `indexCodebase()` runs with `db` undefined and `isTreeSitterAvailable()` returns true
- **THEN** a warning is logged via `log('codebase', 'WARNING: ...')`

#### Scenario: db is undefined and tree-sitter unavailable
- **WHEN** `indexCodebase()` runs with `db` undefined and `isTreeSitterAvailable()` returns false
- **THEN** no warning is logged (tree-sitter being unavailable is a separate issue)

### Requirement: Warning when tree-sitter is not available
When `indexCodebase()` is called with a valid `db` but tree-sitter is not available, it SHALL log a warning: "Symbol graph indexing skipped: tree-sitter not available".

#### Scenario: db provided but tree-sitter unavailable
- **WHEN** `indexCodebase()` runs with valid `db` and `isTreeSitterAvailable()` returns false
- **THEN** a warning is logged via `log('codebase', 'WARNING: ...')`

