## ADDED Requirements

### Requirement: CLI bench command exists
The CLI SHALL support a `bench` subcommand that runs performance benchmarks against the user's actual workspace database. The command SHALL follow the existing CLI handler pattern (`handleBench` in `src/bench.ts`, routed from `src/index.ts`).

#### Scenario: Running bench with no arguments
- **WHEN** a user runs `nano-brain bench`
- **THEN** the system runs all benchmark suites (search, embed, cache, store) against the current workspace database
- **AND** outputs results to stdout in human-readable format with operation name, iterations, mean time, min/max, and ops/sec

#### Scenario: Bench command resolves workspace database
- **WHEN** `nano-brain bench` is run from a workspace directory
- **THEN** it uses the same database resolution logic as other commands (`resolveDbPath` with `process.cwd()`)

### Requirement: Suite filtering
The CLI bench command SHALL support filtering by benchmark suite via `--suite` flag.

#### Scenario: Running only search benchmarks
- **WHEN** a user runs `nano-brain bench --suite=search`
- **THEN** only search-related benchmarks execute (FTS, vector, hybrid)
- **AND** embedding, cache, and store benchmarks are skipped

#### Scenario: Running only embedding benchmarks
- **WHEN** a user runs `nano-brain bench --suite=embed`
- **THEN** only embedding-related benchmarks execute (single embed, batch embed)

#### Scenario: Running only cache benchmarks
- **WHEN** a user runs `nano-brain bench --suite=cache`
- **THEN** only cache-related benchmarks execute (hit/miss, speedup)

#### Scenario: Running only store benchmarks
- **WHEN** a user runs `nano-brain bench --suite=store`
- **THEN** only store operation benchmarks execute (insert, query, health)

### Requirement: Iteration control
The CLI bench command SHALL support configuring the number of iterations per benchmark via `--iterations` flag.

#### Scenario: Custom iteration count
- **WHEN** a user runs `nano-brain bench --iterations=50`
- **THEN** each benchmark runs 50 iterations instead of the default
- **AND** results reflect the configured iteration count

#### Scenario: Default iteration count
- **WHEN** a user runs `nano-brain bench` without `--iterations`
- **THEN** search benchmarks run 10 iterations, embedding benchmarks run 5 iterations, cache benchmarks run 20 iterations, and store benchmarks run 20 iterations

### Requirement: JSON output
The CLI bench command SHALL support JSON output via `--json` flag.

#### Scenario: JSON output format
- **WHEN** a user runs `nano-brain bench --json`
- **THEN** results are output as a JSON object with suite names as keys, each containing an array of benchmark results with `name`, `iterations`, `meanMs`, `minMs`, `maxMs`, and `opsPerSec` fields

### Requirement: Baseline save and compare
The CLI bench command SHALL support saving results as a baseline and comparing against a previous baseline.

#### Scenario: Saving a baseline
- **WHEN** a user runs `nano-brain bench --save`
- **THEN** benchmark results are saved to `~/.nano-brain/benchmarks/<timestamp>.json`
- **AND** a human-readable summary is printed to stdout

#### Scenario: Comparing against baseline
- **WHEN** a user runs `nano-brain bench --compare`
- **THEN** the system loads the most recent baseline from `~/.nano-brain/benchmarks/`
- **AND** displays a comparison table showing current vs baseline values with percentage change and delta direction (faster/slower)

#### Scenario: No baseline exists for comparison
- **WHEN** a user runs `nano-brain bench --compare` and no baseline file exists
- **THEN** the system prints a warning message and runs benchmarks without comparison

### Requirement: Search benchmarks against real data
The CLI bench SHALL benchmark search operations against the user's actual workspace database with real indexed documents.

#### Scenario: FTS search benchmark with real data
- **WHEN** the search benchmark suite runs
- **THEN** it executes FTS queries against the workspace database using representative query terms
- **AND** measures cold and warm query latency separately

#### Scenario: Vector search benchmark with real embeddings
- **WHEN** the search benchmark suite runs and Ollama is available
- **THEN** it generates real query embeddings via Ollama and measures vector search latency
- **AND** includes embedding generation time as a separate measurement

#### Scenario: Hybrid search benchmark with real pipeline
- **WHEN** the search benchmark suite runs
- **THEN** it exercises the full hybrid search pipeline including FTS, vector search, RRF fusion, and optional reranking

### Requirement: Embedding throughput benchmarks
The CLI bench SHALL benchmark embedding generation throughput using the user's actual Ollama instance and configured model.

#### Scenario: Single embedding benchmark
- **WHEN** the embedding benchmark suite runs
- **THEN** it measures the time to generate a single embedding for a representative text chunk

#### Scenario: Batch embedding benchmark
- **WHEN** the embedding benchmark suite runs
- **THEN** it measures throughput for embedding multiple chunks sequentially (simulating the indexing pipeline)

### Requirement: Graceful degradation without Ollama
The CLI bench SHALL handle the absence of Ollama gracefully.

#### Scenario: Ollama unavailable
- **WHEN** `nano-brain bench` runs and Ollama is not reachable
- **THEN** embedding benchmarks are skipped with a warning message
- **AND** vector search benchmarks are skipped with a warning message
- **AND** FTS search, cache, and store benchmarks still execute normally

### Requirement: Help text includes bench command
The CLI help output SHALL document the `bench` subcommand and its options.

#### Scenario: Help shows bench usage
- **WHEN** a user runs `nano-brain --help`
- **THEN** the output includes the `bench` command with its flags (`--suite`, `--iterations`, `--json`, `--save`, `--compare`)
