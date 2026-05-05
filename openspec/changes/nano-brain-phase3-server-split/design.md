## Context

`src/server.ts` (4,167 lines) has three major zones:

| Zone | Lines | Content |
|------|-------|---------|
| Types + shared utilities | 1–352 | `ServerOptions`, `ServerDeps`, `ResolvedWorkspace`, `resolveWorkspace`, formatters, helpers |
| `createMcpServer()` | 353–2783 | 30 MCP tools registered as closures over `deps`, `resultCache`, `checkReady`, `prependWarning` |
| `startServer()` | 2803–4167 | Bootstrap, provider lifecycle, watcher, HTTP server, routes, SSE, MCP transport |

Key insight from Phase 1/2: the same barrel-shim pattern applies. The split must respect the closure dependency: all 30 MCP tool handlers capture `deps`, `store`, `providers`, `currentProjectHash`, `resultCache`, `checkReady`, `prependWarning` from the enclosing `createMcpServer` scope.

## Goals / Non-Goals

**Goals:**
- Extract 30 MCP tools into domain groups under `src/mcp/tools/`
- Extract HTTP routes into `src/http/routes.ts`
- Extract SSE session management into `src/http/sse.ts`
- Extract `startServer()` bootstrap into `src/server/bootstrap.ts`
- Extract shared types/formatters into `src/server/types.ts` and `src/server/utils.ts`
- `src/server.ts` becomes a thin barrel shim (~10 lines)
- Zero behavior changes

**Non-Goals:**
- Refactoring logic inside any tool handler
- Changing `ServerDeps` shape or adding new fields
- Splitting `handleQdrant`-scale sub-commands within any MCP tool
- Adding tests

## Decisions

### D1: McpToolContext type for tool registration functions

Each `src/mcp/tools/*.ts` file exports a `register*Tools(server, ctx)` function instead of directly registering tools:

```typescript
// src/mcp/tools/types.ts
export interface McpToolContext {
  deps: ServerDeps;
  resultCache: ResultCache;
  checkReady: () => boolean;
  prependWarning: (text: string) => string;
  currentProjectHash: string;
  store: Store;
  providers: SearchProviders;
}

// src/mcp/tools/memory.ts
export function registerMemoryTools(server: McpServer, ctx: McpToolContext): void {
  server.tool('memory_search', ..., async (...) => {
    if (ctx.checkReady()) return WARMUP_ERROR;
    // uses ctx.store, ctx.providers, ctx.resultCache, ctx.prependWarning
  });
  // ... remaining 15 memory tools
}
```

`src/mcp/index.ts` composes them:
```typescript
export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(...);
  const resultCache = new ResultCache();
  const checkReady = () => deps.ready && !deps.ready.value;
  const getCorruptionWarning = (): string | null => { ... };
  const prependWarning = (text: string) => { ... };
  const ctx: McpToolContext = { deps, resultCache, checkReady, prependWarning, currentProjectHash: deps.currentProjectHash, store: deps.store, providers: deps.providers };

  registerMemoryTools(server, ctx);
  registerGraphTools(server, ctx);
  registerCodeTools(server, ctx);
  registerIndexingTools(server, ctx);
  return server;
}
```

**Alternative considered:** Pass individual fields instead of a context object. Rejected — too many parameters (7+), brittle when adding fields.

**Alternative considered:** Use a class. Rejected — unnecessary OOP overhead, functional pattern is simpler and consistent with existing codebase style.

### D2: Tool groupings

30 tools → 4 files:

| File | Tools (16 total memory, 7 graph, 6 code, 1 indexing) |
|------|------|
| `memory.ts` | `memory_search`, `memory_vsearch`, `memory_query`, `memory_expand`, `memory_get`, `memory_multi_get`, `memory_write`, `memory_tags`, `memory_status`, `memory_update`, `memory_wake_up`, `memory_consolidate`, `memory_consolidation_status`, `memory_importance`, `memory_learning_status`, `memory_suggestions` |
| `graph.ts` | `memory_graph_stats`, `memory_graph_query`, `memory_related`, `memory_timeline`, `memory_connections`, `memory_traverse`, `memory_connect` |
| `code.ts` | `memory_focus`, `memory_symbols`, `memory_impact`, `code_context`, `code_impact`, `code_detect_changes` |
| `indexing.ts` | `memory_index_codebase` |

