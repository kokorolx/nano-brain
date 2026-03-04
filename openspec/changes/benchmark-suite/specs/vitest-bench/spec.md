## ADDED Requirements

### Requirement: Vitest bench files exist for all performance domains
The project SHALL include vitest bench files covering search latency, cache performance, and store operations. Bench files SHALL be located in `test/bench/` and follow the `*.bench.ts` naming convention.

#### Scenario: Running vitest bench executes all benchmark suites
- **WHEN** a developer runs `npx vitest bench`
- **THEN** vitest discovers and executes all `test/bench/*.bench.ts` files
- **AND** outputs benchmark results with ops/sec, margin of error, and sample count for each benchmark

#### Scenario: Bench files are independent of external services
- **WHEN** vitest bench runs in a CI environment without Ollama
- **THEN** all benchmarks complete successfully using synthetic data and mock embeddings
- **AND** no network calls are made to external services

### Requirement: Search latency benchmarks with synthetic data
The vitest bench suite SHALL benchmark FTS search, vector search, and hybrid search using a pre-populated in-memory store with deterministic synthetic data.

#### Scenario: FTS search benchmark
- **WHEN** the FTS search benchmark runs
- **THEN** it measures `store.searchFTS()` throughput against a store containing at least 100 synthetic documents
- **AND** reports ops/sec for simple single-term queries and multi-term queries

#### Scenario: Vector search benchmark
- **WHEN** the vector search benchmark runs
- **THEN** it measures `store.searchVec()` throughput using pre-inserted random embedding vectors of dimension 1024
- **AND** the store contains at least 100 documents with corresponding vector embeddings

#### Scenario: Hybrid search benchmark
- **WHEN** the hybrid search benchmark runs
- **THEN** it measures `hybridSearch()` throughput with a mock embedding provider that returns pre-computed vectors
- **AND** exercises the full RRF fusion pipeline including FTS and vector search paths

### Requirement: Cache performance benchmarks
The vitest bench suite SHALL benchmark cache hit and cache miss paths for the query embedding cache, expansion cache, and reranking cache.

#### Scenario: Cache hit benchmark
- **WHEN** the cache hit benchmark runs
- **THEN** it pre-populates the cache with known entries
- **AND** measures `getCachedResult()` throughput for cache hits

#### Scenario: Cache miss benchmark
- **WHEN** the cache miss benchmark runs
- **THEN** it measures `getCachedResult()` throughput for cache misses (keys not in cache)

### Requirement: Store operation benchmarks
The vitest bench suite SHALL benchmark core store operations including document insertion, embedding insertion, and index health queries.

#### Scenario: Document insertion benchmark
- **WHEN** the document insertion benchmark runs
- **THEN** it measures `insertDocument()` throughput including content hashing and FTS indexing

#### Scenario: Embedding insertion benchmark
- **WHEN** the embedding insertion benchmark runs
- **THEN** it measures `insertEmbedding()` throughput for inserting vectors into the sqlite-vec table

#### Scenario: Index health query benchmark
- **WHEN** the index health benchmark runs
- **THEN** it measures `getIndexHealth()` throughput against a populated store

### Requirement: Shared benchmark fixtures module
A shared fixtures module SHALL exist at `test/bench/fixtures.ts` that provides deterministic synthetic data generation for all bench files.

#### Scenario: Fixtures generate consistent data across runs
- **WHEN** fixtures are generated with the same seed
- **THEN** the same documents, embeddings, and queries are produced every time
- **AND** each bench file can create an isolated store populated with fixture data

### Requirement: Vitest config includes benchmark section
The `vitest.config.ts` SHALL include a `benchmark` configuration section that specifies the bench file include pattern.

#### Scenario: Vitest config enables bench mode
- **WHEN** `npx vitest bench` is executed
- **THEN** vitest uses the configured include pattern `test/bench/**/*.bench.ts`

### Requirement: Package.json includes bench script
The `package.json` SHALL include a `bench` script for convenient benchmark execution.

#### Scenario: npm run bench works
- **WHEN** a developer runs `npm run bench`
- **THEN** it executes `vitest bench` and produces benchmark output
