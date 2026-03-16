# RRI-T Phase 1: PREPARE — Self-Learning System

**Feature:** nano-brain Self-Learning System (Memory Intelligence + Knowledge Graph)
**Version:** 2026.5.0-rc.1
**Date:** 2026-03-12
**Type:** MCP Server (Model Context Protocol)
**Test Scope:** Phase 1 (Memory Intelligence) + Phase 3 (Knowledge Graph)

---

## Feature Overview

The nano-brain self-learning system introduces two major capabilities:

1. **Memory Intelligence (Phase 1)**: Usage-based relevance scoring with decay, auto-categorization, and document eviction
2. **Knowledge Graph (Phase 3)**: Entity-relationship graph with temporal reasoning, proactive surfacing, and contradiction detection

This is an MCP server that AI coding agents (Claude, GPT) interact with via tool calls. There is no web UI, no mobile app, no GraphQL API. All testing is performed through MCP tool invocations.

---

## Testable Components

### Phase 1: Memory Intelligence

| Component | Description | Files |
|-----------|-------------|-------|
| **Schema Migration v5** | Adds `access_count` (INTEGER DEFAULT 0) and `last_accessed_at` (TEXT) columns to documents table | `src/migrations.ts` |
| **Auto-Categorizer** | Keyword/regex-based classification into 7 categories on `memory_write`: architecture-decision, debugging-insight, tool-config, pattern, preference, context, workflow. All tags prefixed with `auto:` | `src/categorizer.ts` |
| **Access Tracking** | `trackAccess(ids: number[])` increments `access_count` and updates `last_accessed_at` for every search result returned | `src/search.ts:666-671` |
| **Decay Scoring** | `computeDecayScore(lastAccessedAt, createdAt, halfLifeDays)` — exponential decay: `1 / (1 + daysSinceAccess / halfLife)` | `src/search.ts:275-283` |
| **Usage Boost** | `applyUsageBoost(results, config)` — `log2(1 + access_count) * decayScore * boostWeight` applied in search pipeline | `src/search.ts:285-304` |
| **Document Eviction** | `evictLowAccessDocuments()` — removes documents with low access_count, prioritizing least-accessed memories | `src/store.ts` |
| **DecayConfig** | Type with `enabled`, `halfLife`, `boostWeight` fields | `src/types.ts` |
| **SearchConfig Extension** | `usage_boost_weight` added (default 0.15) | `src/types.ts` |

### Phase 3: Knowledge Graph

| Component | Description | Files |
|-----------|-------------|-------|
| **Schema Migration v6** | Creates `memory_entities` (id, name, type, description, project_hash, first_learned_at, last_confirmed_at, contradicted_at, contradicted_by_memory_id) and `memory_edges` (id, source_id, target_id, edge_type, project_hash, created_at) tables with case-insensitive deduplication | `src/migrations.ts` |
| **Entity Extraction** | LLM-based extraction of entities (tool, service, person, concept, decision, file, library) and relationships (uses, depends_on, decided_by, related_to, replaces, configured_with) from memory content | `src/entity-extraction.ts` |
| **MemoryGraph Class** | BFS traversal with configurable depth (max 10), relationship type filtering, fuzzy entity search via `findSimilarEntities()` | `src/memory-graph.ts` |
| **Entity Deduplication** | Case-insensitive UNIQUE constraint on (name COLLATE NOCASE, type, project_hash) | `src/memory-graph.ts:24-36` |
| **Temporal Metadata** | `first_learned_at`, `last_confirmed_at`, `contradicted_at`, `contradicted_by_memory_id` on entities | `src/types.ts` |
| **Contradiction Detection** | Integrated into consolidation flow — marks entities as contradicted when UPDATE/DELETE actions conflict with existing facts | `src/consolidation.ts` |
| **Proactive Surfacing** | On `memory_write`, appends related memories via vector similarity when `proactive.enabled` is true | `src/mcp-server.ts` |
| **memory_graph_query** | MCP tool: traverse entity relationships with depth control and relationship type filters | `src/mcp-server.ts` |
| **memory_related** | MCP tool: find related memories for a topic with entity context enrichment | `src/mcp-server.ts` |
| **memory_timeline** | MCP tool: chronological timeline of knowledge evolution for a topic with date filtering | `src/mcp-server.ts` |
| **memory_graph_stats** | MCP tool: entity/edge counts and entity type distribution | `src/mcp-server.ts` |

---

## Test Environment

### Infrastructure
- **MCP Server**: `npx nano-brain serve` (runs locally on port 3000 by default)
- **Database**: SQLite (better-sqlite3) at `~/.nano-brain/db/nano-brain.db`
- **Embedding Provider**: Ollama (local) or OpenAI-compatible API
- **LLM Provider**: OpenAI-compatible API for entity extraction and consolidation
- **Test Client**: MCP tool calls via `skill_mcp(mcp_name="nano-brain", tool_name="...", arguments={...})`

### MCP Tools Available
- `memory_write` — write new memory with optional tags, supersedes, consolidation
- `memory_query` — hybrid search (FTS + vector + symbol)
- `memory_search` — exact FTS search
- `memory_graph_query` — traverse entity graph from starting entity
- `memory_related` — find related memories with entity enrichment
- `memory_timeline` — chronological knowledge evolution
- `memory_graph_stats` — entity/edge statistics
- `memory_learning_status` — check consolidation and entity extraction status

### Test Data Requirements
- Clean database state (or known baseline)
- Sample memories with varying access patterns (0 to 100+ accesses)
- Sample memories with entities (tools, services, concepts)
- Sample memories with temporal evolution (same topic over time)
- Sample memories with contradictions (conflicting facts)

### Configuration Files
- `~/.nano-brain/config.json` — search config, decay config, consolidation config
- `~/.nano-brain/memory/` — markdown files for manual memory entries

