## Context

The `init` command (`src/index.ts` `handleInit()`) currently:
1. Creates/loads config
2. Creates the store (SQLite DB)
3. Indexes codebase files
4. Harvests sessions
5. Indexes collections (memory + sessions)
6. Generates embeddings (capped at 50)

There is no way to clear existing data before re-indexing. The store has `deactivateDocument` and `bulkDeactivateExcept` but no bulk delete by workspace. The database has 5 tables that hold workspace data: `documents`, `documents_fts` (FTS5 virtual table), `content`, `content_vectors`, and `vectors_vec` (sqlite-vec virtual table, optional).

## Goals / Non-Goals

**Goals:**
- Add `--force` flag to `init` that clears all workspace-scoped data before re-indexing
- Implement `clearWorkspace(projectHash)` on the store as a reusable method
- Preserve global documents (MEMORY.md, daily logs tagged `'global'`)
- Preserve other workspaces' data entirely
- Wrap the delete in a transaction for atomicity

**Non-Goals:**
- Adding force to other commands (update, embed, etc.)
- Deleting the database file itself
- Adding a standalone `reset` or `clear` command (could be future work)
- Clearing config — only indexed data is affected

## Decisions

### Decision 1: clearWorkspace as a store method

**Choice**: Add `clearWorkspace(projectHash)` to the `Store` interface and implement it in `createStore()`.

**Rationale**: The store owns all database access. Putting the delete logic there keeps it transactional, testable, and reusable (e.g., a future `reset` CLI command or MCP tool could call it).

**Alternative considered**: Inline SQL in `handleInit()`. Rejected — violates the store abstraction and makes testing harder.

### Decision 2: Delete order to respect foreign keys and FTS triggers

**Choice**: Delete in this order within a single transaction:
1. Collect all documents for the projectHash
2. Delete FTS entries (must happen before document deletion since FTS triggers fire on document delete, but we want explicit control)
3. Delete vector entries from `vectors_vec` for affected hashes
4. Delete tracking entries from `content_vectors` for affected hashes
5. Delete documents from `documents` table
6. Delete orphaned content from `content` table (hashes no longer referenced by any document)

**Rationale**: The `documents` table has an `AFTER DELETE` trigger that deletes from `documents_fts`. However, we also need to clean up `content_vectors`, `vectors_vec`, and `content` — which have no cascading triggers. Explicit deletion in a transaction ensures consistency.

**Important**: Before deleting content/embeddings for a hash, check if the hash is still referenced by documents in other workspaces. Only delete orphaned content.

### Decision 3: Flag placement in init flow

**Choice**: Execute `clearWorkspace()` after store creation and projectHash computation, but before any indexing (codebase, harvest, collections, embeddings).

```
1. Parse args (--force, --root)
2. Load/create config
3. Create store
4. Compute projectHash
5. IF --force: clearWorkspace(projectHash)  ← HERE
6. Index codebase
7. Harvest sessions
8. Index collections
9. Generate embeddings
```

**Rationale**: Clearing before indexing ensures the subsequent init flow starts from a clean state. Clearing after config ensures the config itself is preserved.

## Risks / Trade-offs

- **[Risk] User accidentally passes --force and loses workspace data** → Mitigation: Print a clear message showing what was deleted (document count, embedding count). The data is recoverable by re-running init (it re-indexes from source files). Global data (MEMORY.md) is never touched.
- **[Risk] Shared content hashes between workspaces** → Mitigation: The orphan check (`SELECT COUNT(*) FROM documents WHERE hash = ? AND project_hash != ?`) prevents deleting content still referenced by other workspaces.
- **[Risk] FTS trigger fires during document deletion** → Mitigation: The `AFTER DELETE` trigger on `documents` already handles FTS cleanup. Our explicit FTS deletion is redundant but harmless — the trigger will be a no-op if the FTS row is already gone. This is safer than disabling triggers.