**Alternative considered:** One file per tool (30 files). Rejected — too granular, most tools are 30–80 lines, the overhead outweighs the benefit.

### D3: HTTP routes extracted to src/http/routes.ts

The `http.createServer` callback (lines 3072–4034) is a single large if/else chain dispatching on `pathname`. Extract the entire callback body as `handleRequest(req, res, ctx: HttpContext)` in `src/http/routes.ts`. `HttpContext` carries the deps it needs.

`src/http/server.ts` contains `createHttpServer(port, host, ctx)` — just `http.createServer(handleRequest.bind(null, ctx))` + `listen`.

### D4: SSE in src/http/sse.ts

The SSE session Map (`sseSessions`) and `/sse` + `/messages` handlers share mutable state. Extract together to avoid cross-file mutable state references.

`src/http/sse.ts` exports:
- `createSseRegistry()` — returns the session map + bind/unbind helpers
- `handleSseConnect(req, res, registry, mcpServer)` — GET /sse
- `handleSseMessage(req, res, registry)` — POST /messages

### D5: Bootstrap stays in src/server/bootstrap.ts

`startServer()` orchestrates provider loading, watcher start, and HTTP server lifecycle. It's 1,364 lines and references many local variables. Extract as-is into `src/server/bootstrap.ts` — no internal restructuring.

### D6: Barrel shim pattern (consistent with Phase 1 and 2)

`src/server.ts` becomes:
```typescript
export * from './server/bootstrap.js';
export * from './server/types.js';
export * from './server/utils.js';
export { createMcpServer } from './mcp/index.js';
```

All existing `import { startServer } from './server.js'` in `src/cli/commands/mcp.ts` continue to work.

## Risks / Trade-offs

- **Closure extraction complexity**: Tools in `createMcpServer` capture closures (`checkReady`, `prependWarning`, `resultCache`) defined in the function scope. The `McpToolContext` pattern resolves this cleanly without changing behavior. → Mitigation: `ctx` object passed by reference — closures become `ctx.checkReady()`.
- **`startServer` size (1,364 lines)**: Extracting as-is preserves correctness; internal restructuring is out of scope. → Mitigation: No internal changes, copy verbatim.
- **SSE mutable state**: `sseSessions` Map is referenced by both GET /sse and POST /messages. Must be extracted together. → Mitigation: Both handlers live in `src/http/sse.ts` sharing the same module-scoped Map.
- **Streamable HTTP transport**: Lines ~3982–4034 handle `/mcp` (StreamableHTTP transport) separately from `/sse`. Must be included in the HTTP routes extraction. → Mitigation: `handleRequest` covers all pathnames including `/mcp`.

## Migration Plan

1. Create `src/server/types.ts` — `ServerOptions`, `ServerDeps`, `ResolvedWorkspace` interfaces
2. Create `src/server/utils.ts` — `resolveWorkspace`, formatters, shared helpers
3. Create `src/mcp/tools/types.ts` — `McpToolContext` interface
4. Create `src/mcp/tools/memory.ts` — 16 memory tools
5. Create `src/mcp/tools/graph.ts` — 7 graph tools
6. Create `src/mcp/tools/code.ts` — 6 code tools
7. Create `src/mcp/tools/indexing.ts` — 1 indexing tool
8. Create `src/mcp/index.ts` — `createMcpServer` composed from register* functions
9. Create `src/http/sse.ts` — SSE session management
10. Create `src/http/routes.ts` — `handleRequest` (the full pathname dispatch chain)
11. Create `src/http/server.ts` — `createHttpServer` wrapping `http.createServer`
12. Create `src/server/bootstrap.ts` — `startServer`, `createRejectionThreshold`
13. Replace `src/server.ts` with barrel shim
14. `tsc --noEmit` → 0 errors in new files
15. Run tests → 1,518+ passing

Rollback: `git revert` the single commit.

## Open Questions

None — pattern is proven from Phase 1 and 2. The only novel element is the `McpToolContext` closure-passing pattern, which is a straightforward object parameter.
