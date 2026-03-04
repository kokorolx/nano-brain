## 1. Infrastructure & Config

- [ ] 1.1 Add `benchmark` section to `vitest.config.ts` with include pattern `test/bench/**/*.bench.ts`
- [ ] 1.2 Add `"bench": "vitest bench"` script to `package.json`
- [ ] 1.3 Create `test/bench/` directory and shared `test/bench/fixtures.ts` module with seeded deterministic data generation (documents, embeddings, queries)

## 2. Vitest Bench Files

- [ ] 2.1 Create `test/bench/search.bench.ts` — FTS search (simple + multi-term), vector search (random 1024-dim vectors), hybrid search (mock embedder) benchmarks against synthetic store
- [ ] 2.2 Create `test/bench/cache.bench.ts` — cache hit and cache miss benchmarks for `getCachedResult()`/`setCachedResult()`
- [ ] 2.3 Create `test/bench/store.bench.ts` — `insertDocument()`, `insertEmbedding()`, `getIndexHealth()` benchmarks against synthetic store

## 3. CLI Bench Implementation

- [ ] 3.1 Create `src/bench.ts` with `handleBench(globalOpts, commandArgs)` — parse `--suite`, `--iterations`, `--json`, `--save`, `--compare` flags
- [ ] 3.2 Implement search benchmark suite in `src/bench.ts` — FTS (cold/warm), vector search (with real Ollama embeddings), hybrid search against real workspace database
- [ ] 3.3 Implement embedding benchmark suite in `src/bench.ts` — single embed and batch embed throughput using real Ollama
- [ ] 3.4 Implement cache benchmark suite in `src/bench.ts` — cache hit/miss measurement and speedup ratio calculation
- [ ] 3.5 Implement store benchmark suite in `src/bench.ts` — insertDocument, insertEmbedding, getIndexHealth against real database
- [ ] 3.6 Implement baseline save (`--save` to `~/.nano-brain/benchmarks/<timestamp>.json`) and compare (`--compare` loads most recent baseline, shows delta table)
- [ ] 3.7 Implement JSON output mode (`--json`) and human-readable table output (default)

## 4. CLI Integration

- [ ] 4.1 Add `bench` case to CLI router in `src/index.ts` — import and call `handleBench`
- [ ] 4.2 Add bench command documentation to `showHelp()` in `src/index.ts`
- [ ] 4.3 Add Ollama health check at bench startup — skip embed/vector suites with warning if unavailable

## 5. Verification

- [ ] 5.1 Run `npx vitest bench` and verify all synthetic benchmarks execute successfully
- [ ] 5.2 Run `nano-brain bench` against real workspace and verify all suites produce results
- [ ] 5.3 Verify `--suite`, `--json`, `--save`, `--compare` flags work correctly
- [ ] 5.4 Run existing test suite (`npx vitest run`) to confirm no regressions
