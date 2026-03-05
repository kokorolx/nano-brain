# Spec: VectorStore Interface

## Overview

Provider-agnostic interface for vector storage operations, enabling nano-brain to swap between sqlite-vec, Qdrant, and future vector databases without changing search or indexing logic.

## Interface Contract

### search(embedding, options?) → VectorSearchResult[]
- Input: float32 embedding array, optional filters (limit, collection, projectHash)
- Output: array of { hashSeq, score, hash, seq } sorted by descending score
- Score: 0-1 normalized (1 = identical, 0 = orthogonal)
- Filters: collection and projectHash applied as payload filters (Qdrant) or WHERE clauses (SQLite)

### upsert(point) → void
- Input: VectorPoint with id ("hash:seq"), embedding, and metadata
- Behavior: Insert or replace. Idempotent.

### batchUpsert(points[]) → void
- Input: array of VectorPoints
- Behavior: Chunked upload (max 500 per batch for Qdrant, unbounded for SQLite)
- Error handling: fail entire batch on error (no partial writes)

### delete(id) → void
- Input: point ID ("hash:seq")
- Behavior: Remove single vector. No-op if not found.

### deleteByHash(hash) → void
- Input: document hash
- Behavior: Remove ALL vectors for that document (all seq values)

### health() → VectorStoreHealth
- Output: { ok, provider, vectorCount, dimensions?, error? }
- Used by: `npx nano-brain status` and MCP `memory_status`

### close() → void
- Cleanup: close connections, flush buffers
- Called on process exit

## Provider Requirements

Each provider MUST:
1. Implement all 7 methods
2. Use cosine distance for similarity
3. Return scores normalized to 0-1 range
4. Support concurrent reads (search while upserting)
5. Handle connection failures gracefully (throw, don't crash)

Each provider MAY:
1. Batch internally (chunking strategy is provider-specific)
2. Cache connections (connection pooling)
3. Support additional metadata fields beyond the required set
