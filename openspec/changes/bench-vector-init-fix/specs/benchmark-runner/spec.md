## MODIFIED Requirements

### Requirement: insertDocs initializes vector table before insertion
`insertDocs()` SHALL eagerly initialize the `vectors_vec` virtual table using the embedding dimension from fixture metadata (default: 768) when sqlite-vec is available, before inserting any documents into the isolated DB.

#### Scenario: Successful initialization sequence
- **WHEN** `insertDocs()` is called with a valid fixture path
- **THEN** the sequence SHALL be: `createStore()` → `ensureVecTable(dim)` → insert documents
- **THEN** subsequent vector search queries on that store SHALL succeed without "no such table" errors
