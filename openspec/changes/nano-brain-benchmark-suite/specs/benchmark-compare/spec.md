## ADDED Requirements

### Requirement: Compare result against saved baseline
The `bench compare` command SHALL accept a result JSON file and a baseline JSON file, compute deltas for all gating metrics, and print a table: metric | baseline | current | delta | status. It SHALL exit with code 1 if any metric is in FAIL state, code 2 if any metric is in WARN state, and code 0 if all metrics PASS.

#### Scenario: All metrics pass
- **WHEN** result metrics are within tolerance of baseline
- **THEN** `bench compare` exits 0 and prints "ALL PASS" summary

#### Scenario: A metric fails
- **WHEN** hybrid MRR drops more than 0.05 vs baseline
- **THEN** `bench compare` exits 1 and prints "FAIL" for that metric row

#### Scenario: A metric warns
- **WHEN** hybrid P@5 drops between 0.05 and 0.10 vs baseline
- **THEN** `bench compare` exits 2 and prints "WARN" for that metric row

---

### Requirement: Gating metrics and thresholds
The following metrics are gating (contribute to PASS/FAIL):

| Metric | WARN threshold | FAIL threshold |
|--------|---------------|----------------|
| P@5 (hybrid) | drop > 0.05 | drop > 0.10 |
| R@10 (hybrid) | drop > 0.05 | drop > 0.10 |
| MRR (hybrid) | drop > 0.03 | drop > 0.05 |
| Command pass rate | < 100% | < 90% |
| Hybrid ≥ FTS assertion | violated | — |

Latency SHALL NOT be a gating metric.

#### Scenario: Command pass rate below 90% fails
- **WHEN** 2 out of 12 commands fail (83%)
- **THEN** `bench compare` exits 1 with FAIL on command pass rate

---

### Requirement: Corpus and model drift detection
If the baseline's `corpus_hash` differs from the result's `corpus_hash`, `bench compare` SHALL print a WARNING: "Corpus hash mismatch — results may not be comparable" and continue comparison. If `ollama_model_digest` differs, it SHALL print a WARNING: "Embedding model digest changed — metric shifts may be expected."

#### Scenario: Corpus hash mismatch warns but continues
- **WHEN** baseline corpus_hash != result corpus_hash
- **THEN** warning is printed but comparison proceeds and exits normally

---

### Requirement: Save a result as the new baseline
`bench compare --save <path>` SHALL copy the result JSON to the specified path. If a file already exists at that path, it SHALL refuse unless `--force` is also passed.

#### Scenario: Save fails without --force when file exists
- **WHEN** `bench compare result.json --save baseline.json` is run and `baseline.json` exists
- **THEN** command exits non-zero with error: "baseline.json already exists, use --force to overwrite"

#### Scenario: Save with --force overwrites
- **WHEN** `bench compare result.json --save baseline.json --force` is run
- **THEN** `baseline.json` is overwritten with result.json content
