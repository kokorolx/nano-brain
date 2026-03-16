## Context

nano-brain is a persistent memory MCP server for AI coding agents. Phase 3 introduced entity extraction and a knowledge graph (memory_entities, memory_edges tables). Current state:
- Entities are CREATE-only with no DELETE paths
- Contradicted entities are marked but never cleaned
- Keyword-based categorization uses 7 regex patterns, misses nuance
- Search results are unpersonalized despite telemetry (query logs, access counts, Thompson Sampling)

Constraints:
- Must not impact write latency (memory_write is hot path)
- SQLite single-writer model requires batch operations
- LLM calls available free via ai-proxy (Copilot Enterprise)
- Existing watcher.ts scheduler pattern for background jobs

## Goals / Non-Goals

**Goals:**
- Prevent unbounded knowledge graph growth via automated pruning
- Improve categorization quality using LLM (async, no latency impact)
- Personalize search results based on user behavior patterns
- Maintain zero external runtime dependencies

**Non-Goals:**
- Backfill LLM categorization on existing memories
- Custom user-defined categories
- Entity merging (combine near-duplicate entities)
- Access-pattern-based entity pruning (v2 scope)
- Global preference aggregation across workspaces
- Explicit feedback signals for preference learning
- Recovery CLI for pruned entities

## Decisions

### D1: Soft Delete + Hard Delete Two-Phase Pruning

**Decision**: Soft-delete entities immediately (set pruned_at), hard-delete after 30-day retention.

**Rationale**: Allows recovery window if pruning is too aggressive. Matches existing supersede pattern. Avoids FK cascade complexity during soft-delete phase.

**Alternatives considered**:
- Immediate hard delete: No recovery, risky for new feature
- Archive to separate table: Extra complexity, storage overhead

### D2: Fire-and-Forget LLM Categorization

**Decision**: Async LLM call after keyword categorization completes, no await in write path.

**Rationale**: Proven pattern from entity extraction. Zero write latency impact. Graceful degradation (keyword tags always available).

**Alternatives considered**:
- Sync LLM call: Adds 500ms+ to every write
- Queue-based: Over-engineered for single-server architecture

### D3: Category Weights via Expand Rate

**Decision**: Compute weights as expand_rate / baseline, clamped to 0.5-2.0.

**Rationale**: Expand rate is strongest signal of user interest (user explicitly requested more results). Simple ratio avoids complex ML models. Clamping prevents runaway weights.

**Alternatives considered**:
- Click-through rate: Not tracked, would need new telemetry
- Explicit ratings: Requires UI changes, user friction
- ML model: Over-engineered for v1

### D4: Single Schema Migration

**Decision**: One migration (user_version 7→8) adds pruned_at column only.

**Rationale**: Preference weights stored in existing workspace_profiles JSON field. LLM categories use existing tags system. Minimizes migration complexity.

### D5: Batch Size 100 for Pruning

**Decision**: Process 100 entities per pruning cycle.

**Rationale**: Balances throughput vs SQLite lock duration. 6-hour interval means ~400 entities/day capacity, sufficient for typical growth.

## Risks / Trade-offs

**[Risk] Aggressive pruning deletes useful entities** → 30-day soft-delete retention window allows manual recovery. Start with conservative TTLs (30d contradicted, 90d orphan).

**[Risk] LLM categorization fails silently** → Keyword tags always present as fallback. Errors logged but not retried (fire-and-forget).

**[Risk] Preference weights create filter bubbles** → Clamped to 0.5-2.0 range (max 2x boost). Cold start requires 20 queries before personalization activates.

**[Risk] Schema migration on large databases** → Adding nullable column is fast (no table rewrite). No index on pruned_at initially.

**[Trade-off] No entity recovery CLI** → Soft-deleted entities queryable via direct SQL. Full recovery CLI deferred to v2.

**[Trade-off] Fixed 7 categories** → Matches existing keyword system. Custom categories require schema changes, deferred.

## Implementation Notes

### Preference Learning: Telemetry→Category Join

Category expand rates are computed by:
1. Query `search_telemetry` for recent queries with expand actions (`expanded_indices` is non-empty)
2. For each expanded docid (from `result_docids` at `expanded_indices` positions), look up `document_tags` to find category tags (`auto:*` or `llm:*`)
3. Aggregate: for each category, count total appearances in results vs expanded appearances
4. Compute expand_rate = expanded_count / total_count per category

### Hard-Delete Scheduling

The hard-delete job runs within the same watcher.ts scheduler as soft-delete but on a weekly interval (7 × 24 × 60 × 60 × 1000 ms). Both jobs share `runPruningCycle()` but with different operations:
- Every 6h: `softDeleteContradictedEntities()` + `softDeleteOrphanEntities()`
- Every 7d: `hardDeletePrunedEntities()` (entities where `pruned_at` > `hard_delete_after_days`)

### LLM Categorization Persistence

After the async LLM call completes, `categorizeMemory()` calls `store.insertTags(docId, llmTags)` to append `llm:` prefixed tags. This uses the primary `store` instance (not `effectiveStore`) — same pattern as entity extraction's fire-and-forget Promise.
