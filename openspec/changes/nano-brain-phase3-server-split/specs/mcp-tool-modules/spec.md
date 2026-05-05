## ADDED Requirements

### Requirement: MCP tools are split into domain group modules
The 30 MCP tools SHALL be registered via four domain-specific files under `src/mcp/tools/`, each exporting a `register*Tools(server, ctx)` function. No tool registration SHALL remain in `src/mcp/index.ts` or `src/server.ts` directly.

#### Scenario: All 30 MCP tools remain registered after the split
- **WHEN** `createMcpServer(deps)` is called
- **THEN** all 30 tools (`memory_search`, `memory_vsearch`, `memory_query`, `memory_expand`, `memory_get`, `memory_multi_get`, `memory_write`, `memory_tags`, `memory_status`, `memory_update`, `memory_wake_up`, `memory_consolidate`, `memory_consolidation_status`, `memory_importance`, `memory_learning_status`, `memory_suggestions`, `memory_graph_stats`, `memory_graph_query`, `memory_related`, `memory_timeline`, `memory_connections`, `memory_traverse`, `memory_connect`, `memory_focus`, `memory_symbols`, `memory_impact`, `code_context`, `code_impact`, `code_detect_changes`, `memory_index_codebase`) SHALL be registered on the returned McpServer instance

### Requirement: McpToolContext provides all shared dependencies to tool handlers
A `McpToolContext` interface SHALL be defined in `src/mcp/tools/types.ts` and SHALL be the sole mechanism for passing shared state (deps, resultCache, checkReady, prependWarning, store, providers, currentProjectHash) to tool registration functions.

#### Scenario: Tool handler can access store via context
- **WHEN** a tool registration function calls `ctx.store.searchFTS(...)`
- **THEN** it SHALL access the same store instance as `deps.store`

#### Scenario: Tool handler can check ready state via context
- **WHEN** a tool handler calls `ctx.checkReady()`
- **THEN** it SHALL return the same value as the original `checkReady()` closure

### Requirement: Tool grouping files cover all 30 tools with no overlap
Each tool SHALL be registered in exactly one file: `memory.ts` (16 tools), `graph.ts` (7 tools), `code.ts` (6 tools), `indexing.ts` (1 tool).

#### Scenario: No duplicate tool registration
- **WHEN** `createMcpServer(deps)` runs all four register* functions
- **THEN** no tool name SHALL be registered twice (McpServer would throw on duplicate)
