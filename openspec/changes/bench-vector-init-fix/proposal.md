## Why

The benchmark runner's isolated test DB never initializes the `vectors_vec` virtual table, causing all vector search quality metrics to report 0.000 instead of real values. This makes the benchmark useless for measuring vector search performance.

## What Changes

- Call `store.ensureVecTable(dimensions)` in `insertDocs()` inside `src/bench/runner.ts` after creating the isolated store, before inserting documents
- Add a fallback for when the sqlite-vec extension is unavailable (skip vector metrics gracefully)
- Update baseline JSON to reflect real vector metrics once fix is in

## Capabilities

### New Capabilities

- `bench-vector-init`: Ensures `vectors_vec` virtual table is initialized in the isolated bench DB so vector search quality metrics (P@5, R@10, MRR) reflect real results

### Modified Capabilities

- `benchmark-runner`: `insertDocs()` now eagerly initializes the vector table (previously only production DB did this lazily via embedding worker)

## Impact

- `src/bench/runner.ts` — `insertDocs()` function
- `src/store/vectors.ts` — `ensureVecTable()` method (read-only, no changes needed)
- `benchmarks/results/baseline-*.json` — baseline will need regeneration after fix
- No API or CLI interface changes
