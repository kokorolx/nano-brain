# status-symbol-graph Specification

## Purpose
TBD - created by archiving change cli-code-intelligence-and-ux. Update Purpose after archive.
## Requirements
### Requirement: Status shows symbol graph counts
The `status` command output SHALL include a "Code Intelligence" section displaying: code_symbols count, symbol_edges count, execution_flows count, and tree-sitter availability (yes/no).

#### Scenario: Symbol graph populated
- **WHEN** user runs `nano-brain status` and code_symbols has data
- **THEN** output includes "Code Intelligence:" section with symbol count, edge count, flow count, and "Tree-sitter: available"

#### Scenario: Symbol graph empty
- **WHEN** user runs `nano-brain status` and code_symbols has 0 rows
- **THEN** output includes "Code Intelligence:" section with "0 symbols (run `nano-brain reindex` to populate)" and "Tree-sitter: available" or "Tree-sitter: not available"

#### Scenario: Tree-sitter not available
- **WHEN** user runs `nano-brain status` and tree-sitter native module failed to load
- **THEN** output shows "Tree-sitter: not available" in the Code Intelligence section

