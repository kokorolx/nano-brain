## Context

`src/bench/runner.ts:insertDocs()` creates an isolated SQLite DB via `createStore(testDbPath)`. The `createStore()` call successfully loads the sqlite-vec extension (`sqliteVec.load(db)`), setting `vecAvailable = true`. However, `ensureVecTable(dimensions)` — which creates the `vectors_vec` virtual table — is never called in the bench path.

In production, `ensureVecTable()` is triggered lazily by the embedding worker on first embedding insertion. The bench runner never inserts embeddings, so the table is never created. When `measureQuality()` queries `vectors_vec`, SQLite returns an error or empty rows → 0.000 metrics.

## Goals / Non-Goals

**Goals:**
- `vectors_vec` is initialized in the isolated bench DB before quality measurement
- Vector P@5, R@10, MRR report real values (not 0.000) when sqlite-vec is available
- Graceful skip when sqlite-vec extension is unavailable (CI environments without native binary)

**Non-Goals:**
- Inserting real embeddings into the bench DB (bench uses pre-computed embeddings from fixtures)
- Changing the production embedding worker flow
- Modifying `ensureVecTable()` signature or behavior

## Decisions

### Decision 1: Call `ensureVecTable()` eagerly in `insertDocs()`

The bench runner has access to `store` and knows the embedding dimension from fixture metadata (or can use the standard default of `768` for nomic-embed-text). Calling `store.ensureVecTable(768)` immediately after `createStore()` mirrors what the production path does lazily.

**Alternative considered**: Mock the vector table creation inside the runner. Rejected — adds complexity without benefit; `ensureVecTable()` is the canonical path.

### Decision 2: Use dimension `768` as default

The bench fixtures use nomic-embed-text (768-dim). If `fixture.metadata.dimensions` is available, use it; otherwise fall back to `768`. This avoids hardcoding while keeping it simple.

**Alternative considered**: Read dimension from the first embedding in fixtures. Rejected — overkill; 768 is the only dimension used today.

### Decision 3: Wrap in `vecAvailable` guard

`ensureVecTable()` internally checks `state.vecAvailable`. Calling it when the extension isn't loaded is a no-op or throws. Wrap the call in an explicit guard so the bench gracefully degrades in environments without sqlite-vec (CI without native binary).

## Risks / Trade-offs

- [Risk] `ensureVecTable()` is not exposed on the public `Store` type → **Mitigation**: Check if it's already accessible on the returned store object; if not, expose it or call via the internal store instance.
- [Risk] Bench results change after fix (vector metrics no longer 0.000) → **Mitigation**: Regenerate baseline JSON after fix; the change is intentional and expected.
- [Risk] sqlite-vec unavailable in some CI → **Mitigation**: `vecAvailable` guard ensures graceful skip; vector metrics remain 0.000 and tests still pass.
