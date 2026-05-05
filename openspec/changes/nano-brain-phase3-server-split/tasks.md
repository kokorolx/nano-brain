## 1. Shared types and utilities

- [ ] 1.1 Create `src/server/types.ts` — export `ServerOptions`, `ServerDeps`, `ResolvedWorkspace` interfaces (extracted from `src/server.ts` lines 59–95)
- [ ] 1.2 Create `src/server/utils.ts` — export `resolveWorkspace`, `formatSearchResults`, `formatCompactResults`, `formatStatus`, `formatAvailableWorkspaces`, `requireDaemonWorkspace`, `attachTagsToResults`, `abbreviateTag`, `formatTagsCompact`, `sequentialFileAppend` (extracted from lines 49–352)

## 2. MCP tool context and groupings

- [ ] 2.1 Create `src/mcp/tools/types.ts` — export `McpToolContext` interface with fields: `deps`, `resultCache`, `checkReady`, `prependWarning`, `currentProjectHash`, `store`, `providers`
- [ ] 2.2 Create `src/mcp/tools/memory.ts` — export `registerMemoryTools(server, ctx)` registering 16 tools: `memory_search`, `memory_vsearch`, `memory_query`, `memory_expand`, `memory_get`, `memory_multi_get`, `memory_write`, `memory_tags`, `memory_status`, `memory_update`, `memory_wake_up`, `memory_consolidate`, `memory_consolidation_status`, `memory_importance`, `memory_learning_status`, `memory_suggestions`
- [ ] 2.3 Create `src/mcp/tools/graph.ts` — export `registerGraphTools(server, ctx)` registering 7 tools: `memory_graph_stats`, `memory_graph_query`, `memory_related`, `memory_timeline`, `memory_connections`, `memory_traverse`, `memory_connect`
- [ ] 2.4 Create `src/mcp/tools/code.ts` — export `registerCodeTools(server, ctx)` registering 6 tools: `memory_focus`, `memory_symbols`, `memory_impact`, `code_context`, `code_impact`, `code_detect_changes`
- [ ] 2.5 Create `src/mcp/tools/indexing.ts` — export `registerIndexingTools(server, ctx)` registering 1 tool: `memory_index_codebase`

## 3. MCP index

- [ ] 3.1 Create `src/mcp/index.ts` — export `createMcpServer(deps)` that creates McpServer, builds `McpToolContext`, calls all four `register*Tools`, returns server

## 4. HTTP transport

- [ ] 4.1 Create `src/http/sse.ts` — export `createSseRegistry()`, `handleSseConnect(req, res, registry, mcpServer)`, `handleSseMessage(req, res, registry)` (extracted from startServer SSE section)
- [ ] 4.2 Create `src/http/routes.ts` — export `handleRequest(req, res, ctx: HttpContext)` containing the full pathname dispatch chain (lines ~3076–4034); export `HttpContext` interface
- [ ] 4.3 Create `src/http/server.ts` — export `createHttpServer(port, host, handler)` wrapping `http.createServer` + `listen`

## 5. Server bootstrap

- [ ] 5.1 Create `src/server/bootstrap.ts` — export `startServer(options)` and `createRejectionThreshold(limit, windowMs)` (extracted from lines 2784–4167); imports from `../mcp/index.js`, `../http/server.js`, `../http/routes.js`, `../http/sse.js`, `../server/types.js`, `../server/utils.js`

## 6. Barrel shim

- [ ] 6.1 Replace `src/server.ts` content with barrel shim re-exporting from all new modules: `export * from './server/types.js'`, `export * from './server/utils.js'`, `export * from './server/bootstrap.js'`, `export { createMcpServer } from './mcp/index.js'`

## 7. Verification

- [ ] 7.1 Run `npx tsc --noEmit` — verify zero errors in `src/mcp/`, `src/http/`, `src/server/` (pre-existing bench.ts + treesitter.ts errors acceptable)
- [ ] 7.2 Run full test suite — verify 1,518+ tests pass (watcher.test.ts pre-existing failures acceptable)
- [ ] 7.3 Run `lsp_diagnostics` on `src/server.ts`, `src/mcp/index.ts`, `src/server/bootstrap.ts` — verify clean
- [ ] 7.4 Smoke test: `npx nano-brain status` executes without error

## 8. Commit

- [ ] 8.1 Stage all new `src/mcp/`, `src/http/`, `src/server/` files and modified `src/server.ts`
- [ ] 8.2 Commit: `refactor: split server.ts into src/mcp/, src/http/, src/server/ modules`
