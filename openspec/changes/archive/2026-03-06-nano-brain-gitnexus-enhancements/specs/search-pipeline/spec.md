## MODIFIED Requirements

### Requirement: Search results include symbol-level context
The search pipeline SHALL enrich search results with symbol-level metadata when the symbol graph is available: cluster label, process participation count, and caller/callee counts.

#### Scenario: Search result for a file with indexed symbols
- **WHEN** a search query returns a file that has symbols in the symbol graph
- **THEN** each result includes additional fields: `symbols` (list of symbol names in that file), `clusterLabel` (the dominant cluster label for symbols in that file), `flowCount` (number of execution flows symbols in that file participate in)

#### Scenario: Search result for a file without indexed symbols
- **WHEN** a search query returns a file that has no symbols in the symbol graph (e.g., markdown, config)
- **THEN** the result is returned as-is with no symbol enrichment (backward compatible)

#### Scenario: Symbol graph not available
- **WHEN** Tree-sitter failed to load or symbol indexing has not been run
- **THEN** search results are returned without symbol enrichment (fully backward compatible)
