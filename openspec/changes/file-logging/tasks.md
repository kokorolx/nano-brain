## 1. Logger Module

- [x] 1.1 Create `src/logger.ts` with `log(tag, message)` function, `NANO_BRAIN_LOG` env check, file append to `~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log`, auto-create logs directory, daily rotation by filename, boolean guard for zero overhead when disabled

## 2. Instrument Server

- [x] 2.1 Instrument `src/server.ts` — add log calls for: server startup, config loading, provider init (embedding/reranker), watcher start, shutdown, singleton guard events. Keep existing `console.error` calls alongside logger
- [x] 2.2 Add MCP tool invocation logging to every `server.tool()` handler in `src/server.ts` — log tool name and key parameters (query, path, collection, etc.)

## 3. Instrument Watcher & Background Processes

- [x] 3.1 Instrument `src/watcher.ts` — log file change events, reindex cycle start/completion with stats, embedding cycle results, storage eviction events, integrity check results
- [x] 3.2 Instrument `src/codebase.ts` — log batch progress, file indexing, graph computation, storage budget decisions
- [x] 3.3 Instrument `src/harvester.ts` — log session harvest start/completion, re-harvest triggers, write failures

## 4. Instrument Core Modules

- [x] 4.1 Instrument `src/store.ts` — log document insert/update, vector insert failures, workspace clear operations, FTS/vec search calls
- [x] 4.2 Instrument `src/embeddings.ts` — log provider selection (ollama/openai/local), model context detection, rate limiting waits, retry attempts, fallback to local GGUF
- [x] 4.3 Instrument `src/search.ts` — log hybrid search pipeline stages (FTS, vec, expansion, reranking, fusion), cache hits/misses
- [x] 4.4 Instrument `src/reranker.ts` — log model loading, rerank batch sizes
- [x] 4.5 Instrument `src/storage.ts` — log config parsing warnings, disk space checks, eviction decisions
- [x] 4.6 Instrument `src/collections.ts` — log config load/save, collection scan results

## 5. Instrument CLI Entry Point

- [x] 5.1 Instrument `src/index.ts` — log CLI command dispatch, init steps, search/embed operations. Do NOT replace user-facing `console.log` output

## 6. Verification

- [x] 6.1 Run `npx tsc --noEmit` to verify no type errors across all modified files
- [x] 6.2 Run `npm test` to verify existing tests pass (630/631 pass; 1 pre-existing failure in watcher embed test unrelated to logger)
- [x] 6.3 Manual test: run `NANO_BRAIN_LOG=1 npx nano-brain status` and verify log file is created with entries
- [x] 6.4 Manual test: run `npx nano-brain status` (without env) and verify NO log file is created
