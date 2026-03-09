## ADDED Requirements

### Requirement: context CLI command
The CLI SHALL expose a `context <name>` command that queries the tree-sitter symbol graph for a named symbol and displays its callers, callees, flows, and cluster membership. It SHALL accept `--file=<path>` for disambiguation and `--json` for machine-readable output. It SHALL use `SymbolGraph.handleContext()` internally.

#### Scenario: Symbol found with edges
- **WHEN** user runs `nano-brain context getUserData`
- **THEN** CLI displays the symbol's kind, file, line range, incoming edges (callers), outgoing edges (callees), flows, and cluster label

#### Scenario: Symbol not found
- **WHEN** user runs `nano-brain context nonExistentSymbol`
- **THEN** CLI prints "Symbol not found: nonExistentSymbol" and exits with code 1

#### Scenario: Ambiguous symbol without file filter
- **WHEN** user runs `nano-brain context render` and multiple symbols named "render" exist
- **THEN** CLI prints disambiguation list showing each match's file and kind, and suggests using `--file=<path>`

#### Scenario: JSON output
- **WHEN** user runs `nano-brain context getUserData --json`
- **THEN** CLI prints the full `ContextResult` object as JSON to stdout

### Requirement: code-impact CLI command
The CLI SHALL expose a `code-impact <target>` command that performs tree-sitter symbol graph traversal to assess change risk. It SHALL accept `--direction=upstream|downstream` (default: upstream), `--max-depth=<n>`, `--min-confidence=<n>`, `--file=<path>`, and `--json`. It SHALL use `SymbolGraph.handleImpact()` internally.

#### Scenario: Impact analysis with results
- **WHEN** user runs `nano-brain code-impact DatabaseClient`
- **THEN** CLI displays risk level, direct dependency count, total affected count, affected flows, and dependencies grouped by depth

#### Scenario: No dependencies found
- **WHEN** user runs `nano-brain code-impact isolatedHelper`
- **THEN** CLI displays risk level LOW with 0 direct deps and 0 total affected

#### Scenario: JSON output
- **WHEN** user runs `nano-brain code-impact DatabaseClient --json`
- **THEN** CLI prints the full `ImpactResult` object as JSON to stdout

### Requirement: detect-changes CLI command
The CLI SHALL expose a `detect-changes` command that maps current git diff to affected symbols and flows. It SHALL accept `--scope=unstaged|staged|all` (default: all) and `--json`. It SHALL use `SymbolGraph.handleDetectChanges()` internally.

#### Scenario: Changes detected with affected symbols
- **WHEN** user runs `nano-brain detect-changes` in a git repo with uncommitted changes
- **THEN** CLI displays changed files, affected symbols, affected flows, and overall risk level

#### Scenario: No changes
- **WHEN** user runs `nano-brain detect-changes` with a clean working tree
- **THEN** CLI prints "No changes detected" and exits with code 0

#### Scenario: Not a git repo
- **WHEN** user runs `nano-brain detect-changes` outside a git repository
- **THEN** CLI prints "Not a git repository" and exits with code 1

#### Scenario: JSON output
- **WHEN** user runs `nano-brain detect-changes --json`
- **THEN** CLI prints the full `DetectChangesResult` object as JSON to stdout

### Requirement: Empty symbol graph warning
All three commands SHALL check if `code_symbols` table has 0 rows for the current workspace before querying. If empty, they SHALL print a warning: "Symbol graph is empty. Run `nano-brain reindex` to populate it." and continue (not exit).

#### Scenario: Empty symbol graph
- **WHEN** user runs `nano-brain context foo` and code_symbols has 0 rows
- **THEN** CLI prints warning about empty symbol graph before the "not found" result
