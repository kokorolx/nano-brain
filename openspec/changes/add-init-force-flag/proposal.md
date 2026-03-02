## Why

When the nano-brain index becomes corrupted, stale, or polluted with incorrectly-tagged data (e.g., from the workspace-scoping bug we just fixed), the only way to get a clean slate is to manually delete the SQLite database file and re-run init. This is error-prone — users may delete the wrong file, lose cross-workspace data, or miss the embeddings cache. A `--force` flag on `init` provides a safe, workspace-scoped reset that clears only the current workspace's data and re-initializes cleanly.

## What Changes

- **`init --force` CLI flag**: When passed, the init command deletes all documents, embeddings, and orphaned content for the current workspace's `projectHash` before running the normal init flow. Documents tagged `'global'` (MEMORY.md, daily logs) and documents from other workspaces are preserved.
- **`store.clearWorkspace(projectHash)` method**: New store method that transactionally removes all workspace-scoped data (documents, FTS entries, embeddings, vectors, orphaned content) for a given projectHash.
- **Help text update**: The init command's help section documents the new `--force` flag.

## Capabilities

### New Capabilities
- `cli-init-force`: Workspace-scoped memory reset via `init --force`, including the `clearWorkspace` store method and CLI flag parsing.

### Modified Capabilities

## Impact

- **Files affected**: `src/types.ts` (Store interface), `src/store.ts` (clearWorkspace implementation), `src/index.ts` (handleInit flag parsing + force logic, help text)
- **Database**: Deletes rows from `documents`, `documents_fts`, `content_vectors`, `vectors_vec`, `content` — all within a transaction, only for the target projectHash.
- **No config changes**: No new config fields.
- **No API changes**: MCP tools unaffected.
- **Risk**: Low — the delete is scoped to a single projectHash and wrapped in a transaction. Global documents and other workspaces are untouched.
