## ADDED Requirements

### Requirement: Cache module owns LLM cache, telemetry, and corruption recovery
The system SHALL extract LLM result caching, search telemetry, corruption recovery state, and consolidation queue management from `store.ts` into `src/store/cache.ts`.

#### Scenario: LLM cache hit returns stored result
- **WHEN** `setCachedResult(hash, result)` is called and then `getCachedResult(hash)` is called with the same hash
- **THEN** the stored result is returned without re-invoking the LLM

#### Scenario: Cache can be cleared by type and workspace
- **WHEN** `clearCache('llm', projectHash)` is called
- **THEN** only LLM cache entries for that projectHash are deleted; other cache types and workspaces are unaffected

#### Scenario: Search telemetry is recorded
- **WHEN** `logSearchQuery(query, results, latencyMs, projectHash)` is called
- **THEN** the query and result metadata are persisted in the `search_telemetry` table

#### Scenario: Corruption recovery state is readable
- **WHEN** a DB corruption recovery has occurred and `getLastCorruptionRecovery()` is called
- **THEN** the timestamp and recovery details of the most recent recovery are returned

#### Scenario: Corruption recovery state can be cleared
- **WHEN** `clearCorruptionRecovery()` is called
- **THEN** the corruption recovery flag is removed and subsequent calls to `getLastCorruptionRecovery()` return null

### Requirement: Consolidation queue is managed in the cache module
The system SHALL include `enqueueConsolidation`, `getNextPendingJob`, `updateJobStatus`, and `getRecentConsolidationLogs` in `cache.ts`.

#### Scenario: Consolidation job lifecycle
- **WHEN** `enqueueConsolidation(docId, 'stale')` is called, then `getNextPendingJob()`, then `updateJobStatus(jobId, 'done', result)`
- **THEN** the job transitions from pending → processing → done without error
