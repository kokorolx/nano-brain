## Why

`src/server.ts` is a 4,167-line monolith that mixes five completely unrelated concerns: 30 MCP tool definitions, HTTP route handlers, SSE session management, file watcher lifecycle, and the server bootstrap/shutdown logic. No single concern can be read or modified without navigating the entire file. Phase 3 splits it into bounded modules using the same barrel-shim pattern proven in Phases 1 and 2.

## What Changes

- `createMcpServer()` (lines 353–2783, 30 tools) → split by domain into `src/mcp/tools/*.ts` (one file per tool group), composed in `src/mcp/index.ts`
- HTTP route handlers (lines 3072–4034, ~962 lines) → `src/http/routes.ts` + `src/http/server.ts`
- SSE session management → `src/http/sse.ts`
- Shared formatter/helper functions (lines 49–352) → `src/server/utils.ts`
- Server bootstrap `startServer()` + `ServerDeps` type → `src/server/bootstrap.ts`
- `src/server.ts` becomes a thin barrel shim re-exporting `startServer`, `createMcpServer`, `formatCompactResults`, `formatSearchResults`, `formatStatus`, `resolveWorkspace`, `createRejectionThreshold`

## Capabilities

### New Capabilities

- `mcp-tool-modules`: The 30 MCP tools are split into domain groups, each in its own file under `src/mcp/tools/`. Groups: `memory` (search, vsearch, query, expand, get, multi-get, write, tags, status, update, wake-up, consolidate, consolidation-status, importance, learning-status, suggestions), `graph` (graph-stats, graph-query, related, timeline, connections, traverse, connect), `code` (focus, symbols, impact, code-impact, detect-changes), `indexing` (index-codebase).
- `http-route-modules`: HTTP route handlers are split into `src/http/routes.ts` (all `pathname` dispatch logic) and `src/http/server.ts` (`http.createServer` + `listen`).
- `sse-module`: SSE session map and `/sse` + `/messages` handlers extracted to `src/http/sse.ts`.

### Modified Capabilities

- `mcp-server`: `createMcpServer()` moves from `src/server.ts` to `src/mcp/index.ts`. Behavior unchanged.

## Impact

- **Files added**: `src/mcp/index.ts`, `src/mcp/tools/memory.ts`, `src/mcp/tools/graph.ts`, `src/mcp/tools/code.ts`, `src/mcp/tools/indexing.ts`, `src/http/server.ts`, `src/http/routes.ts`, `src/http/sse.ts`, `src/server/bootstrap.ts`, `src/server/utils.ts`
- **Files modified**: `src/server.ts` (becomes thin barrel shim, ~10 lines)
- **No public API changes**: all existing exports preserved via barrel shim
- **No CLI changes**: `src/cli/commands/mcp.ts` imports `startServer` from `server.js` — shim keeps this working
- **Tests**: No test changes required
