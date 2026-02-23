## ADDED Requirements

### Requirement: memory_index_codebase tool for on-demand indexing
The MCP server SHALL register a `memory_index_codebase` tool that triggers a full codebase scan and index. The tool SHALL accept no required parameters. It SHALL return a summary including: number of files scanned, number of files indexed (new or updated), number of files skipped (unchanged), number of files skipped (too large), and total chunks created. If codebase indexing is not enabled in config, the tool SHALL return an error message indicating that codebase indexing is disabled.

#### Scenario: Successful codebase index
- **WHEN** `memory_index_codebase` is called with codebase indexing enabled and source files exist
- **THEN** the response includes counts for files scanned, indexed, skipped (unchanged), skipped (too large), and chunks created
- **THEN** all matching source files are indexed into the store with the current workspace's projectHash

#### Scenario: Codebase indexing disabled
- **WHEN** `memory_index_codebase` is called but `codebase.enabled` is not set or is `false`
- **THEN** the response contains an error message: "Codebase indexing is not enabled. Set codebase.enabled: true in config.yml"

#### Scenario: No matching files found
- **WHEN** `memory_index_codebase` is called but no files match the configured extensions and exclude patterns
- **THEN** the response indicates 0 files scanned and 0 files indexed

### Requirement: memory_status includes codebase statistics
The `memory_status` tool response SHALL include a `codebase` section when codebase indexing is enabled. This section SHALL report: whether codebase indexing is enabled, number of indexed codebase documents, number of codebase chunks, configured extensions (resolved after auto-detection), and configured exclude pattern count.

#### Scenario: memory_status with codebase enabled
- **WHEN** `memory_status` is called and codebase indexing is enabled with indexed files
- **THEN** the response includes a `codebase` section with `enabled: true`, document count, chunk count, resolved extensions list, and exclude pattern count

#### Scenario: memory_status with codebase disabled
- **WHEN** `memory_status` is called and codebase indexing is not enabled
- **THEN** the response includes `codebase: { enabled: false }` or omits the codebase section entirely

### Requirement: memory_index_codebase tool schema registration
The MCP tool registration for `memory_index_codebase` SHALL include a description explaining its purpose: triggering a full scan and index of source code files in the current workspace. The input schema SHALL have no required parameters.

#### Scenario: Tool schema advertised to MCP client
- **WHEN** an MCP client lists available tools
- **THEN** `memory_index_codebase` appears with a description mentioning codebase/source code indexing
- **THEN** the input schema has no required parameters
