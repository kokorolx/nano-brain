## Why

nano-brain has no automated way to verify search quality or CLI correctness across versions. Publishing a new release today requires manual spot-checking — there is no evidence a change didn't silently degrade recall, break a command, or cause workflow regressions. As the tool grows (new embedding models, ranking changes, new commands), this gap becomes a shipping risk.

## What Changes

- New `bench` CLI command with subcommands: `generate`, `run`, `compare`, `clean`
- Data generator script: produces N synthetic docs across parameterized topic clusters, with deterministic ground truth (`query → relevant_doc_ids` mapping known at generation time)
- Isolated test DB: benchmark runs against a separate SQLite file, never touching production `~/.nano-brain/data/`
- Full command coverage: every CLI command (`query`, `search`, `vsearch`, `write`, `context`, `code-impact`, `symbols`, `impact`, `harvest`, `reindex`) tested against the generated DB
- Workflow combination tests: prove that command pipelines work end-to-end (e.g. `write` → `reindex` → `query` finds the doc; supersede → old doc disappears)
- Performance synergy proof: compare P@5/R@10/MRR for FTS-only vs vector-only vs hybrid at each scale
- Multi-scale runs: 100 / 1k / 5k / 10k / 100k docs — quality and latency measured at each level
- Teardown: test DB and all generated artifacts deleted after each run
- Baseline save/compare: `--save` writes JSON result, `--compare` diffs against it with PASS/FAIL per metric

## Capabilities

### New Capabilities

- `benchmark-data-generator`: Script that generates N synthetic docs organized by topic clusters. Each topic has a set of docs and a set of queries whose ground truth (`relevant_doc_ids`) is known deterministically at generation time. Supports scale levels: 100, 1k, 5k, 10k, 100k.
- `benchmark-runner`: Orchestrates the full benchmark lifecycle — setup isolated test DB, insert generated data, run all CLI commands, measure quality metrics (P@5, R@10, MRR) and latency, run combination/workflow tests, teardown DB, emit JSON result.
- `benchmark-compare`: Loads a saved baseline JSON and compares against a new run result. Outputs a table: metric | baseline | current | delta | PASS/FAIL. Exits with code 1 on regression beyond tolerance thresholds.

### Modified Capabilities

- `cli-code-intelligence`: Benchmark runner will exercise `context`, `symbols`, `code-impact`, `impact` commands against generated codebase fixtures — no spec-level behavior change, implementation only.

## Impact

- New files: `src/bench/`, `benchmarks/fixtures/`, `benchmarks/results/`
- CLI entry point: adds `bench` command to existing CLI router
- No changes to core search, storage, or MCP server
- Test DB is fully isolated — zero risk to production data
- Adds `benchmarks/results/baseline.json` (committed) as regression contract
