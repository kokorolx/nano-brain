## Architecture Decision: Single Collection with Payload Filtering

Keep the current architecture: one qdrant collection (`nano-brain`) for all workspaces, with `projectHash` and `collection` payload fields for filtering. Per-workspace collections (like OpenCode's `ws-*`) were evaluated and rejected — they break `workspace=all` queries and add routing complexity for no meaningful performance gain at our scale.

## Architecture Decision: Recreate, Don't Migrate

Old 1024-dim vectors cannot be transformed to 3072-dim. Re-embedding is required regardless. A dual-collection approach (`nano-brain-v2` with atomic switch) was evaluated and rejected per KISS/YAGNI — the old vectors are useless, FTS fallback handles the brief gap, and keeping stale data for rollback adds complexity with no value.

## Design

### 1. Fix Silent Error Swallowing

**Files:** `search.ts:490`, `store.ts:1468-1470`

Replace bare `catch {}` with logged degradation:
```typescript
catch (err) {
  log('search', 'vector search failed: ' + (err instanceof Error ? err.message : String(err)));
}
```

This matches the existing pattern in `server.ts:437-448`.

### 2. Startup Dimension Validation

**File:** `server.ts` (after vectorStore.health() call, around line 2650)

After creating the embedding provider and vector store, compare dimensions:
- Get expected dimensions from `embedder.getDimensions()`
- Get actual dimensions from `vectorStore.health().dimensions`
- On mismatch: log warning, set vectorStore to null (disables vector search, FTS fallback activates)
- Message: `"⚠️ Dimension mismatch: qdrant={actual}, embedder={expected}. Vector search disabled. Run: npx nano-brain recreate-vectors"`

Non-fatal — the server continues with FTS-only search.

### 3. Auto-Detect Dimensions

**File:** `server.ts` (vector store initialization)

Currently `qdrant.ts:46` defaults to `this.dimensions = options.dimensions ?? 1024`. Instead, pass the embedding provider's dimensions to the vector store config:
- After `createEmbeddingProvider()`, call `embedder.getDimensions()` 
- Pass this value as `config.vector.dimensions` to `createVectorStore()`
- Fallback to config value if embedder is null

### 4. `recreate-vectors` CLI Command

**File:** `index.ts` (new command handler)

Steps:
1. Load config, create embedding provider, get dimensions
2. Confirm with user (unless `--force` flag)
3. Delete qdrant collection (`nano-brain`)
4. Create new collection with correct dimensions
5. Clear `content_vectors` table in SQLite (all workspace DBs)
6. Clear `llm_cache` table (query embedding cache)
7. Print instructions: `"Run 'npx nano-brain embed' to re-embed documents"`

The existing `embed` command handles batch re-embedding with rate limiting, progress tracking, and resume-on-failure. No changes needed there.

### 5. Metadata in Upsert Pipeline

No code change needed. `VectorPointMetadata` already includes optional `collection` and `projectHash` fields. The `embed` command already populates these from SQLite document metadata. The issue was only with old vectors created before these fields were added.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Rate limiting during re-embed (40 RPM) | Medium | Already handled in embeddings.ts:232-244 with exponential backoff |
| Embedding API failure mid-batch | Low | `embed` command is resumable via `content_vectors` tracking table |
| Concurrent MCP access during re-embed | Expected | FTS fallback works; vector search returns empty until complete |
| Query embedding cache returns stale 1024-dim vectors | Certain | `recreate-vectors` clears `llm_cache` table |
| Orphaned vectors (no SQLite document) | Low | Clean slate — old collection deleted entirely |

## Files Changed

| File | Change |
|------|--------|
| `src/search.ts` | Fix silent `catch {}` at line 490 |
| `src/store.ts` | Fix silent catch at lines 1468-1470 |
| `src/server.ts` | Add startup dimension validation; auto-detect dimensions |
| `src/index.ts` | Add `recreate-vectors` CLI command |
| `src/providers/qdrant.ts` | No changes needed (upsert already supports metadata) |