---

## Test Execution Strategy

### 1. Schema Migration Testing
- Verify v5 migration adds columns without data loss
- Verify v6 migration creates tables with correct constraints
- Test rollback scenarios (if supported)

### 2. Functional Testing
- Auto-categorization accuracy across 7 categories
- Access tracking increments on every search
- Decay scoring with various time deltas
- Usage boost impact on search ranking
- Entity extraction from diverse memory content
- Graph traversal with depth limits
- Contradiction detection during consolidation
- Proactive surfacing relevance

### 3. Performance Testing
- Search latency with decay scoring enabled (1000+ documents)
- Entity extraction latency (large memory content)
- Graph traversal performance (deep graphs, 5+ levels)
- Concurrent access tracking (10+ simultaneous searches)

### 4. Data Integrity Testing
- Access count accuracy after 100+ searches
- Entity deduplication (case-insensitive)
- Temporal metadata consistency
- Contradiction marking correctness
- Eviction preserves high-value memories

### 5. Edge Case Testing
- Zero access_count documents
- NULL last_accessed_at
- Empty entity extraction results
- Circular entity relationships
- Unicode entity names
- Extremely long memory content (10,000+ chars)

---

## Success Criteria

### Phase 1: Memory Intelligence
- ✅ Schema v5 migration completes without errors
- ✅ Auto-categorizer assigns correct tags (>85% accuracy on sample set)
- ✅ Access tracking increments on every search result
- ✅ Decay scoring produces values in [0, 1] range
- ✅ Usage boost improves ranking for frequently accessed memories
- ✅ Eviction removes low-access documents without affecting high-access ones

### Phase 3: Knowledge Graph
- ✅ Schema v6 migration completes without errors
- ✅ Entity extraction identifies entities and relationships (>70% recall on sample set)
- ✅ Entity deduplication works case-insensitively
- ✅ Graph traversal returns correct paths within depth limit
- ✅ Contradiction detection marks conflicting entities
- ✅ Proactive surfacing returns relevant related memories
- ✅ Temporal metadata tracks knowledge evolution accurately

### Performance Benchmarks
- Search with decay scoring: <200ms for 1000 documents
- Entity extraction: <3s for 2000-char memory
- Graph traversal (depth 3): <100ms for 100-node graph
- Concurrent access tracking: no race conditions with 10 parallel searches

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Schema migration fails on large DB | Medium | High | Test on copy of production DB first |
| Entity extraction LLM timeout | Medium | Medium | Implement 10s timeout with fallback |
| Access tracking race condition | Low | High | Use SQLite transactions for atomic increments |
| Decay scoring overflow with old dates | Low | Medium | Clamp daysSinceAccess to reasonable max (e.g., 3650 days) |
| Graph traversal infinite loop | Low | High | Enforce max depth of 10, track visited nodes |
| Contradiction detection false positives | Medium | Medium | Manual review of contradiction cases |
| Eviction removes important memories | Medium | High | Implement dry-run mode, require confirmation |

---

## Test Data Preparation

### Sample Memories (Phase 1)
```typescript
// High-access memory (100+ accesses, recent)
{ content: "Redis key pattern: sinv:*:compressed stores compressed inventory data", tags: ["architecture-decision"], access_count: 120, last_accessed_at: "2026-03-10T10:00:00Z" }

// Medium-access memory (10-50 accesses, 30 days old)
{ content: "Fixed EPIPE crash by suppressing error at stream level", tags: ["debugging-insight"], access_count: 25, last_accessed_at: "2026-02-10T15:30:00Z" }

// Low-access memory (0-5 accesses, 90 days old)
{ content: "Prefer async/await over .then() chains", tags: ["preference"], access_count: 2, last_accessed_at: "2025-12-12T08:00:00Z" }

// Zero-access memory (never accessed)
{ content: "Old workflow: manual DB backup every Friday", tags: ["workflow"], access_count: 0, last_accessed_at: null }
```

### Sample Memories (Phase 3)
```typescript
// Entity-rich memory
{ content: "Decided to use Playwright instead of Puppeteer for E2E testing because Playwright has better TypeScript support and auto-wait features", tags: ["architecture-decision"] }
// Expected entities: Playwright (tool), Puppeteer (tool), TypeScript (library), E2E testing (concept)
// Expected relationships: Playwright replaces Puppeteer, Playwright uses TypeScript

// Contradiction scenario
{ content: "Redis key sinv:* uses JSON encoding", tags: ["architecture-decision"], created_at: "2026-01-01" }
{ content: "Redis key sinv:* uses MessagePack compression, not JSON", tags: ["architecture-decision"], created_at: "2026-03-01" }
// Expected: Second memory marks first entity as contradicted

// Temporal evolution
{ content: "Considering SQLite vs PostgreSQL for nano-brain storage", tags: ["context"], created_at: "2025-11-01" }
{ content: "Decided to use SQLite for simplicity and portability", tags: ["architecture-decision"], created_at: "2025-11-15" }
{ content: "SQLite performance is excellent for <10k documents", tags: ["debugging-insight"], created_at: "2026-02-01" }
```

---

## Next Steps

After Phase 1 (PREPARE) completion:
1. **Phase 2 (DISCOVER)**: Interview 5 personas (15-20 questions each) adapted for MCP server context
2. **Phase 3 (STRUCTURE)**: Generate 35+ test cases in Q-A-R-P-T format covering all 7 dimensions
3. **Phase 4 (EXECUTE)**: Run test cases, capture results, document failures
4. **Phase 5 (ANALYZE)**: Calculate coverage, apply release gates, generate summary

---

**Status:** ✅ PREPARE phase complete
**Next:** Phase 2 (DISCOVER) — Persona interviews
