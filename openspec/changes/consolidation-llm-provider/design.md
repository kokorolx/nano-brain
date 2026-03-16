## Context

nano-brain stores memories (session notes, decisions, debugging insights) in SQLite. Over time, related memories accumulate without connections between them. The `ConsolidationAgent` was designed to periodically batch recent memories, send them to an LLM to find connections and insights, and persist the results. The scaffolding exists — interface, prompt, parser, watcher timer, CLI, MCP tool — but all implementations are stubs.

The gitlab-duo-proxy is now deployed at `gl-proxy.thnkandgrow.com`, exposing GitLab Duo models via OpenAI-compatible API. This provides a free LLM backend to power consolidation.

**Current state:**
- `LLMProvider` interface defined but no implementation
- `getUnconsolidatedMemories()` returns `[]`
- `applyConsolidation()` only logs
- `consolidations` table exists in schema but is never written to
- CLI and MCP tools return "not configured" messages

## Goals / Non-Goals

**Goals:**
- Activate the consolidation pipeline end-to-end: query → LLM → persist
- Support manual trigger via CLI (`npx nano-brain consolidate`) and MCP (`memory_consolidate`)
- Track token usage for cost visibility
- Handle LLM errors gracefully without crashing the daemon

**Non-Goals:**
- Automatic watcher-based consolidation (defer to v2 — manual trigger first)
- Synthetic document creation from consolidation insights
- Multiple LLM provider backends (v1 is gitlab-duo-proxy only, but interface allows future providers)
- Retry queue for failed consolidation batches
- Schema migration for `consolidated_at` column on documents

## Decisions

### D1: LLM Provider — new file `src/llm-provider.ts`

**Choice:** Separate file with `GitlabDuoLLMProvider` class + `createLLMProvider()` factory.

**Why over inline in consolidation.ts:** Other features (query expansion, importance scoring) may need LLM access. Follows the codebase pattern where `embeddings.ts` is separate from consumers.

**Implementation:** ~80 lines. Constructor takes `{ endpoint, model, apiKey }`. `complete()` calls `POST /v1/chat/completions` with `stream: false`, extracts `choices[0].message.content` and `usage.total_tokens`.

### D2: Unconsolidated memory query — `consolidations.source_ids` exclusion

**Choice:** Query documents WHERE `collection = 'memory'` AND `active = 1` AND `superseded_by IS NULL`, excluding IDs found in `consolidations.source_ids` via `json_each()`.

**Why over `consolidated_at` column:** No schema migration needed. The `consolidations` table already exists. Performance is acceptable for the expected volume (tens to low hundreds of memories per workspace).

**Alternative considered:** Adding `consolidated_at` column to documents table. Rejected for v1 — simpler to track via consolidations table. Can add later if query performance degrades.

### D3: Consolidation output — INSERT into `consolidations` table

**Choice:** Insert `{ source_ids, summary, insight, connections, confidence, created_at }` into existing `consolidations` table.

**Why:** Table already exists in schema. No new tables or migrations needed.

**What's deferred:** Creating a synthetic `memory` document from the insight (would make insights searchable via normal queries). Acceptable for v1 — consolidation results are queryable via `consolidations` table directly.

### D4: Config — extend existing `ConsolidationConfig`

**Choice:** Use existing `consolidation.*` config fields: `enabled`, `model`, `endpoint`, `apiKey`. Support env var fallback for `apiKey` via `CONSOLIDATION_API_KEY`.

**Default model:** `duo-chat-haiku-4-5` (cheapest, sufficient for consolidation tasks).

**Default endpoint:** `https://gl-proxy.thnkandgrow.com` — update `DEFAULT_CONSOLIDATION_CONFIG` in `types.ts` to include this default. Factory returns `null` if neither `endpoint` in config nor default is reachable.

### D5: Error handling — log and skip

**Choice:** On LLM failure, log the error and return empty results. The existing `recordFailedBatch()` stub will be implemented to track failed document IDs for retry on next manual trigger.

**Why over retry queue:** Consolidation is not time-critical. Manual re-run is sufficient for v1.

## Risks / Trade-offs

- **gitlab-duo-proxy downtime** → Consolidation silently skips. User sees "0 consolidations" in output. Acceptable — not time-critical.
- **LLM returns malformed JSON** → Existing `parseConsolidationResponse()` returns `[]`. Logged for debugging. No data corruption.
- **API key in config.yml** → File should be gitignored. Env var fallback (`CONSOLIDATION_API_KEY`) provides alternative. Never logged.
- **`json_each()` performance on large consolidations table** → Acceptable for expected volume. If consolidations table grows to thousands of rows, add `consolidated_at` column in v2.
- **No automatic scheduling** → Users must manually trigger. Acceptable for v1 — validates the pipeline works before automating.
