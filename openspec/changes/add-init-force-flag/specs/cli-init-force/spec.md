## ADDED Requirements

### Requirement: init --force flag clears workspace memory
The `init` command SHALL accept a `--force` flag. When provided, the command SHALL delete all documents, embeddings, vectors, and orphaned content for the current workspace's `projectHash` before running the normal initialization flow. Documents tagged with `'global'` (cross-workspace notes) SHALL NOT be deleted. Documents belonging to other workspaces SHALL NOT be deleted.

#### Scenario: init --force clears current workspace data
- **WHEN** `nano-brain init --force` is run in workspace `/projects/my-app` with projectHash `abc123def456`
- **THEN** all documents with `project_hash = 'abc123def456'` are deleted from the `documents` table
- **THEN** corresponding FTS entries are removed from `documents_fts`
- **THEN** embeddings for orphaned hashes are removed from `content_vectors` and `vectors_vec`
- **THEN** orphaned content is removed from the `content` table
- **THEN** the normal init flow runs (codebase indexing, session harvesting, collection indexing, embedding generation)

#### Scenario: init --force preserves global documents
- **WHEN** `nano-brain init --force` is run
- **THEN** documents with `project_hash = 'global'` (MEMORY.md, daily logs) are NOT deleted
- **THEN** these documents remain searchable after init completes

#### Scenario: init --force preserves other workspaces
- **WHEN** `nano-brain init --force` is run in workspace A
- **THEN** documents with `project_hash` belonging to workspace B are NOT deleted
- **THEN** content hashes shared between workspace A and B are NOT deleted from the `content` table

#### Scenario: init without --force is unchanged
- **WHEN** `nano-brain init` is run without the `--force` flag
- **THEN** no documents are deleted
- **THEN** the init flow runs identically to the current behavior (incremental indexing, skip unchanged files)

### Requirement: clearWorkspace store method
The `Store` interface SHALL expose a `clearWorkspace(projectHash: string)` method that transactionally deletes all workspace-scoped data for the given projectHash. The method SHALL return `{ documentsDeleted: number; embeddingsDeleted: number }` indicating what was removed.

#### Scenario: clearWorkspace deletes all workspace documents
- **WHEN** `clearWorkspace('abc123def456')` is called
- **THEN** all rows in `documents` where `project_hash = 'abc123def456'` are deleted
- **THEN** corresponding rows in `documents_fts` are deleted
- **THEN** the operation runs within a single SQLite transaction

#### Scenario: clearWorkspace cleans up orphaned content
- **WHEN** `clearWorkspace` deletes documents whose content hashes are not referenced by any remaining document
- **THEN** those hashes are deleted from `content`, `content_vectors`, and `vectors_vec`

#### Scenario: clearWorkspace preserves shared content
- **WHEN** a content hash is referenced by documents in both workspace A and workspace B
- **THEN** calling `clearWorkspace` for workspace A does NOT delete that hash from `content`, `content_vectors`, or `vectors_vec`

### Requirement: init --force output
The `init` command with `--force` SHALL print a summary of what was cleared before proceeding with the normal init output.

#### Scenario: Force init output
- **WHEN** `nano-brain init --force` is run and 42 documents and 15 embeddings are cleared
- **THEN** the output includes a line indicating the cleared counts before the normal init output

### Requirement: Help text documents --force
The CLI help text SHALL document the `--force` flag under the `init` command section.

#### Scenario: Help text shows --force
- **WHEN** `nano-brain --help` is run
- **THEN** the init section includes `--force` with a description of its behavior
