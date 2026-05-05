## Why

Phases 1–3 eliminated the three god-file monoliths (`store.ts`, `index.ts`, `server.ts`). The `src/` root still has 47 files — a flat soup where embedding providers, vector stores, LLM providers, and background job workers all live alongside domain logic. Grouping them by responsibility makes it obvious where to find and add code without reading 47 filenames.

Phase 4 combines what the original plan split into two: providers (5 files) and jobs (3 files). Both are pure file moves — no splitting, no logic changes.

## What Changes

**Providers group** — move into `src/providers/` (alongside existing `qdrant.ts` and `sqlite-vec.ts`):
- `src/embeddings.ts` → `src/providers/embeddings.ts`
- `src/reranker.ts` → `src/providers/reranker.ts`
- `src/llm-provider.ts` → `src/providers/llm-provider.ts`
- `src/vector-store.ts` → `src/providers/vector-store.ts`
- `src/expansion.ts` → `src/providers/expansion.ts`

Each original path becomes a 1-line barrel shim: `export * from './providers/<name>.js';`

**Jobs group** — move into `src/jobs/`:
- `src/watcher.ts` → `src/jobs/watcher.ts`
- `src/consolidation.ts` → `src/jobs/consolidation.ts`
- `src/consolidation-worker.ts` → `src/jobs/consolidation-worker.ts`

Each original path becomes a 1-line barrel shim.

No other files change. All existing import paths continue to work via the shims.

## Capabilities

### New Capabilities

- `provider-modules`: `src/providers/` directory contains all external provider integrations (embedding, reranker, LLM, vector store, query expansion) in one place.
- `job-modules`: `src/jobs/` directory contains all background job workers (file watcher, consolidation) in one place.

### Modified Capabilities

(none — pure file moves, no requirement changes)

## Impact

- **Files moved**: 8 files into subdirectories
- **Files added**: 8 barrel shims at original paths
- **No import changes**: all callers use original paths which now resolve through shims
- **No behavior changes**
- **Tests**: No test changes required
