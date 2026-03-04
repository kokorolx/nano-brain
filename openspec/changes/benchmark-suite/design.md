## Context

nano-brain has no performance measurement infrastructure after two major changes (embedding pipeline upgrade with parallel hybrid search, per-chunk embeddings, query embedding cache; and cache project-scoping with workspace-isolated caches). The codebase has 449 passing tests but zero benchmarks. Timing data is scattered across `console.error`/`console.warn` logs with no structured collection. Real-world FTS queries show 1300-2200ms cold vs 5-24ms warm, but nothing tracks this systematically.

The project uses vitest 4.0.18 which includes native bench mode (backed by tinybench, already in node_modules). The CLI router in `src/index.ts` follows a `handleX(globalOpts, commandArgs)` pattern for each subcommand.

## Goals / Non-Goals

**Goals:**
- Vitest bench files with synthetic data for CI-safe regression detection (no Ollama dependency)
- CLI `nano-brain bench` command for real-workspace benchmarks with actual Ollama embeddings
- Coverage of all four performance domains: search latency, embedding throughput, cache performance, store operations
- JSON output and baseline comparison for both modes
- Suite filtering for targeted benchmarking

**Non-Goals:**
- Continuous performance monitoring or dashboards
- Automated regression alerts in CI (just detection via `--compare`)
- Benchmarking the MCP transport layer (stdio/HTTP overhead)
- Profiling or flame graph generation
- Benchmarking the watcher/harvester background processes

## Decisions

### 1. Two separate benchmark modes vs. unified framework

**Decision**: Two distinct modes — vitest bench files (synthetic) and CLI bench command (real data).

**Alternatives considered**:
- Single unified framework that handles both — would require abstracting over vitest bench API and custom runner, adding complexity for no benefit. The two modes serve fundamentally different purposes (CI regression vs. real-world measurement).
- CLI-only with `--synthetic` flag — loses vitest bench's built-in comparison, JSON output, and CI integration.

**Rationale**: Vitest bench is purpose-built for CI with statistical analysis, warmup, and comparison. CLI bench needs real Ollama, real databases, and user-facing output. Keeping them separate means each can use the best tool for its job.

### 2. Synthetic data strategy for vitest bench

**Decision**: Create a shared `test/bench/fixtures.ts` that generates deterministic test data (documents, embeddings, queries) using seeded random. Each bench file imports fixtures and creates a fresh in-memory store.

**Alternatives considered**:
- Pre-built SQLite fixture file checked into repo — brittle across schema changes, large binary in git.
- Shared setup in `beforeAll` — vitest bench doesn't support test lifecycle hooks in the same way; `setup`/`teardown` are per-benchmark-cycle.

**Rationale**: Generated fixtures are schema-resilient, deterministic, and fast to create. Each bench file gets an isolated store, preventing cross-contamination.

### 3. CLI bench architecture

**Decision**: New `src/bench.ts` module exporting `handleBench(globalOpts, commandArgs)`, following the existing CLI handler pattern. Uses `performance.now()` for timing, runs configurable iterations per benchmark, and outputs results to stdout.

**Alternatives considered**:
- Reuse tinybench directly in CLI — adds API surface for marginal benefit. Simple iteration loops with `performance.now()` are sufficient for real-world measurement where statistical rigor matters less than actual numbers.

**Rationale**: Matches existing CLI patterns (`handleCache`, `handleStatus`). The CLI bench is about measuring YOUR system, not producing statistically perfect microbenchmarks — that's what vitest bench is for.

### 4. Embedding benchmarks in vitest (CI) mode

**Decision**: Vitest bench files skip real embedding benchmarks entirely. Only store operations and FTS/mock-vector search are benchmarked in CI.

**Alternatives considered**:
- Mock Ollama server — adds complexity, doesn't measure real embedding performance, and the mock overhead would dominate measurements.
- Use local GGUF provider — requires model download in CI, slow, non-deterministic.

**Rationale**: Embedding throughput is hardware-dependent (GPU vs CPU) and Ollama-dependent. It belongs exclusively in CLI bench where the user's actual hardware and model are used.

### 5. Baseline save/compare for CLI bench

**Decision**: Save baselines to `~/.nano-brain/benchmarks/` as timestamped JSON files. `--compare` loads the most recent baseline and shows deltas with percentage change.

**Alternatives considered**:
- Store in the SQLite database — mixes benchmark metadata with application data.
- Git-tracked baselines — workspace-specific results don't belong in version control.

**Rationale**: `~/.nano-brain/benchmarks/` is user-local, follows the existing `~/.nano-brain/` convention, and JSON files are human-readable.

### 6. Vector search benchmarking without real embeddings (vitest)

**Decision**: Generate random float arrays of the correct dimension (1024) and insert them directly into the vector table. This benchmarks the SQLite-vec distance computation and retrieval, not embedding generation.

**Rationale**: Vector search performance depends on the vec extension's KNN implementation, not on how embeddings were generated. Random vectors produce realistic distance computation workload.

## Risks / Trade-offs

- **[Risk] CLI bench requires Ollama running** → Mitigation: Check Ollama health upfront, skip embedding suite with warning if unavailable. Search and store suites still run.
- **[Risk] Vitest bench with synthetic data may not reflect real performance** → Mitigation: This is by design — synthetic benchmarks detect regressions (relative changes), not absolute performance. CLI bench provides real numbers.
- **[Risk] Large workspace databases may cause CLI bench to run very long** → Mitigation: Default iteration count is low (10 for search, 5 for embed). User can override with `--iterations`.
- **[Trade-off] Random vectors don't produce realistic similarity distributions** → Acceptable: We're benchmarking retrieval speed, not result quality. Quality is covered by functional tests.
- **[Trade-off] No warmup control in CLI bench** → Acceptable: CLI bench measures real-world performance including cold starts. Users who want warmup can run twice.
