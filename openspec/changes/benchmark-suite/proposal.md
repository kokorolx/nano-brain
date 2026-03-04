## Why

nano-brain has no performance measurement infrastructure. After two major changes (embedding pipeline upgrade, cache project-scoping), there's no way to detect regressions or validate improvements. Search latency varies wildly — initial FTS queries take 1300-2200ms cold vs 5-24ms warm — but nothing tracks this systematically. Developers need both CI-safe synthetic benchmarks for regression detection and real-workspace benchmarks to measure actual performance with their data and hardware.

## What Changes

- **Vitest bench files**: Synthetic benchmark suite using `vitest bench` with deterministic test data for CI-safe regression detection. Covers search latency (FTS, vector, hybrid), embedding throughput (single, batch), cache performance (hit/miss ratios, speedup), and store operations (insert, query, health check).
- **CLI `bench` command**: New `nano-brain bench` subcommand that runs benchmarks against the user's actual workspace database with real Ollama embeddings. Supports suite filtering (`--suite=search|embed|cache`), iteration control (`--iterations=N`), JSON output (`--json`), baseline save/compare (`--save`, `--compare`).
- **Vitest config update**: Add `benchmark` section to `vitest.config.ts` with include pattern and output options.
- **Package.json script**: Add `bench` script for convenient `npm run bench` execution.

## Capabilities

### New Capabilities
- `vitest-bench`: Vitest bench files with synthetic data for CI-safe performance regression detection across search, embedding, cache, and store operations
- `cli-bench`: CLI `nano-brain bench` command for running benchmarks against real workspace data with suite filtering, iteration control, JSON output, and baseline comparison

### Modified Capabilities
_None. This change adds new capabilities only — no existing spec-level behavior changes._

## Impact

- **Files**: `src/index.ts` (CLI router — add `bench` subcommand), `vitest.config.ts` (add benchmark config), `package.json` (add bench script)
- **New files**: `test/bench/*.bench.ts` (vitest bench files), `src/bench.ts` (CLI bench implementation)
- **Dependencies**: None — vitest bench and tinybench are already available (vitest 4.0.18 includes bench mode natively)
- **Database**: Read-only access to existing workspace databases. No schema changes.
- **External**: CLI bench requires Ollama running with the configured embedding model for embedding benchmarks
