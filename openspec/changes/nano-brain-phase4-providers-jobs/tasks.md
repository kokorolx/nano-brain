## 1. Move provider files to src/providers/

- [ ] 1.1 Copy `src/embeddings.ts` → `src/providers/embeddings.ts`; fix internal imports (add one `../` level to all relative imports); replace `src/embeddings.ts` with `export * from './providers/embeddings.js';`
- [ ] 1.2 Copy `src/reranker.ts` → `src/providers/reranker.ts`; fix internal imports; replace `src/reranker.ts` with `export * from './providers/reranker.js';`
- [ ] 1.3 Copy `src/llm-provider.ts` → `src/providers/llm-provider.ts`; fix internal imports; replace `src/llm-provider.ts` with `export * from './providers/llm-provider.js';`
- [ ] 1.4 Copy `src/vector-store.ts` → `src/providers/vector-store.ts`; fix internal imports (note: imports `./providers/sqlite-vec.js` and `./providers/qdrant.js` — these become `./sqlite-vec.js` and `./qdrant.js` since they are now siblings); replace `src/vector-store.ts` with `export * from './providers/vector-store.js';`
- [ ] 1.5 Copy `src/expansion.ts` → `src/providers/expansion.ts`; fix internal imports; replace `src/expansion.ts` with `export * from './providers/expansion.js';`

## 2. Move job files to src/jobs/

- [ ] 2.1 Copy `src/watcher.ts` → `src/jobs/watcher.ts`; fix internal imports (add one `../` level); replace `src/watcher.ts` with `export * from './jobs/watcher.js';`
- [ ] 2.2 Copy `src/consolidation.ts` → `src/jobs/consolidation.ts`; fix internal imports; replace `src/consolidation.ts` with `export * from './jobs/consolidation.js';`
- [ ] 2.3 Copy `src/consolidation-worker.ts` → `src/jobs/consolidation-worker.ts`; fix internal imports; replace `src/consolidation-worker.ts` with `export * from './jobs/consolidation-worker.js';`

## 3. Verification

- [ ] 3.1 Run `npx tsc --noEmit` — verify zero new errors (grep for `src/providers/` and `src/jobs/` in output; pre-existing bench.ts + treesitter.ts errors are acceptable)
- [ ] 3.2 Run `npx vitest run 2>&1 | tail -5` — verify 1,518+ tests pass
- [ ] 3.3 Smoke test: `npx nano-brain status` executes without error

## 4. Commit

- [ ] 4.1 Stage all new `src/providers/` files, `src/jobs/` files, and modified shim files
- [ ] 4.2 Commit: `refactor: move provider and job files into src/providers/ and src/jobs/`
