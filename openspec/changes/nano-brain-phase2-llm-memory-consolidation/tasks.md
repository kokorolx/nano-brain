## 1. LLM Provider Infrastructure

- [x] 1.1 Create `src/llm.ts` with `LLMProvider` interface (complete, dispose methods) — DONE via consolidation-llm-provider: interface in consolidation.ts, impl in llm-provider.ts
- [x] 1.2 Implement `OllamaLLMProvider` using `/api/generate` endpoint — DONE: OllamaLLMProvider class in llm-provider.ts
- [x] 1.3 Implement `OpenAICompatibleLLMProvider` using `/v1/chat/completions` endpoint — DONE via consolidation-llm-provider: GitlabDuoLLMProvider in llm-provider.ts
- [x] 1.4 Add `createLLMProvider` factory function with config-based provider selection — DONE via consolidation-llm-provider: createLLMProvider in llm-provider.ts, updated to support Ollama
- [x] 1.5 Add LLM provider health check functions (similar to embedding health checks) — DONE: checkLLMHealth in llm-provider.ts

## 2. Configuration Schema

- [x] 2.1 Add `ConsolidationConfig` type to `src/types.ts` (enabled, provider, model, url, apiKey, maxCandidates) — DONE via consolidation-llm-provider
- [x] 2.2 Add `ExtractionConfig` type to `src/types.ts` (enabled, provider, model, url, apiKey, maxFactsPerSession) — DONE: ExtractionConfig and DEFAULT_EXTRACTION_CONFIG in types.ts
- [x] 2.3 Update `CollectionConfig` to include optional `consolidation` and `extraction` sections — DONE: consolidation and extraction in CollectionConfig
- [x] 2.4 Add config validation for consolidation and extraction sections — DONE: validateExtractionConfig in extraction.ts

## 3. Consolidation Queue

- [x] 3.1 Add `consolidation_queue` table schema (id, document_id, status, created_at, processed_at, result) — DONE: schema version 4 migration in store.ts
- [x] 3.2 Add `consolidation_log` table schema (id, document_id, action, reason, target_doc_id, model, created_at) — DONE: schema version 4 migration in store.ts
- [x] 3.3 Implement queue insertion function in `src/store.ts` — DONE: enqueueConsolidation method
- [x] 3.4 Implement queue polling function (get next pending job) — DONE: getNextPendingJob method
- [x] 3.5 Implement queue status update function (pending → processing → completed/failed) — DONE: updateJobStatus method

## 4. Consolidation Prompt Design

- [x] 4.1 Create `src/prompts/consolidation.ts` with consolidation system prompt — DONE: buildConsolidationPrompt in consolidation.ts
- [x] 4.2 Define JSON schema for consolidation response (action, reason, mergedContent, targetDocId) — DONE: parseConsolidationResponse in consolidation.ts
- [x] 4.3 Create prompt builder function that includes new memory and candidate snippets — DONE: buildConsolidationPrompt in consolidation.ts
- [x] 4.4 Add prompt examples for each action type (ADD, UPDATE, DELETE, NOOP) — DONE: examples added to buildSingleDocConsolidationPrompt in consolidation.ts

## 5. Consolidation Pipeline

- [x] 5.1 Create `src/consolidation.ts` module — DONE via consolidation-llm-provider
- [x] 5.2 Implement `findConsolidationCandidates` using vector search — DONE: findConsolidationCandidates method in ConsolidationAgent
- [x] 5.3 Implement `buildConsolidationPrompt` with new memory and candidates — DONE via consolidation-llm-provider
- [x] 5.4 Implement `parseConsolidationResponse` with JSON validation — DONE via consolidation-llm-provider
- [x] 5.5 Implement `applyConsolidationDecision` (ADD/UPDATE/DELETE/NOOP handlers) — DONE: applyConsolidation in consolidation.ts
- [x] 5.6 Implement `processConsolidationJob` orchestrating the full pipeline — DONE: processConsolidationJob method in ConsolidationAgent
- [x] 5.7 Add consolidation logging to `consolidation_log` table — DONE: addConsolidationLog store method used in processConsolidationJob

## 6. Background Consolidation Worker

- [x] 6.1 Create `src/consolidation-worker.ts` with background processing loop — DONE: ConsolidationWorker class with processNextJob loop
- [x] 6.2 Implement worker start/stop lifecycle management — DONE: start(), stop(), isRunning() methods
- [x] 6.3 Add configurable polling interval (default 5 seconds) — DONE: pollIntervalMs constructor option
- [x] 6.4 Integrate worker startup into MCP server initialization — DONE: worker started in server.ts runServer()
- [x] 6.5 Handle graceful shutdown (complete current job, then stop) — DONE: stop() waits for currentJobPromise

