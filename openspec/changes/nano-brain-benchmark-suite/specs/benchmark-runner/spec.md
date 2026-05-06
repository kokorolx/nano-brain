## ADDED Requirements

### Requirement: Isolated test DB via environment variable
The benchmark runner SHALL set `NANO_BRAIN_DB_PATH` to a tmpdir SQLite file before running any CLI commands. All nano-brain operations during the benchmark SHALL use this isolated DB. The production DB at `~/.nano-brain/data/` SHALL never be touched.

#### Scenario: Production DB is not modified
- **WHEN** `bench run` executes
- **THEN** no file in `~/.nano-brain/data/` has its modified timestamp updated

#### Scenario: Test DB is created in tmpdir
- **WHEN** `bench run` starts
- **THEN** a new SQLite file is created at a path under the system tmp directory

---

### Requirement: All CLI commands are exercised
The runner SHALL test every nano-brain CLI command: `query`, `search`, `vsearch`, `write`, `context`, `code-impact`, `symbols`, `impact`, `harvest`, `reindex`. Each command SHALL be invoked at least once against the test DB. A command test PASSES if it exits with code 0 and produces non-empty stdout.

#### Scenario: All commands pass on generated data
- **WHEN** `bench run --scale 1000` completes
- **THEN** the result JSON contains a `commands` section where every command has `status: "pass"`

#### Scenario: A failing command is reported
- **WHEN** a CLI command exits with non-zero code or empty stdout
- **THEN** the result JSON marks that command as `status: "fail"` with captured stderr

---

### Requirement: Workflow combination tests
The runner SHALL execute the following combination test scenarios:

1. **write→reindex→query**: Write a new doc, trigger reindex, assert `query` returns that doc in top-5.
2. **supersede→query**: Write a doc with `--supersedes <old-id>`, assert old doc does not appear in subsequent query results.
3. **harvest→reindex→search**: Simulate a session file appearing in the sessions dir, trigger reindex, assert `search` finds content from that session.

Each combination test SHALL be reported individually in the result JSON.

#### Scenario: write→reindex→query finds new doc
- **WHEN** a doc with unique title "BENCH_UNIQUE_TOKEN_XYZ" is written, reindex is triggered, and `query "BENCH_UNIQUE_TOKEN_XYZ"` is run
- **THEN** the query result contains the written doc's ID in the top 5 results

#### Scenario: supersede removes old doc from results
- **WHEN** doc A is written, then doc B is written with `--supersedes A`, and `query` is run for A's topic
- **THEN** doc A does not appear in results (superseded_by is set, active=0)

---

### Requirement: Quality metrics measured per scale level
For each scale level, the runner SHALL compute P@5, R@10, and MRR using the ground truth from the generator. Metrics SHALL be computed separately for FTS-only, vector-only, and hybrid search modes. The result SHALL assert that hybrid MRR ≥ max(FTS MRR, vector MRR) − 0.03 (tolerance band).

#### Scenario: Hybrid beats or matches individual modes
- **WHEN** quality metrics are computed at scale 1000
- **THEN** `hybrid.mrr >= max(fts.mrr, vector.mrr) - 0.03` is true

#### Scenario: Metrics are per query and aggregated
- **WHEN** quality suite runs 40 queries (2 per topic × 20 topics)
- **THEN** result contains both per-query entries and aggregate `mean_p5`, `mean_r10`, `mean_mrr`

---

### Requirement: Latency is measured and reported as observational
The runner SHALL measure p50 and p95 insert latency and query latency at each scale level. Latency results SHALL appear in the result JSON under `latency` but SHALL NOT contribute to PASS/FAIL. Latency is never a blocking condition.

#### Scenario: Latency is recorded but does not fail the run
- **WHEN** p95 query latency exceeds any threshold
- **THEN** run still exits 0 and no FAIL is reported for latency

---

### Requirement: Teardown deletes test DB after run
The runner SHALL delete the test DB file and any generated fixture files in tmpdir after the run completes, whether the run succeeded or failed. A `--no-cleanup` flag SHALL skip teardown for debugging.

#### Scenario: Test DB is deleted on success
- **WHEN** `bench run` completes successfully
- **THEN** the tmpdir SQLite file no longer exists

#### Scenario: Test DB is deleted on failure
- **WHEN** a command test throws an unhandled exception
- **THEN** the tmpdir SQLite file is still deleted before process exit

#### Scenario: --no-cleanup retains test DB
- **WHEN** `bench run --no-cleanup` is used
- **THEN** the tmpdir SQLite file remains after run for manual inspection

---

### Requirement: Result is written to JSON
The runner SHALL write a result JSON file to `benchmarks/results/<timestamp>.json`. The file SHALL include: `schema_version`, `nano_brain_version`, `timestamp`, `environment` (platform, node version, ollama model + digest), `corpus_hash`, `scales` (quality + latency + commands per scale level).

#### Scenario: Result JSON is valid and complete
- **WHEN** `bench run --scale 100,1000` completes
- **THEN** `benchmarks/results/<timestamp>.json` exists, is valid JSON, and contains keys: `schema_version`, `environment`, `scales`
