## ADDED Requirements

### Requirement: Documents module owns all document lifecycle and FTS operations
The system SHALL extract document CRUD, FTS5 search, collection management, path resolution, and workspace registration from `store.ts` into `src/store/documents.ts`.

#### Scenario: Insert document
- **WHEN** `insertDocument(doc)` is called with a valid document object
- **THEN** the document is upserted into the `documents` table and indexed in the FTS virtual table

#### Scenario: FTS search returns ranked results
- **WHEN** `searchFTS(query, opts)` is called
- **THEN** results are returned ranked by BM25 score with optional collection/workspace/tag filters applied

#### Scenario: Deactivate document on file deletion
- **WHEN** `deactivateDocument(collection, filePath)` is called
- **THEN** the document's `active` flag is set to false without deleting the row

#### Scenario: Path resolution is workspace-aware
- **WHEN** `toRelative(absolutePath)` is called after `registerWorkspacePrefix(projectHash, root)` has been called
- **THEN** the absolute path is converted to a root-relative path using the registered workspace root

### Requirement: Documents module exposes all path and workspace utility functions
The system SHALL include `registerWorkspacePrefix`, `toRelative`, `resolvePath`, `getWorkspaceRoot`, `getWorkspaceStats`, `removeWorkspace`, `migrateToRelativePaths`, and `cleanupDuplicatePaths` in `documents.ts`.

#### Scenario: Workspace stats are scoped per project
- **WHEN** `getWorkspaceStats(projectHash)` is called
- **THEN** document counts and sizes are returned for that project hash only
