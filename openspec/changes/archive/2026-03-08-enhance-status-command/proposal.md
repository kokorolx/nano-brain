## Why

The `status` CLI command and `memory_status` MCP tool only report SQLite database metrics (document count, DB file size). When using Qdrant as the vector store, the actual embedding storage is invisible — users see disk size unchanged while embeddings are being inserted. There's also no visibility into embedding API token consumption (VoyageAI/OpenAI-compatible), making it impossible to monitor costs or remaining quota without checking external dashboards.

## What Changes

- Add **Vector Store** section to both CLI `status` and MCP `memory_status` showing Qdrant health, vector count, dimensions, and collection info
- Add **Token Usage Tracking** — accumulate `usage.total_tokens` from embedding API responses and persist to SQLite for display in status
- Capture and display **embedding API response metadata** (latency, rate limit state) in status output
- Enhance `printEmbeddingServerStatus` to show cumulative token usage alongside connectivity
- Extend `formatStatus` in server.ts to include vector store health in MCP tool output

## Capabilities

### New Capabilities
- `vector-store-status`: Display Qdrant (or sqlite-vec) health, vector count, dimensions, and provider info in status output
- `embedding-token-tracking`: Accumulate and persist per-model token usage from embedding API responses, display in status

### Modified Capabilities
- `mcp-server`: Extend `memory_status` tool response to include vector store health and token usage metrics

## Impact

- **Files**: `index.ts` (CLI status), `server.ts` (MCP status), `embeddings.ts` (capture usage), `store.ts` (persist token metrics), `types.ts` (new interfaces)
- **APIs**: `memory_status` MCP tool response gains new sections (non-breaking, additive)
- **Dependencies**: No new dependencies — Qdrant client and embedding providers already exist
- **Schema**: New SQLite table for token usage tracking (auto-migrated via `CREATE TABLE IF NOT EXISTS`)
