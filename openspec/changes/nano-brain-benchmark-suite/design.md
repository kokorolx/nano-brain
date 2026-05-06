## Context

nano-brain is a TypeScript ESM CLI + MCP server backed by SQLite (better-sqlite3) + sqlite-vec for vector search and Ollama for embeddings. The existing CLI has ~12 commands. There is no automated test harness for end-to-end search quality or command correctness today.

The benchmark suite must:
- Run entirely from CLI (`npx nano-brain bench ...`)
- Use an isolated SQLite DB (never touch production data)
- Generate its own synthetic data deterministically (ground truth is known at generation time)
- Clean up after itself
- Produce a JSON result that can be saved as a baseline and compared in future runs

## Goals / Non-Goals

**Goals:**
- Generate N synthetic docs at multiple scale levels (100 / 1k / 5k / 10k / 100k)
- Test every CLI command against the generated DB
- Prove workflow combinations work end-to-end (write→reindex→query, supersede→old gone, harvest→search)
- Measure P@5, R@10, MRR for FTS-only vs vector-only vs hybrid at each scale
- Compare latency curves across scale levels
- Save/compare JSON baselines with PASS/FAIL per metric
- Teardown: delete test DB and all generated artifacts after run

**Non-Goals:**
- CI integration (manual runs only for now)
- Real-world corpus snapshots (synthetic only)
- LLM-dependent consolidation benchmarks (non-deterministic)
- Absolute latency thresholds (hardware-dependent, tracked as observational only)

## Decisions

### D1: Isolated DB via env override, not a separate code path

**Decision**: Pass a `NANO_BRAIN_DB_PATH` env var to point all DB operations at a tmpdir SQLite file. The benchmark runner sets this before spawning CLI subprocesses.

**Alternatives considered**:
- `--db` CLI flag on every command: requires touching every command's arg parser — too invasive
- Separate `BenchStore` class: duplicates storage logic — maintenance burden

**Rationale**: Env var override is the least invasive approach. One env var redirects all storage. Production DB is untouched by construction.

---

### D2: Deterministic data generation via topic clusters

**Decision**: Generator creates docs organized as topic clusters. Each cluster has a topic label, N docs seeded from that topic (title + body generated from a template + random variation), and M queries whose ground truth (`relevant_doc_ids`) is the cluster's doc IDs. Ground truth is known at generation time — no annotation needed.

**Structure:**
```
topics: [
  { id: "auth", label: "JWT authentication middleware", docCount: 10, queryCount: 2 },
  { id: "cache", label: "Redis session caching", docCount: 10, queryCount: 2 },
  ...20 topics total
]
```
At scale 1k: each topic gets `1000 / 20 = 50` docs. At scale 100k: `5000` docs per topic.

**Alternatives considered**:
- LLM-generated docs: non-deterministic, slow, costs tokens
- Pre-written fixture files: doesn't scale beyond a few hundred docs

**Rationale**: Template-based generation is fast, reproducible, and scales to 100k without external dependencies. Ground truth is a byproduct of generation, not a manual step.

---

### D3: Subprocess-based command testing

**Decision**: Each CLI command test spawns `npx nano-brain <cmd>` as a child process with `NANO_BRAIN_DB_PATH` set, captures stdout/stderr, and asserts on output.

**Alternatives considered**:
- Import and call internal functions directly: couples benchmark to internals, breaks on refactors
- HTTP API calls (for server commands): requires server to be running

**Rationale**: Subprocess testing is the most realistic — it tests exactly what a user would run. It also catches CLI routing bugs and arg-parsing issues that unit tests miss.

---

### D4: Three-mode quality measurement (FTS / vector / hybrid)

**Decision**: For each query, run search three times with mode forced via internal API:
1. FTS-only (BM25)
2. Vector-only (cosine similarity, Ollama embeddings)
3. Hybrid (RRF fusion of FTS + vector)

Compare P@5, R@10, MRR across modes. Benchmark asserts that hybrid ≥ max(FTS, vector) on aggregate MRR (with ±0.03 tolerance).

**Rationale**: This proves the value of hybrid search — a core architectural claim of nano-brain. If hybrid regresses below FTS-only, something is broken in the fusion logic.

---

### D5: Baseline format with model + corpus pinning

**Decision**: Baseline JSON includes:
```json
{
  "schema_version": 1,
  "nano_brain_version": "...",
  "timestamp": "...",
  "environment": {
    "ollama_model": "nomic-embed-text:latest",
    "ollama_model_digest": "sha256:...",
    "platform": "linux-x64",
    "node_version": "..."
  },
  "corpus_hash": "sha256:...",
  "scales": {
    "100": { "quality": {...}, "latency": {...}, "commands": {...} },
    "1000": { ... },
    ...
  }
}
```

`corpus_hash` = SHA256 of the generator seed + topic definitions. If corpus changes, `--compare` warns before comparing metrics.

`ollama_model_digest` = output of `ollama show nomic-embed-text --modelfile | sha256sum`. If digest changes, `--compare` warns (model drift may explain metric changes).

---

### D6: Regression thresholds (configurable, with defaults)

| Metric | WARN | FAIL |
|--------|------|------|
| P@5 | drop > 0.05 | drop > 0.10 |
| R@10 | drop > 0.05 | drop > 0.10 |
| MRR | drop > 0.03 | drop > 0.05 |
| Hybrid ≥ FTS assertion | violated | — |
| Command pass rate | < 100% | < 90% |

Latency is **observational only** — tracked in JSON, never a FAIL condition.

---

### D7: Teardown is always guaranteed

**Decision**: Benchmark runner wraps everything in try/finally. On any failure or success, the test DB file is deleted. A `--no-cleanup` flag skips teardown for debugging.

## Risks / Trade-offs

- **Ollama must be running**: Vector search requires Ollama. If Ollama is down, vector-only and hybrid modes fail. Mitigation: benchmark detects Ollama availability at startup and skips vector tests with a clear warning (FTS-only tests still run).

- **100k scale is slow**: Inserting 100k docs + embedding them via Ollama will take minutes. Mitigation: `--scale` flag to run specific levels only (e.g., `--scale 100,1000` for quick smoke test).

- **Embedding non-determinism across platforms**: Same model, different hardware → slightly different cosine scores → reordering. Mitigation: use rank-based metrics only (P@k, MRR), never threshold on raw scores.

- **Template-based docs may be too uniform**: If all docs in a topic cluster are near-identical, vector search will easily find them (high scores) but so will any baseline keyword match — the benchmark becomes too easy. Mitigation: inject noise (unrelated sentences, mixed terminology) into each generated doc.

## Open Questions

- None blocking. Thresholds (D6) can be tuned after first baseline run.
