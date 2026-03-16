## Why

The knowledge graph (memory_entities, memory_edges) grows unboundedly with no DELETE paths. Keyword-based categorization misses nuance. Search results are unpersonalized despite rich telemetry data. These three gaps limit memory quality and relevance as usage scales.

## What Changes

- **Entity Pruning**: Background job to soft-delete contradicted/orphan entities, hard-delete after retention period. Prevents unbounded graph growth.
- **LLM-Based Categorization**: Async fire-and-forget LLM call after keyword categorization for higher-quality category assignment. Uses existing LLMProvider (free via ai-proxy).
- **User Preference Learning**: Track category access patterns, compute per-workspace weights, apply as multiplier in search scoring. Personalizes results based on behavior.

## Capabilities

### New Capabilities

- `entity-pruning`: Background pruning job for knowledge graph entities. Soft-deletes contradicted (30d) and orphan (90d) entities, hard-deletes after 30d retention. Batch processing to avoid SQLite locks.
- `llm-categorization`: Async LLM-based categorization of memories into 7 fixed categories with confidence scoring. Complements existing keyword categorizer.
- `preference-learning`: Per-workspace category weight computation from access telemetry. Applied as scoring multiplier in hybrid search.

### Modified Capabilities

<!-- No existing spec requirements are changing - these are additive features -->

## Impact

- **Schema**: Migration user_version 7→8 (add `pruned_at` column to memory_entities)
- **Files**: New src/pruning.ts, src/llm-categorizer.ts, src/preference-model.ts
- **Modified**: src/store.ts, src/watcher.ts, src/memory-graph.ts, src/search.ts, src/server.ts, src/types.ts
- **Config**: New pruning, categorization, preferences sections in config
- **Dependencies**: None (reuses existing LLMProvider, watcher scheduler, store patterns)
