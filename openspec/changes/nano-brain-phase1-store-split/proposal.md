## Why

`store.ts` is a 3,648-line god object with 150+ methods mixing schema DDL, migrations, document CRUD, vector routing, FTS, graph operations, cache management, telemetry, and corruption recovery in a single file. Every bug we've hit (Qdrant not receiving vectors, watcher not finding the vector store, `init --force` silently failing) traces back to this file being impossible to reason about — a variable created 800 lines away silently fails to reach its consumer. Phase 1 splits it into focused modules with clear ownership, no API changes, and zero behavior changes.

## What Changes

- `src/store.ts` is split into `src/store/` with 5 focused submodules
- `src/store/index.ts` barrel re-exports everything — all existing imports across the codebase continue to work unchanged
- No public API changes: `createStore()`, `openWorkspaceStore()`, `resolveWorkspaceDbPath()`, etc. all remain at the same import paths
- Each submodule owns one concern: schema, documents, vectors, graph, or cache

## Capabilities

### New Capabilities

- `store-schema`: Schema DDL, all migrations (v0–v8+), pragma setup, prepared statement initialization
- `store-documents`: Document CRUD, FTS5 search, collection management, path resolution, workspace registration
- `store-vectors`: Embedding insertion, vector search (sqlite-vec + Qdrant routing), `setVectorStore`/`getVectorStore`, pending embedding queries
- `store-graph`: File edges, memory entities, memory connections, infrastructure symbols, graph analytics (PageRank, clustering, cycles, flows)
- `store-cache`: LLM cache, telemetry, search telemetry, corruption recovery, consolidation queue

### Modified Capabilities

<!-- None — this is a structural refactor. No spec-level behavior changes. -->

## Impact

- **`src/store.ts`** → replaced by `src/store/index.ts` barrel + 5 submodules
- **All files importing from `./store.js`** (`server.ts`, `index.ts`, `watcher.ts`, `codebase.ts`, `harvester.ts`, `collections.ts`) → no changes needed (barrel re-exports preserve paths)
- **No runtime behavior changes** — all methods, signatures, and semantics stay identical
- **No database schema changes** — migrations run identically
- **No new dependencies**
