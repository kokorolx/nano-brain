## ADDED Requirements

### Requirement: Bench runner initializes vectors_vec table in isolated DB
The benchmark runner SHALL call `ensureVecTable(dimensions)` on the isolated store immediately after `createStore()`, before any documents are inserted, so that vector search quality metrics reflect real search results.

#### Scenario: sqlite-vec available, table initialized
- **WHEN** `insertDocs()` is called and sqlite-vec extension loads successfully
- **THEN** `vectors_vec` virtual table SHALL exist in the isolated DB before document insertion begins

#### Scenario: sqlite-vec unavailable, graceful skip
- **WHEN** `insertDocs()` is called and sqlite-vec extension is not available
- **THEN** `ensureVecTable()` SHALL NOT be called and the bench SHALL continue without vector metrics

### Requirement: Vector quality metrics report non-zero values
The benchmark runner SHALL report real P@5, R@10, and MRR values for vector search mode when sqlite-vec is available and pre-computed embeddings are provided.

#### Scenario: Vector search returns results
- **WHEN** bench runs in vector mode with a fixture that includes pre-computed embeddings
- **THEN** P@5, R@10, and MRR SHALL be greater than 0.000

#### Scenario: No embeddings in fixture
- **WHEN** bench runs in vector mode but fixture has no pre-computed embeddings
- **THEN** vector metrics SHALL remain 0.000 and bench SHALL not crash