## 7. MCP Server Integration (Consolidation)

- [x] 7.1 Modify `memory_write` handler to enqueue consolidation job when enabled — DONE: enqueueConsolidation called in memory_write handler
- [x] 7.2 Add `consolidation: "pending"` to `memory_write` response when applicable — DONE: "Consolidation: pending" added to response
- [x] 7.3 Implement `memory_consolidation_status` MCP tool — DONE: returns queue stats and recent logs
- [x] 7.4 Register `memory_consolidation_status` in tool list — DONE: registered in ListToolsRequestSchema handler

## 8. Fact Extraction Prompt Design

- [x] 8.1 Create `src/prompts/extraction.ts` with extraction system prompt — DONE: buildExtractionPrompt in extraction.ts
- [x] 8.2 Define JSON schema for extraction response (array of {content, category}) — DONE: ExtractedFact interface in extraction.ts
- [x] 8.3 Create prompt builder function for session transcript input — DONE: buildExtractionPrompt in extraction.ts
- [x] 8.4 Add extraction categories: architecture-decision, technology-choice, coding-pattern, preference, debugging-insight, config-detail — DONE: FactCategory type in extraction.ts

## 9. Fact Extraction Pipeline

- [x] 9.1 Create `src/extraction.ts` module — DONE
- [x] 9.2 Implement `extractFactsFromSession` function — DONE
- [x] 9.3 Implement `parseExtractionResponse` with JSON validation — DONE
- [x] 9.4 Implement `computeFactHash` for idempotency checking — DONE
- [x] 9.5 Implement `storeExtractedFact` with duplicate detection — DONE
- [x] 9.6 Add `auto:extracted-fact` tag and source session metadata — DONE: tags include auto:extracted-fact, category:*, source:session:*

## 10. Harvester Integration

- [x] 10.1 Modify `harvestSessions` to accept extraction config — DONE: HarvesterOptions now includes extractionConfig and store
- [x] 10.2 Call fact extraction after session markdown generation — DONE: extractFactsFromSession called after session is harvested
- [x] 10.3 Track extraction statistics (facts extracted, duplicates skipped) — DONE: ExtractionStats interface with factsExtracted, duplicatesSkipped, errors, limitReached
- [x] 10.4 Add extraction summary to harvest output — DONE: stats include "extracted N facts (M duplicates)"
- [x] 10.5 Handle extraction failures gracefully (log warning, continue harvest) — DONE: try/catch around extraction, errors logged, harvest continues

## 11. Storage Limits Integration

- [x] 11.1 Add extracted fact count query to `getIndexHealth` — DONE: getExtractedFactCountStmt added, extractedFacts in IndexHealth
- [x] 11.2 Add `extractedFacts` section to `memory_status` response — DONE: formatStatus includes Extracted Facts section
- [x] 11.3 Check storage limits before inserting extracted facts — DONE: MAX_EXTRACTED_FACTS (10000) checked before and during extraction
- [x] 11.4 Log warning when extraction stops due to storage limit — DONE: log message when limit reached, limitReached flag in stats

## 12. Testing

- [x] 12.1 Add unit tests for `OllamaLLMProvider` (mock HTTP responses) — DONE: test/llm-provider.test.ts
- [x] 12.2 Add unit tests for `OpenAICompatibleLLMProvider` (mock HTTP responses) — DONE: test/llm-provider.test.ts (GitlabDuoLLMProvider tests)
- [x] 12.3 Add unit tests for consolidation prompt building — DONE via consolidation-llm-provider tests
- [x] 12.4 Add unit tests for consolidation response parsing — DONE via consolidation-llm-provider tests
- [x] 12.5 Add unit tests for consolidation decision application — DONE via consolidation-llm-provider tests
- [x] 12.6 Add unit tests for extraction prompt building — DONE: test/extraction.test.ts
- [x] 12.7 Add unit tests for extraction response parsing — DONE: test/extraction.test.ts
- [x] 12.8 Add unit tests for fact hash computation and duplicate detection — DONE: test/extraction.test.ts
- [x] 12.9 Add integration test for full consolidation flow (with mock LLM) — DONE via consolidation-llm-provider: integration-consolidation-e2e.test.ts
- [x] 12.10 Add integration test for full extraction flow (with mock LLM) — DONE: test/integration-extraction-e2e.test.ts

## 13. Documentation

- [x] 13.1 Update README with consolidation configuration example — DONE: README.md updated with consolidation config
- [x] 13.2 Update README with extraction configuration example — DONE: README.md updated with extraction config
- [x] 13.3 Document `memory_consolidation_status` MCP tool — DONE: added to MCP Tools section in README.md
- [x] 13.4 Add troubleshooting section for LLM provider issues — DONE: Troubleshooting section added to README.md
