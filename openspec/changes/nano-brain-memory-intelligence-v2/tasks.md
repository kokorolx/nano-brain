## Task Dependencies

- **Wave 1**: Tasks 1.x (schema migration) — prerequisite for all other tasks
- **Wave 2**: Tasks 2.x, 3.x, 4.x can run in parallel after Wave 1
- **Wave 3**: Tasks 5.x (testing) after implementation complete
- **Wave 4**: Tasks 6.x (documentation) after testing passes

## 1. Schema Migration

- [x] 1.1 Add pruned_at column migration in src/store.ts (user_version 7→8)
- [x] 1.2 Update memory_entities type in src/types.ts to include pruned_at field

## 2. Entity Pruning

- [x] 2.1 Create src/pruning.ts with PruningConfig type and default values
- [x] 2.2 Implement softDeleteContradictedEntities() - query contradicted entities past TTL, batch update pruned_at
- [x] 2.3 Implement softDeleteOrphanEntities() - query entities with no edges past TTL, batch update pruned_at
- [x] 2.4 Implement hardDeletePrunedEntities() - delete entities where pruned_at > retention, cascade delete edges referencing deleted entity IDs
- [x] 2.5 Add runPruningCycle() orchestrator function with batch size limit. Log results: soft-deleted count, hard-deleted count, batch limit reached
- [x] 2.6 Register soft-delete pruning job in src/watcher.ts (6-hour interval, configurable via pruning.interval_ms)
- [x] 2.7 Register hard-delete pruning job in src/watcher.ts (weekly interval, runs within same scheduler, checks pruned_at > hard_delete_after_days)
- [x] 2.8 Update src/memory-graph.ts queries to exclude WHERE pruned_at IS NOT NULL
- [x] 2.9 Add PruningConfig to src/types.ts and parsePruningConfig() validator following parseSearchConfig() pattern

## 3. LLM Categorization

- [x] 3.1 Create src/llm-categorizer.ts with LLMCategorizationConfig type
- [x] 3.2 Implement categorizationPrompt() - build prompt with truncated content
- [x] 3.3 Implement parseCategorizationResponse() - extract categories with confidence, validate against fixed set
- [x] 3.4 Implement categorizeMemory() - call LLMProvider, filter by threshold, return llm: prefixed tags. Accept all above-threshold categories (not just highest)
- [x] 3.5 Hook async categorization into memory_write handler in src/server.ts (fire-and-forget). After LLM returns, call store.insertTags(docId, llmTags) to append llm: prefixed tags to existing tags
- [x] 3.6 Add LLMCategorizationConfig to src/types.ts and parseCategorizationConfig() validator following parseSearchConfig() pattern

## 4. Preference Learning

- [x] 4.1 Create src/preference-model.ts with PreferenceConfig type
- [x] 4.2 Implement computeCategoryExpandRates() - query search_telemetry for expand actions, for each expanded docid look up document_tags to find category tags (auto:*/llm:*), aggregate expand counts per category
- [x] 4.3 Implement computeCategoryWeights() - calculate weights as expand_rate / baseline, clamp to [weight_min, weight_max], return neutral 1.0 for all categories when query count < min_queries (20 inclusive)
- [x] 4.4 Extend WorkspaceProfileData in src/types.ts to include categoryWeights field
- [x] 4.5 Add updatePreferenceWeights() to watcher.ts learning cycle
- [x] 4.6 Modify src/search.ts hybridSearch to apply category weight multiplier after usage boost
- [x] 4.7 Add PreferenceConfig to src/types.ts and parsePreferencesConfig() validator following parseSearchConfig() pattern

## 5. Testing

- [x] 5.1 Add unit tests for pruning logic (soft delete, hard delete, batch limits)
- [x] 5.2 Add unit tests for LLM categorization (parsing, threshold, prefix)
- [x] 5.3 Add unit tests for preference weights (computation, clamping, cold start)
- [x] 5.4 Add integration test for full pruning cycle
- [x] 5.5 Add integration test for categorization flow (mock LLM)

## 6. Documentation

- [x] 6.1 Update config documentation with new pruning, categorization, preferences sections
- [x] 6.2 Add memory intelligence section to README
