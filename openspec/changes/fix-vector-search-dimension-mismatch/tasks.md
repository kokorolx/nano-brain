## Phase 1: Stop the Bleeding

- [x] Fix silent `catch {}` in `src/search.ts:490` — add `log('search', 'vector search failed: ' + err.message)`
- [x] Fix silent catch in `src/store.ts:1468-1470` — same treatment
- [x] Add startup dimension validation in `src/server.ts` — compare embedder.getDimensions() vs vectorStore.health().dimensions, warn + disable vector store on mismatch

## Phase 2: Fix Vector Search

- [x] Auto-detect dimensions from embedding provider in `src/server.ts` — pass embedder dimensions to createVectorStore() instead of relying on hardcoded 1024 default
- [x] Add `recreate-vectors` CLI command in `src/index.ts` — delete collection, create with correct dims, clear content_vectors + llm_cache tables, print next steps
- [x] Run `npx nano-brain recreate-vectors` on production instance (done via qdrant HTTP API: collection recreated with 3072 dims + payload indexes)
- [ ] Clear SQLite tracking tables + restart server + run `npx nano-brain embed` (REQUIRES HOST ACCESS)
- [ ] Verify: memory_vsearch returns results, qdrant collection has 3072 dims, payloads include projectHash
