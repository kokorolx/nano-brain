## 1. Investigate Store API

- [ ] 1.1 Read `src/store/vectors.ts` — confirm `ensureVecTable(dimensions)` signature and whether it checks `vecAvailable` internally
- [ ] 1.2 Read `src/store/index.ts` — confirm `ensureVecTable` is exported on the Store interface/object returned by `createStore()`

## 2. Fix runner.ts

- [ ] 2.1 In `src/bench/runner.ts:insertDocs()`, after `createStore(testDbPath)`, call `store.ensureVecTable(768)` wrapped in a `vecAvailable` guard
- [ ] 2.2 Verify the guard: if sqlite-vec is not available, skip gracefully (no throw, no crash)

## 3. Verify

- [ ] 3.1 Run `npx tsx src/index.ts bench run --scale 100` and confirm vector P@5, R@10, MRR are non-zero
- [ ] 3.2 Run `npx tsx src/index.ts bench run --scale 100` and confirm commands/combo tests still PASS
- [ ] 3.3 Regenerate baseline: copy latest result to `benchmarks/results/baseline-2026.8.2.json`

## 4. Commit

- [ ] 4.1 Commit with message: `fix(bench): initialize vectors_vec table in isolated bench DB`
