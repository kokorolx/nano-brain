## 1. LLM Provider

- [x] 1.1 Create `src/llm-provider.ts` with `GitlabDuoLLMProvider` class implementing `LLMProvider` interface — `complete()` calls `POST {endpoint}/v1/chat/completions` with `stream: false`, extracts `choices[0].message.content` and `usage.total_tokens`, throws on HTTP error/timeout (60s via `AbortSignal.timeout`)
- [x] 1.2 Add `createLLMProvider(config: ConsolidationConfig)` factory — reads `endpoint` (default `https://gl-proxy.thnkandgrow.com`), `model` (default `duo-chat-haiku-4-5`), `apiKey` (fallback to `CONSOLIDATION_API_KEY` env var), returns `null` if no apiKey available OR no endpoint available. Handle missing `usage.total_tokens` in response by defaulting to 0
- [x] 1.3 Add unit test `test/llm-provider.test.ts` — mock fetch, test success path, HTTP error, timeout, missing content, env var fallback

## 2. Consolidation Store Methods

- [x] 2.1 Implement `getUnconsolidatedMemories()` in `src/consolidation.ts` — SQL query: `SELECT d.id, d.title, d.path, d.hash, c.body FROM documents d JOIN content c ON d.hash = c.hash WHERE d.collection = 'memory' AND d.active = 1 AND d.superseded_by IS NULL AND d.id NOT IN (SELECT json_each.value FROM consolidations, json_each(consolidations.source_ids)) ORDER BY d.modified_at DESC LIMIT ?` (bind maxMemoriesPerCycle). The store must expose this query — add a method to Store or pass the db handle to ConsolidationAgent
- [x] 2.2 Implement `applyConsolidation()` in `src/consolidation.ts` — INSERT into `consolidations` table with `source_ids` (JSON), `summary`, `insight`, `connections` (JSON), `confidence`, `created_at`
- [x] 2.3 Implement `recordFailedBatch()` in `src/consolidation.ts` — log failed doc IDs (existing stub, just needs store interaction or enhanced logging)
- [x] 2.4 Add/update test `test/consolidation.test.ts` — test getUnconsolidatedMemories with real SQLite store, test applyConsolidation persists correctly, test already-consolidated docs are excluded

## 3. Wire CLI Command

- [x] 3.1 Update `handleConsolidate()` in `src/index.ts` — import `createLLMProvider`, create provider from config, create `ConsolidationAgent(store, { llmProvider })`, call `runConsolidationCycle()`, print results count
- [x] 3.2 Handle error cases: disabled config, missing apiKey, LLM failure — print clear messages and exit gracefully

## 4. Wire MCP Tool

- [x] 4.1 Replace the existing `memory_consolidate` stub in `src/server.ts` (currently returns hardcoded "not configured" message) — import `createLLMProvider` and `ConsolidationAgent`, create provider from config, create agent, run cycle, return results as formatted text (count, tokens used). The tool registration already exists at ~line 1734; replace the handler body
- [x] 4.2 Handle not-configured case with informative message including which config fields are missing

## 5. Integration Test

- [x] 5.1 Add `test/integration-consolidation-e2e.test.ts` — create store with test memories, mock LLM provider returning valid JSON, run full consolidation cycle, verify consolidations table has results, verify source docs are excluded on second run
