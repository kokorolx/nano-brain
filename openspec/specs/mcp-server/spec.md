## Purpose

MCP server providing persistent memory tools (search, status, update, get) for AI coding agents via the Model Context Protocol.
## Requirements
### Requirement: ESM module compliance
All source files in `src/` SHALL use ESM `import` syntax exclusively. No `require()` calls SHALL exist in any TypeScript source file.

#### Scenario: Server starts under Node.js ESM runtime
- **WHEN** the MCP server is started via `node bin/cli.js mcp`
- **THEN** the server starts without `require is not defined` errors
- **THEN** all tool handlers execute without CJS/ESM compatibility errors

#### Scenario: No require() in source files
- **WHEN** running `grep -r "require(" src/` on the source directory
- **THEN** zero matches are returned (excluding comments and string literals)

### Requirement: Dynamic collection config reload
The `memory_update` tool handler SHALL reload the collection configuration file on every invocation, not use the cached startup value.

#### Scenario: Collection added after server start
- **WHEN** a user adds a collection via CLI (`collection add`) while the MCP server is running
- **THEN** calling `memory_update` through MCP indexes documents from the newly added collection
- **THEN** no server restart is required

#### Scenario: Collection removed after server start
- **WHEN** a user removes a collection via CLI while the MCP server is running
- **THEN** calling `memory_update` through MCP no longer indexes documents from the removed collection

### Requirement: All MCP tool handlers return valid responses
Every registered MCP tool SHALL return a valid JSON-RPC response for valid inputs, never an unhandled exception.

#### Scenario: memory_search with valid query
- **WHEN** `memory_search` is called with `{"query": "test"}` via JSON-RPC
- **THEN** a valid response with `content` array is returned

#### Scenario: memory_update with configured collections
- **WHEN** `memory_update` is called via JSON-RPC with collections configured
- **THEN** a valid response with reindex summary is returned, not a runtime error

#### Scenario: memory_status returns health info
- **WHEN** `memory_status` is called via JSON-RPC
- **THEN** a valid response with document count, chunk count, and collection info is returned

### Requirement: Search tools support workspace filtering
The `memory_search`, `memory_vsearch`, and `memory_query` MCP tools SHALL accept an optional `workspace` parameter. When omitted, results are scoped to the current workspace and global documents. When set to `"all"`, results include all workspaces.

#### Scenario: memory_search with default workspace scoping
- **WHEN** `memory_search` is called with `{"query": "test"}` and no `workspace` parameter
- **THEN** results are filtered to `currentProjectHash` and `'global'` documents only

#### Scenario: memory_vsearch with workspace="all"
- **WHEN** `memory_vsearch` is called with `{"query": "test", "workspace": "all"}`
- **THEN** results include documents from all workspaces

#### Scenario: memory_query with specific workspace
- **WHEN** `memory_query` is called with `{"query": "test", "workspace": "abc123def456"}`
- **THEN** results are filtered to `project_hash = 'abc123def456'` and `project_hash = 'global'`

### Requirement: memory_status reports storage usage
The `memory_status` MCP tool SHALL return vector store health, token usage metrics, and per-workspace storage info in addition to the existing index health, collection info, and model status.

#### Scenario: Status with Qdrant vector store
- **WHEN** `memory_status` is called and Qdrant is the active vector provider
- **THEN** the response SHALL include a "Vector Store" section with provider, connectivity status, vector count, and dimensions

#### Scenario: Status with token usage data
- **WHEN** `memory_status` is called and token_usage table has data
- **THEN** the response SHALL include a "Token Usage" section with per-model token counts and request counts

#### Scenario: Status with no vector store or token data
- **WHEN** `memory_status` is called with sqlite-vec (default) and no token usage recorded
- **THEN** the response SHALL include vector store section showing sqlite-vec as built-in, and omit the token usage section

### Requirement: Search tool parameter schema includes workspace
The MCP tool registration for `memory_search`, `memory_vsearch`, and `memory_query` SHALL include `workspace` in their input schema as an optional string parameter with description explaining the scoping behavior.

#### Scenario: Tool schema advertises workspace parameter
- **WHEN** an MCP client lists available tools
- **THEN** `memory_search`, `memory_vsearch`, and `memory_query` each show a `workspace` parameter in their input schema
- **THEN** the parameter description explains: omit for current workspace, `"all"` for cross-workspace search

