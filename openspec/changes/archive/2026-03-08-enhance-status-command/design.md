## Context

The `status` CLI command (`handleStatus` in index.ts) and `memory_status` MCP tool (server.ts) currently report:
- SQLite database path and file size
- Document/embedded/pending counts from SQLite
- Collection breakdown
- Codebase stats (if enabled)
- Embedding server connectivity (Ollama/OpenAI health check)

When Qdrant is the active vector store, the actual embedding vectors live outside SQLite. Users see `insertEmbeddingLocal` logs but disk size doesn't change — confusing. The Qdrant provider already has a `health()` method returning `{ ok, provider, vectorCount, dimensions }` but it's never called from status.

For embedding API token usage (VoyageAI, OpenAI-compatible), the `usage.total_tokens` field is returned in every embed response but is currently discarded. VoyageAI has no dedicated usage/balance API endpoint — local accumulation is the only option.

## Goals / Non-Goals

**Goals:**
- Show vector store health (provider, status, vector count, dimensions) in both CLI and MCP status
- Track cumulative token usage from embedding API responses and persist across restarts
- Display token usage breakdown by model in status output
- Keep status command fast (<2s) — async health checks with timeouts

**Non-Goals:**
- Real-time billing/cost estimation (no pricing API available)
- VoyageAI dashboard scraping or undocumented API usage
- Modifying the embedding flow itself (only adding instrumentation)
- Adding a dedicated VoyageAI provider class (it works via OpenAI-compatible already)

## Decisions

### 1. Token usage storage: SQLite table vs in-memory counter

**Decision**: New `token_usage` SQLite table with per-model accumulation.

**Why**: In-memory counters reset on restart. Users need to see cumulative usage over time. SQLite is already the persistence layer — adding a small table is trivial.

**Table schema**:
```sql
CREATE TABLE IF NOT EXISTS token_usage (
  model TEXT NOT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (model)
);
```

**Alternative considered**: Flat file / JSON — rejected because SQLite is already open and atomic updates are free.

### 2. Where to capture token usage: Store method vs Embedding provider

**Decision**: Add `recordTokenUsage(model, tokens)` to the Store interface. Call it from `OpenAICompatibleEmbeddingProvider.fetchWithRetry()` after successful responses.

**Why**: The store is already passed through the call chain. The embedding provider has access to the response `usage` field. Adding a callback/event would over-engineer this.

**Problem**: The embedding provider doesn't currently have a reference to the store. We'll add an optional `onTokenUsage?: (model: string, tokens: number) => void` callback to `EmbeddingProviderOptions` and wire it at construction time in server.ts/codebase.ts.

### 3. Vector store health in status: Sync vs async with timeout

**Decision**: Async with 5s timeout. If Qdrant is unreachable, show `❌ unreachable` rather than blocking the entire status command.

**Why**: Qdrant may be down or slow. Status should always return quickly. The existing `checkOllamaHealth` already uses `AbortSignal.timeout(10000)` — we'll follow the same pattern with a tighter timeout since Qdrant should be local.

### 4. Status output location: New section vs inline

**Decision**: Add two new sections to status output:

CLI:
```
Vector Store:
  Provider:   qdrant
  Status:     ✅ connected
  Vectors:    12,345
  Dimensions: 1024

Token Usage:
  voyage-3:          1,234,567 tokens (4,521 requests)
  Last updated:      2026-03-08 09:15:00
```

MCP `formatStatus`:
```
**Vector Store:**
  - Provider: qdrant
  - Status: ✅ connected (12,345 vectors, 1024 dims)

**Token Usage:**
  - voyage-3: 1,234,567 tokens (4,521 requests)
```

### 5. `--all` mode vector store display

**Decision**: In `--all` mode (multi-workspace summary), show a single vector store health line at the bottom (shared across workspaces) rather than per-workspace. Token usage is also global (one embedding API key shared).

## Risks / Trade-offs

- **[Token count accuracy]** → Tokens are only tracked when nano-brain makes the API call. External usage of the same API key won't be reflected. Mitigation: Label as "nano-brain usage" not "total usage".
- **[Qdrant timeout slowing status]** → 5s timeout adds latency when Qdrant is down. Mitigation: Run vector health check in parallel with other status gathering, not sequentially.
- **[Schema migration]** → New `token_usage` table added via `CREATE TABLE IF NOT EXISTS` in `createStore`. No migration needed — idempotent. Risk: near zero.
- **[Callback threading]** → The `onTokenUsage` callback writes to SQLite from the embedding provider's async context. Mitigation: better-sqlite3 is synchronous and thread-safe within a single Node process.
