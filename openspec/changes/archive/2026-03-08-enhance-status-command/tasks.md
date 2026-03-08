## 1. Token Usage Storage & Recording

- [x] 1.1 Add `token_usage` table to `createStore` in store.ts (`CREATE TABLE IF NOT EXISTS token_usage (model TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, last_updated TEXT NOT NULL DEFAULT (datetime('now')))`)
- [x] 1.2 Add `recordTokenUsage(model: string, tokens: number): void` method to Store interface in types.ts and implement in store.ts (INSERT OR UPDATE with atomic increment)
- [x] 1.3 Add `getTokenUsage(): Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>` method to Store interface and implement in store.ts
- [x] 1.4 Add `onTokenUsage?: (model: string, tokens: number) => void` callback to `EmbeddingProviderOptions` in embeddings.ts
- [x] 1.5 Wire `onTokenUsage` callback in `OpenAICompatibleEmbeddingProvider.fetchWithRetry()` — call after successful response when `usage.total_tokens` is present
- [x] 1.6 Wire the callback at construction time: in server.ts `createEmbeddingProvider` call, pass `onTokenUsage: (model, tokens) => store.recordTokenUsage(model, tokens)`, and similarly in codebase.ts embedding flow

## 2. Vector Store Health

- [x] 2.1 Add `getVectorStoreHealth(config: CollectionConfig): Promise<VectorStoreHealth | null>` helper function in index.ts that creates a temporary vector store, calls `health()` with 5s timeout, and returns the result (or null if no vector config)
- [x] 2.2 Add vector store health display to `handleStatus` in index.ts — call the helper, print "Vector Store:" section with provider, status, vector count, dimensions
- [x] 2.3 Add vector store health to `handleStatus --all` mode — single shared section after workspace table
- [x] 2.4 Handle sqlite-vec case in vector store status — query `SELECT COUNT(*) FROM vectors_vec` for local vector count, display as "sqlite-vec (built-in)"

## 3. CLI Status Display

- [x] 3.1 Add "Token Usage:" section to `handleStatus` in index.ts — call `store.getTokenUsage()`, display per-model tokens/requests/last-updated, omit section if empty
- [x] 3.2 Add token usage to `--all` mode — single summary after workspace table (shared API key)

## 4. MCP Status Display

- [x] 4.1 Extend `formatStatus` in server.ts to accept optional `vectorHealth: VectorStoreHealth | null` and `tokenUsage: Array<{...}> | null` parameters
- [x] 4.2 Add "Vector Store:" section to `formatStatus` output — provider, status, vector count, dimensions
- [x] 4.3 Add "Token Usage:" section to `formatStatus` output — per-model tokens and request counts, omit if empty
- [x] 4.4 Update `memory_status` tool handler to gather vector store health (with 5s timeout) and token usage, pass to `formatStatus`

## 5. Verification

- [x] 5.1 Build project (`npm run build`) and verify no type errors
- [x] 5.2 Run `npx nano-brain status` and verify new sections appear correctly
- [x] 5.3 Run `npx nano-brain status --all` and verify vector store + token usage sections
