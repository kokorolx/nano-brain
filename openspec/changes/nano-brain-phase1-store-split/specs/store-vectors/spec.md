## ADDED Requirements

### Requirement: Vectors module owns all embedding storage and vector search
The system SHALL extract embedding insertion, vector search (sqlite-vec + Qdrant routing), VectorStore registration, and pending embedding queries from `store.ts` into `src/store/vectors.ts`.

#### Scenario: External VectorStore is registered and used for search
- **WHEN** `setVectorStore(qdrantStore)` is called and then `searchVecAsync(query, embedding, opts)` is called
- **THEN** the search is dispatched to the registered external VectorStore (Qdrant), not sqlite-vec

#### Scenario: Falls back to sqlite-vec when no external store is registered
- **WHEN** `setVectorStore` has NOT been called and `searchVec(embedding, opts)` is called
- **THEN** the search runs against the local sqlite-vec table

#### Scenario: Pending embeddings are queryable by project
- **WHEN** `getHashesNeedingEmbedding(projectHash)` is called
- **THEN** only document hashes belonging to that projectHash with no existing embedding record are returned

#### Scenario: Batch embedding insertion is atomic per batch
- **WHEN** `insertEmbeddingLocalBatch(items)` is called with N items
- **THEN** all N items are inserted in a single SQLite transaction, or none if an error occurs

#### Scenario: Vector table is created for the correct dimensions
- **WHEN** `ensureVecTable(768)` is called
- **THEN** a sqlite-vec virtual table for 768-dimensional vectors is created if it doesn't already exist

### Requirement: VectorStore getter is always available
The system SHALL export `getVectorStore(): VectorStore | null` so that other modules (consolidation, search) can access the registered external store without importing the Qdrant client directly.

#### Scenario: Returns null when no store registered
- **WHEN** `getVectorStore()` is called before `setVectorStore()`
- **THEN** `null` is returned
