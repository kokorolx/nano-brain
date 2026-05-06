## 1. CLI Scaffolding

- [x] 1.1 Add `bench` command to CLI router in `src/cli.ts` with subcommands: `generate`, `run`, `compare`
- [x] 1.2 Create `src/bench/index.ts` as entry point dispatching to subcommands
- [x] 1.3 Add `--no-cleanup` and `--scale` flags to `bench run` arg parser
- [x] 1.4 Add `--save`, `--force` flags to `bench compare` arg parser

## 2. Data Generator

- [x] 2.1 Create `src/bench/generator.ts` with 20 topic cluster definitions (label, keyword set, noise phrases)
- [x] 2.2 Implement deterministic doc generation: title + body from topic template + seeded random noise (use `--seed` param)
- [x] 2.3 Implement ground truth emission: 2 queries per topic, `relevant_doc_ids` = all doc IDs in that cluster
- [x] 2.4 Implement `corpus_hash` = SHA256(seed + topic definitions JSON)
- [x] 2.5 Write output to `--out` directory: `docs/`, `ground-truth.json`, `corpus.json`
- [x] 2.6 Support scale levels: 100, 1000, 5000, 10000, 100000 (docs per topic = scale / topic_count)

## 3. Isolated Test DB Setup

- [x] 3.1 Implement `setupTestDb()` in `src/bench/runner.ts`: create tmpdir SQLite file, set `NANO_BRAIN_DB_PATH` env var
- [x] 3.2 Implement `teardownTestDb()`: delete tmpdir SQLite file (called in finally block, skipped if `--no-cleanup`)
- [x] 3.3 Verify production DB path is never touched: assert `~/.nano-brain/data/*.sqlite` mtimes are unchanged after run

## 4. Command Test Suite

- [x] 4.1 Implement `runCommandTest(cmd, args, env)`: spawns CLI subprocess, captures stdout/stderr, returns pass/fail + output
- [x] 4.2 Write test cases for: `query`, `search`, `vsearch` against generated docs
- [x] 4.3 Write test cases for: `write`, `reindex` with test DB
- [x] 4.4 Write test cases for: `context`, `symbols`, `code-impact`, `impact` against a small generated codebase fixture
- [x] 4.5 Write test cases for: `harvest` with a synthetic session file injected into tmpdir sessions dir

## 5. Workflow Combination Tests

- [x] 5.1 Implement `write→reindex→query` test: write doc with unique token, reindex, assert token appears in top-5 query results
- [x] 5.2 Implement `supersede→query` test: write doc A, write doc B with `--supersedes A`, assert A absent from query results
- [x] 5.3 Implement `harvest→reindex→search` test: drop synthetic `.md` session file in sessions dir, reindex, assert `search` finds its content

## 6. Quality Metrics

- [x] 6.1 Implement `computeMetrics(results, groundTruth)`: calculates P@5, R@10, MRR per query then aggregates
- [x] 6.2 Implement three-mode quality run: call search API with mode forced to `fts`, `vector`, `hybrid` separately
- [x] 6.3 Assert hybrid MRR ≥ max(fts MRR, vector MRR) − 0.03; record as combination test pass/fail
- [x] 6.4 Detect Ollama availability at startup; skip vector/hybrid modes with warning if Ollama is unreachable

## 7. Latency Measurement

- [x] 7.1 Instrument insert loop: record p50/p95 ms for doc insertion at each scale level
- [x] 7.2 Instrument query loop: record p50/p95 ms for each search mode at each scale level
- [x] 7.3 Include latency in result JSON under `scales.<N>.latency` — observational only, no FAIL condition

## 8. Result JSON

- [x] 8.1 Define TypeScript types for result JSON schema in `src/bench/types.ts`
- [x] 8.2 Collect Ollama model digest: `ollama show nomic-embed-text --modelfile | sha256sum` (or equivalent API call)
- [x] 8.3 Write result JSON to `benchmarks/results/<ISO-timestamp>.json` after run completes
- [x] 8.4 Validate result JSON structure before writing (required keys: `schema_version`, `environment`, `scales`)

## 9. Compare Command

- [x] 9.1 Implement `bench compare <result> <baseline>`: load both JSONs, compute deltas for all gating metrics
- [x] 9.2 Print comparison table: metric | baseline | current | delta | status (PASS/WARN/FAIL)
- [x] 9.3 Implement corpus hash mismatch warning (print warning, continue)
- [x] 9.4 Implement model digest mismatch warning (print warning, continue)
- [x] 9.5 Implement `--save <path>` to copy result to baseline path; refuse without `--force` if file exists
- [x] 9.6 Exit code logic: 0=all pass, 1=any FAIL, 2=any WARN (no FAIL)

## 10. End-to-End Verification

- [x] 10.1 Run full `bench generate --scale 100` + `bench run --scale 100` + `bench compare` cycle manually
- [x] 10.2 Confirm test DB is deleted after run (check tmpdir)
- [x] 10.3 Confirm production DB is untouched (check mtime of `~/.nano-brain/data/*.sqlite`)
- [x] 10.4 Save result as `benchmarks/results/baseline-2026.8.1.json` using `bench compare --save`
- [x] 10.5 Run `bench run --scale 100` a second time and confirm `bench compare` exits 0 (no regression on identical run)
