## Context

`store.ts` currently holds 3,648 lines and 150+ methods across fundamentally different concerns: schema DDL + migrations, document CRUD + FTS, vector embedding storage + Qdrant routing, code graph operations, and LLM cache + telemetry. All of this is a single flat object literal returned from `createStore()`.

The file is imported by `server.ts`, `index.ts`, `watcher.ts`, `codebase.ts`, `harvester.ts`, and `collections.ts`. None of those callers need to change — the split is purely internal.

## Goals / Non-Goals

**Goals:**
- Split `store.ts` into 5 single-concern modules under `src/store/`
- `src/store/index.ts` barrel re-exports everything — zero import path changes anywhere
- Each module is independently readable, testable, and modifiable
- Identical runtime behavior — no method signatures, semantics, or DB schema changes

**Non-Goals:**
- Changing any public API (method names, signatures, return types)
- Changing database schema or migrations
- Adding new functionality
- Changing how callers use the store
- Splitting `server.ts`, `index.ts`, or any other file (those are Phase 2–3)

## Decisions

### Decision 1: Barrel re-export via `src/store/index.ts`

All existing code imports from `'./store.js'`. After the split, `src/store.ts` will be deleted and replaced by `src/store/index.ts` which re-exports everything that was previously exported from `store.ts`.

**Why:** Zero-risk migration. No consumer changes, no broken imports, no coordination needed across files. The TypeScript compiler resolves `'./store.js'` → `src/store/index.ts` automatically (Node ESM with `exports` map or `moduleResolution: bundler`).

**Alternative considered:** Rename the import path everywhere to `'./store/index.js'`. Rejected — touches 6+ files unnecessarily, higher risk of missing one.

### Decision 2: Split boundary = concern, not size

The 5 modules map to 5 distinct concerns, not arbitrary line count targets:

| Module | Concern | Key exports |
|--------|---------|-------------|
| `schema.ts` | DDL, migrations, pragmas, prepared statements | `applySchema()`, `runMigrations()`, `applyPragmas()`, prepared stmt map |
| `documents.ts` | Document lifecycle, FTS5, path resolution, workspace registration | `insertDocument`, `findDocument`, `searchFTS`, `registerWorkspacePrefix`, `toRelative` |
| `vectors.ts` | Embedding insertion, sqlite-vec + Qdrant routing, pending queue | `insertEmbedding`, `searchVec`, `searchVecAsync`, `setVectorStore`, `getHashesNeedingEmbedding` |
| `graph.ts` | File edges, memory entities/connections, symbols, graph analytics | `insertFileEdge`, `getFileEdges`, `insertOrUpdateEntity`, `querySymbols`, `getGraphStats` |
| `cache.ts` | LLM cache, telemetry, corruption recovery, consolidation queue | `getCachedResult`, `setCachedResult`, `logSearchQuery`, `enqueueConsolidation`, `getLastCorruptionRecovery` |

**Why:** Single Responsibility Principle. When the next Qdrant bug occurs, you open `vectors.ts` — not a 3,648-line file. When you need to add a migration, you open `schema.ts`.

### Decision 3: Shared DB connection passed via closure, not module-level singleton

Each submodule's functions will receive the `db: Database.Database` instance (and the prepared statements map) as a parameter, or they'll be created as closures inside `createStore()` that close over `db`.

**Why:** Avoids module-level state (which breaks tests and multi-workspace scenarios). The current `store.ts` already uses this pattern — `db` is a local variable in `createStore()` and all methods close over it. We preserve this.

### Decision 4: `createStore()` stays in `src/store/index.ts`

The factory function that wires everything together lives in the barrel. It delegates schema/migration work to `schema.ts`, then builds the Store object using methods from all 5 submodules.

**Why:** `createStore()` is the composition root — it's the one place that knows about all submodules. Putting it in the barrel keeps the public API surface clean.

## Risks / Trade-offs

**Risk: ESM import resolution for `./store.js` after folder conversion**
→ Mitigation: TypeScript with `"moduleResolution": "bundler"` or `"node16"` resolves `./store.js` to `./store/index.ts`. Verify `tsconfig.json` before starting. If needed, add `"exports"` field to `package.json`.

**Risk: Circular imports between submodules**
→ Mitigation: The dependency graph analysis confirmed no circular deps in the current code. Submodules depend only on `types.ts` and `schema.ts` (for the db/stmts). No submodule imports another submodule.

**Risk: Prepared statements scattered across 3,648 lines are hard to cleanly attribute**
→ Mitigation: All prepared statement initialization moves to `schema.ts`. Submodules receive the `stmts` map as a parameter. If a stmt is only used in one submodule, it's initialized there but still in the central stmts map.

**Risk: Large PR is hard to review**
→ Mitigation: Each submodule extraction is a separate commit. PR can be reviewed file-by-file. Tests (if any exist) run after each commit.

## Migration Plan

1. Verify `tsconfig.json` module resolution supports folder index resolution
2. Create `src/store/` directory
3. Extract `schema.ts` first (DDL + migrations + pragmas + stmts init) — nothing depends on other submodules
4. Extract `vectors.ts` (most isolated, was the source of recent bugs)
5. Extract `graph.ts`
6. Extract `cache.ts`
7. Extract `documents.ts` (largest, most interconnected — last)
8. Create `src/store/index.ts` barrel with `createStore()` + all re-exports
9. Delete `src/store.ts`
10. Run `tsc --noEmit` — zero errors expected
11. Run existing tests if any, smoke-test CLI commands

**Rollback:** `git revert` the PR. Import paths haven't changed so rollback is instant.

## Open Questions

- Does the project have any unit tests for `store.ts`? (If yes, tests stay at `src/store/*.test.ts`)
- Is `src/store.ts` listed in any explicit `exports` field in `package.json`? (Check before deleting)
