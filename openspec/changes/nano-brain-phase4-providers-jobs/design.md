## Context

After Phases 1–3, `src/providers/` already exists with `qdrant.ts` and `sqlite-vec.ts`. Phase 4 extends it with 5 more provider files and creates `src/jobs/` for 3 worker files.

This is the simplest phase — no closures to extract, no context objects, no dispatch loops. Pure file copy + shim.

Consumer map (who imports what):

| File moved | Imported by |
|---|---|
| `embeddings.ts` | `src/cli/commands/{status,init,search,embed,qdrant}.ts`, `src/server/bootstrap.ts`, `src/mcp/tools/memory.ts` (via server/bootstrap) |
| `reranker.ts` | `src/cli/commands/search.ts`, `src/server/bootstrap.ts` |
| `llm-provider.ts` | `src/mcp/tools/memory.ts`, `src/server/bootstrap.ts`, `src/cli/commands/categorize-backfill.ts` |
| `vector-store.ts` | `src/cli/commands/{status,search,embed,qdrant}.ts`, `src/server/bootstrap.ts`, `src/server/utils.ts` |
| `expansion.ts` | `src/server/bootstrap.ts` |
| `watcher.ts` | `src/server/bootstrap.ts` |
| `consolidation.ts` | `src/server/bootstrap.ts`, `src/mcp/tools/memory.ts`, `src/cli/commands/consolidate.ts` |
| `consolidation-worker.ts` | `src/server/bootstrap.ts` |

All consumers import via original paths (e.g., `from '../../embeddings.js'`). Barrel shims at original paths preserve these without any consumer changes.

## Goals / Non-Goals

**Goals:**
- Move 8 files into `src/providers/` and `src/jobs/`
- Place 1-line barrel shims at original paths
- Zero behavior changes

**Non-Goals:**
- Refactoring logic inside any moved file
- Updating consumer import paths (shims handle this)
- Splitting any of the moved files
- Adding tests

## Decisions

### D1: Barrel shim at original path (consistent with all prior phases)

Every moved file gets a 1-line shim at its original path:
```typescript
// src/embeddings.ts (after move)
export * from './providers/embeddings.js';
```

**Alternative considered:** Update all consumer import paths to the new location. Rejected — touching 20+ files for a cosmetic rename introduces unnecessary diff noise and risk. Shims are proven (Phases 1–3).

### D2: Combine Phase 4 + Phase 5 into one commit

Both are pure file moves with identical implementation pattern. Combining reduces the overhead of two separate OpenSpec + Momus cycles for trivially similar work.

### D3: Keep existing src/providers/qdrant.ts and src/providers/sqlite-vec.ts in place

These already live in `src/providers/` — no action needed for them.

## Risks / Trade-offs

- **Circular imports**: Moved files import from `../types.js`, `../logger.js`, etc. After moving one level deeper, these become `../../types.js`. Must update imports inside the moved files. The shims at original paths do NOT need updating. → Mitigation: Each moved file's internal imports must be adjusted for the new depth.
- **`src/consolidation-worker.ts` is a worker thread entry point**: It may be referenced by path string (not just import). Check `consolidation.ts` for `new Worker(...)` calls. → Mitigation: Verify and update any `new Worker(new URL(...))` references to point to new path.

## Migration Plan

1. For each of the 8 files:
   a. Copy file to new location (`src/providers/<name>.ts` or `src/jobs/<name>.ts`)
   b. Fix relative imports inside the copied file (add one `../` level)
   c. Replace original file content with 1-line barrel shim
2. `tsc --noEmit` — verify zero new errors
3. Run tests — verify 1,518+ passing
4. Commit

## Open Questions

- Does `consolidation.ts` reference `consolidation-worker.ts` by file path string for `new Worker(...)`? Must verify before moving. If yes, update the path string in the moved file.
