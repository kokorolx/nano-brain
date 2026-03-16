# Tasks: Memory Intelligence Phase 1

## 1. Schema & Migration
- [x] 1.1 Add `access_count INTEGER DEFAULT 0` and `last_accessed_at TEXT` columns to documents table CREATE TABLE in `src/store.ts`
- [x] 1.2 Add migration logic to detect and ALTER TABLE for existing databases (follow existing migration pattern in store.ts around line 196-230)
- [x] 1.3 Add `access_count` and `lastAccessedAt` fields to `Document` interface and `SearchResult` interface in `src/types.ts`
- [x] 1.4 Add index on `last_accessed_at` column: `CREATE INDEX IF NOT EXISTS idx_documents_access ON documents(last_accessed_at)`

## 2. Decay Configuration
- [x] 2.1 Add `decay` section to `CollectionConfig` interface in `src/types.ts`: `{ enabled: boolean, halfLife: string, boostWeight: number }`
- [x] 2.2 Add decay config parsing with duration string support and validation (reuse existing parseDuration pattern from storage.ts if available, or add new)
- [x] 2.3 Add `usage_boost_weight` field to `SearchConfig` interface and `DEFAULT_SEARCH_CONFIG` in `src/types.ts` (default 0.15)
- [x] 2.4 Add config validation for `boostWeight` (0-1 range) and `usage_boost_weight` (warn on negative, use default)

## 3. Auto-Categorization Engine
- [x] 3.1 Create new file `src/categorizer.ts` with `categorize(content: string): string[]` function — pure keyword/regex matching, returns array of category strings
- [x] 3.2 Implement category rules: architecture-decision, debugging-insight, tool-config, pattern, preference, context, workflow with keyword lists per the spec
- [x] 3.3 Add `auto:` prefix to all auto-generated tags
- [x] 3.4 Wire categorizer into `memory_write` handler in `src/server.ts` — merge auto tags with user-provided tags before inserting into document_tags
- [x] 3.5 Add unit tests for categorizer: test each category detection, multi-category, no-match, and performance (<5ms for 10KB)

## 4. Access Tracking
- [x] 4.1 Add `trackAccess(docIds: number[])` method to Store interface and implement in `src/store.ts` — batch UPDATE access_count = access_count + 1, last_accessed_at = datetime('now')
- [x] 4.2 Wire access tracking into MCP search tool handlers in `src/server.ts` — call trackAccess after returning results for memory_search, memory_vsearch, memory_query
- [x] 4.3 Ensure internal pipeline queries (expansion, reranking) do NOT trigger access tracking
- [x] 4.4 Add tests for access tracking (verify increment, verify internal queries don't track)

## 5. Decay Score Computation
- [x] 5.1 Add `computeDecayScore(lastAccessedAt: string | null, createdAt: string, halfLifeDays: number): number` function in `src/search.ts`
- [x] 5.2 Implement decay formula: `1 / (1 + daysSinceAccess / halfLife)` where daysSinceAccess uses `lastAccessedAt` or falls back to `createdAt` if NULL
- [x] 5.3 Add tests for decay score computation (edge cases: NULL last_accessed_at, zero days, large daysSinceAccess)

## 6. Usage-Based Search Boosting
- [x] 6.1 Add `applyUsageBoost(results: SearchResult[], config: { usageBoostWeight: number, decayHalfLifeDays: number }): SearchResult[]` function in `src/search.ts`
- [x] 6.2 Implement boost formula: `log2(1 + access_count) * decayScore * boostWeight` where decayScore = `1 / (1 + daysSinceAccess / halfLife)`
- [x] 6.3 Ensure access_count and last_accessed_at are loaded in search result queries (update SQL in store.ts searchFTS and searchVec)
- [x] 6.4 Wire applyUsageBoost into hybrid search pipeline in `src/search.ts` in the correct position: after applyCentralityBoost, before applySupersedeDemotion
- [x] 6.5 Add tests for usage boost integration in search pipeline (verify pipeline order, verify weight=0 disables boost)

## 7. Storage Integration
- [x] 7.1 Update size-based eviction in `src/storage.ts` to sort by access_count (ascending) within same age tier when decay.enabled is true
- [x] 7.2 Ensure eviction falls back to age-only ordering when decay.enabled is false or all access_counts are 0
- [x] 7.3 Add tests for access-aware eviction (same age different access counts, decay disabled, all zero access counts)

## 8. Testing & Validation
- [x] 8.1 Add tests for schema migration (fresh DB, existing DB without columns)
- [x] 8.2 Run full test suite and verify no regressions
- [x] 8.3 Manual smoke test: write a memory, search for it multiple times, verify access_count increments and boost affects ranking
- [x] 8.4 Performance test: measure search latency with 10k memories, 20 results (verify access tracking overhead is acceptable)
