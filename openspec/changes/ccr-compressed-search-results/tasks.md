## 1. Result Cache

- [x] 1.1 Create `src/cache.ts` with `ResultCache` class: in-memory Map with incrementing counter keys (`search_1`, `search_2`, ...), TTL-only eviction (default 15 min), lazy cleanup on access. Cache entry stores `{ results: SearchResult[], query: string, startLines: number[], endLines: number[], docids: string[], expires: number }`. Methods: `set(results, query)` → returns cacheKey, `get(cacheKey)` → entry or null, `clear()`
- [x] 1.2 Add unit tests for `ResultCache`: set/get, TTL expiry (returns null after 15 min), lazy cleanup removes expired entries, incrementing key generation, stores startLine/endLine/docid per result

## 2. Compact Formatting

- [x] 2.1 Add `formatCompactResults(results: SearchResult[], cacheKey: string): string` to `src/server.ts` — renders header line with cache key + hint, then one line per result: `{i}. [{score}] {title} ({docid}) — {path}:{startLine} [{symbols}] | {first_line_80}`
- [x] 2.2 Add unit tests for `formatCompactResults`: truncation at 80 chars, symbols inclusion, empty results, cache key header format

## 3. MCP Tool Changes

- [x] 3.1 Add `compact` parameter (z.boolean().optional().default(false)) to `memory_query`, `memory_search`, `memory_vsearch` tool schemas in `src/server.ts`
- [x] 3.2 Wire compact mode in each search tool handler: when compact=true, cache results via `ResultCache`, return `formatCompactResults`; when compact=false (default), return `formatSearchResults` as before
- [x] 3.3 Register `memory_expand` MCP tool in `src/server.ts` with params: `cacheKey` (string, required), `index` (number, optional), `indices` (number[], optional), `docid` (string, optional). Implement: cache hit → return full formatted result(s); cache miss + docid → fallback to `store.findDocument` with bounded retrieval using cached startLine/endLine (or first 2000 chars if line info unavailable); error cases per spec
- [x] 3.4 Add integration tests for MCP compact mode: memory_query defaults to verbose, memory_query with compact=true returns compact, memory_expand by single index, memory_expand by multiple indices, memory_expand with expired cache + docid fallback (bounded), memory_expand error cases (invalid index, no index/docid, expired cache no docid)

## 4. CLI Integration

- [x] 4.1 Add `--compact` flag to `query`, `search`, `vsearch` CLI commands in `src/index.ts`
- [x] 4.2 Wire `--compact` flag: when present, use `formatCompactResults`; default to verbose for CLI
- [x] 4.3 Ensure `--json` overrides `--compact` (JSON output includes full results, no compact formatting)
- [x] 4.4 Add CLI tests for `--compact` flag: compact output format, default verbose, --json override

## 5. Verification

- [x] 5.1 Run full test suite — all existing + new tests pass
- [x] 5.2 Run `tsc --noEmit` — zero type errors
- [x] 5.3 Manual smoke test: `npx nano-brain query "test" --compact` produces compact output, `memory_expand` works via MCP
