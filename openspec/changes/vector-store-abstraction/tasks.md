# Tasks: Vector Store Abstraction

## Phase 1: Foundation (no behavior change)

### 1.1 Create host resolution utility
- [ ] Create `src/host.ts` with `isInsideContainer()` and `resolveHostUrl()`
- [ ] Cache detection result (check once, reuse)
- [ ] Handle: /.dockerenv, /proc/1/cgroup (docker + containerd)
- [ ] Regex replace: localhost and 127.0.0.1 → host.docker.internal
- [ ] Unit test: mock fs access for container/non-container scenarios

### 1.2 Refactor detectOllamaUrl
- [ ] Replace `detectOllamaUrl()` in embeddings.ts with `resolveHostUrl('http://localhost:11434')`
- [ ] Remove inline Docker detection code from embeddings.ts
- [ ] Verify Ollama connection still works in both Docker and native environments

### 1.3 Define VectorStore interface
- [ ] Create `src/vector-store.ts` with interface, types, and factory function
- [ ] Define: VectorStore, VectorPoint, VectorSearchResult, VectorSearchOptions, VectorStoreHealth
- [ ] Export factory: `createVectorStore(config, db?)`

### 1.4 Extract SqliteVecStore
- [ ] Create `src/providers/sqlite-vec.ts`
- [ ] Move vector-specific code from store.ts: searchVec SQL, insertEmbedding, ensureVecTable, cleanOrphanedEmbeddings
- [ ] Implement VectorStore interface (wrap sync SQLite calls in async)
- [ ] Store.ts constructor accepts VectorStore dependency
- [ ] Verify: all existing tests pass, zero behavior change

## Phase 2: Qdrant Provider

### 2.1 Implement QdrantVecStore
- [ ] Create `src/providers/qdrant.ts`
- [ ] Add `@qdrant/js-client-rest` as optional peer dependency
- [ ] Implement: ensureCollection (create if not exists, cosine distance)
- [ ] Implement: search (with collection/projectHash payload filters)
- [ ] Implement: upsert + batchUpsert (500 points/batch chunking)
- [ ] Implement: delete + deleteByHash
- [ ] Implement: health (collection info → vector count, status)
- [ ] Use resolveHostUrl() for URL resolution

### 2.2 Add vector config section
- [ ] Extend config.yml schema: vector.provider, vector.url, vector.apiKey, vector.collection
- [ ] Parse in index.ts config loading
- [ ] Default: provider=sqlite-vec (backward compatible)
- [ ] Validate: warn if provider=qdrant but @qdrant/js-client-rest not installed

### 2.3 Wire into search pipeline
- [ ] search.ts: searchVec() delegates to vectorStore.search() + SQLite metadata JOIN
- [ ] codebase.ts: insertEmbedding routes through vectorStore.upsert/batchUpsert
- [ ] store.ts: clearWorkspace/cleanOrphanedEmbeddings calls vectorStore.deleteByHash

### 2.4 Update CLI and MCP server
- [ ] `npx nano-brain status` shows vector provider info (provider name, health, vector count)
- [ ] `npx nano-brain embed` works with both providers
- [ ] MCP `memory_status` tool includes vector provider in response

## Phase 3: Validation

### 3.1 Integration testing
- [ ] Test sqlite-vec provider: search, upsert, delete (existing behavior)
- [ ] Test qdrant provider against local Docker instance
- [ ] Test host resolution: localhost → host.docker.internal in container
- [ ] Test config switching: sqlite-vec ↔ qdrant without data loss in SQLite

### 3.2 Documentation
- [ ] Update README with vector provider config section
- [ ] Add Docker Compose example for Qdrant
- [ ] Document migration steps: sqlite-vec → qdrant (re-embed required)
