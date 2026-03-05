## Why

nano-brain's vector storage uses sqlite-vec (a SQLite virtual table extension) which has critical reliability issues. The SudoX workspace database was corrupted (`database disk image is malformed`) due to an interrupted embed process — a known weakness of SQLite's single-writer WAL model under concurrent/interrupted writes. This corruption is unrecoverable without a full rebuild (re-scan + re-embed all documents, burning Voyage AI API credits).

Beyond reliability, sqlite-vec limits future growth: no concurrent writes, no production-grade ANN indexing (HNSW), no native filtering during vector search, and a practical ~500MB size ceiling. The current implementation is also tightly coupled — `store.ts` mixes vector operations directly with relational queries, making it impossible to swap backends without rewriting the storage layer.

## What Changes

- **Extract `VectorStore` interface**: Define a provider-agnostic contract for vector operations (search, upsert, delete, health) separate from the relational `Store` interface
- **Implement `QdrantVectorStore`**: First provider using Qdrant's REST API via `@qdrant/js-client-rest`, supporting both local Docker and cloud deployments
- **Keep `SqliteVecStore` as fallback**: Wrap existing sqlite-vec logic behind the same interface for zero-dependency local usage
- **Generalize Docker host detection**: Extract existing `detectOllamaUrl()` pattern into a shared `resolveHostUrl()` utility that auto-resolves `localhost` → `host.docker.internal` inside containers, applicable to any provider URL
- **Add `vector` config section**: Provider selection, URL, API key, and collection name in `config.yml`
- **Dual-store architecture**: SQLite keeps metadata, FTS5/BM25, and cache. VectorStore handles only embeddings and similarity search. Clean separation.

## Capabilities

### New Capabilities
- `vector-store-interface`: Provider-agnostic `VectorStore` interface with search/upsert/delete/health contracts
- `qdrant-provider`: Qdrant vector store implementation with HNSW indexing, concurrent writes, crash recovery, and payload filtering
- `container-host-resolution`: Shared utility that auto-detects Docker/containerd and resolves localhost URLs to host.docker.internal
- `vector-provider-config`: YAML config section for selecting vector backend (qdrant, sqlite-vec, future: pinecone, chroma, weaviate)

### Modified Capabilities
- `search-pipeline`: `searchVec()` delegates to the configured VectorStore provider instead of direct sqlite-vec queries
- `embedding-indexing`: `insertEmbedding()` routes through VectorStore provider; batch upsert support for Qdrant
- `ollama-detection`: Existing `detectOllamaUrl()` refactored to use shared `resolveHostUrl()` utility (DRY)

## Impact

- **New files**: `src/vector-store.ts` (interface + factory), `src/providers/qdrant.ts`, `src/providers/sqlite-vec.ts`, `src/host.ts`
- **Modified files**: `store.ts` (extract vector ops), `embeddings.ts` (refactor detectOllamaUrl), `search.ts` (use VectorStore), `codebase.ts` (use VectorStore for insertEmbedding), `index.ts` (config parsing), `types.ts` (new interfaces)
- **Dependencies**: Add `@qdrant/js-client-rest` (optional peer dep — only needed if provider=qdrant)
- **Config**: New `vector:` section in config.yml with provider/url/apiKey/collection fields
- **Database**: No schema changes to SQLite tables. `vectors_vec` virtual table becomes unused when provider≠sqlite-vec.
- **Breaking**: None. Default provider=sqlite-vec preserves current behavior. Qdrant is opt-in.
- **Migration**: Switching to Qdrant requires re-embedding (vectors stored in new backend). Existing SQLite metadata/FTS untouched.
