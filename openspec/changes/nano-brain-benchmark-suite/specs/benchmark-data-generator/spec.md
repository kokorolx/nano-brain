## ADDED Requirements

### Requirement: Generate synthetic docs by topic clusters
The generator SHALL produce N synthetic documents organized into topic clusters. Each cluster has a fixed topic label, and all docs in the cluster are seeded from that topic. The number of docs per cluster is `N / topic_count`. The generator SHALL support scale levels: 100, 1000, 5000, 10000, 100000.

#### Scenario: Generate 1000 docs across 20 topics
- **WHEN** user runs `npx nano-brain bench generate --scale 1000 --out benchmarks/fixtures/`
- **THEN** 1000 docs are written to the output directory, 50 per topic cluster, each with a unique `id`, `title`, `body`, and `topic` field

#### Scenario: Scale level determines docs-per-topic ratio
- **WHEN** scale is 100 with 20 topics
- **THEN** each topic receives exactly 5 docs (100 / 20)

---

### Requirement: Ground truth is produced at generation time
The generator SHALL emit a `ground-truth.json` file alongside the generated docs. For each topic cluster, it SHALL produce M queries (default: 2 per topic). Each query's `relevant_doc_ids` SHALL be the IDs of all docs in that cluster. This mapping is deterministic — no manual annotation required.

#### Scenario: Ground truth matches generated doc IDs
- **WHEN** generator creates cluster "auth" with docs ["auth-001", "auth-002", ..., "auth-050"]
- **THEN** `ground-truth.json` contains queries for "auth" with `relevant_doc_ids: ["auth-001", ..., "auth-050"]`

#### Scenario: Ground truth file is co-located with docs
- **WHEN** `--out benchmarks/fixtures/scale-1000/` is specified
- **THEN** `benchmarks/fixtures/scale-1000/ground-truth.json` exists after generation

---

### Requirement: Doc content has noise to prevent trivial retrieval
Each generated doc SHALL include noise sentences unrelated to the primary topic, so that simple keyword matching cannot trivially achieve perfect recall. Noise fraction SHALL be configurable (default: 20% of body content).

#### Scenario: Noise prevents 100% FTS precision trivially
- **WHEN** a doc for topic "auth" is generated
- **THEN** the doc body contains at least one sentence not containing any auth-related keywords

---

### Requirement: Generation is deterministic given a seed
The generator SHALL accept a `--seed` integer. Given the same seed and scale, the output SHALL be identical across runs (same doc IDs, same bodies, same ground truth).

#### Scenario: Same seed produces identical output
- **WHEN** `bench generate --scale 1000 --seed 42` is run twice
- **THEN** both runs produce byte-identical `ground-truth.json` and identical doc content

---

### Requirement: Corpus hash is emitted
The generator SHALL write a `corpus.json` metadata file containing a SHA256 hash of the generator seed + topic definitions. This hash is used by `bench compare` to detect corpus drift.

#### Scenario: Corpus hash is stable for same inputs
- **WHEN** generation runs with same seed and topic list
- **THEN** `corpus.json` contains the same `corpus_hash` value across runs
