## Why

Vector search (`memory_vsearch`) is completely broken — returns "No results found" for ALL queries on ALL workspaces. The hybrid search (`memory_query`) silently degrades to BM25-only. This has been verified through comprehensive testing of all 23 MCP tools.

Root cause: The embedding provider was switched from nomic-embed-text (1024 dims) to voyage-3 (3072 dims), but the qdrant collection was never recreated. Query vectors (3072-dim) cannot search a 1024-dim collection. The error is silently swallowed by a bare `catch {}` in search.ts:490.

Additionally, the 16K existing vectors lack `projectHash` and `collection` metadata in their qdrant payloads, so workspace filtering would fail even if dimensions matched.

## What Changes

1. Fix silent error swallowing in vector search code paths
2. Add startup dimension validation (warn + disable vector search on mismatch)
3. Add `recreate-vectors` CLI command to safely reset the qdrant collection with correct dimensions
4. Auto-detect embedding dimensions from provider instead of hardcoded 1024 default
5. Clear stale caches (query embedding cache, content_vectors tracking) during recreation

## Capabilities

### New Capabilities
- `vector-search-recovery`: CLI command and startup checks to detect and recover from embedding model changes

### Modified Capabilities
- `vector-search`: Fix silent error handling, restore functional vector search after recreation
- `hybrid-search`: Vector component restored, improving search quality beyond BM25-only

## Scope

### In Scope
- Fix silent `catch {}` in search.ts and store.ts
- Startup dimension mismatch detection and warning
- `recreate-vectors` CLI command
- Auto-detect dimensions from embedding provider
- Cache invalidation on model change

### Out of Scope
- code_context relative path resolution
- Workspace name (vs hash) resolution
- memory_status inconsistent workspace enforcement
- memory_status misleading ollama message
- CLI Docker container hang
- OpenCode's ws-* qdrant collections (separate system)
- Per-workspace qdrant collections (current single-collection architecture is correct)

## Migration

After deploying the code changes:
1. Run `npx nano-brain recreate-vectors` to reset the qdrant collection
2. Run `npx nano-brain embed` to re-embed all documents (~$0.50, 2-4 hours)
3. During re-embedding, FTS search continues to work; vector search returns empty until complete
