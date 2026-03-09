# cli-reindex Specification

## Purpose
TBD - created by archiving change cli-code-intelligence-and-ux. Update Purpose after archive.
## Requirements
### Requirement: reindex CLI command
The CLI SHALL expose a `reindex` command that runs codebase indexing only — scanning files, updating chunks, and rebuilding the tree-sitter symbol graph. It SHALL NOT harvest sessions, index collections, or generate embeddings. It SHALL accept `--root=<path>` to specify workspace root (default: cwd).

#### Scenario: Reindex current workspace
- **WHEN** user runs `nano-brain reindex`
- **THEN** CLI scans codebase files, indexes changed files, runs tree-sitter symbol graph indexing, and prints summary (files scanned, indexed, unchanged, symbols, edges)

#### Scenario: Reindex with explicit root
- **WHEN** user runs `nano-brain reindex --root=/path/to/project`
- **THEN** CLI indexes the specified workspace root instead of cwd

#### Scenario: Workspace not configured
- **WHEN** user runs `nano-brain reindex` in a directory not in config.yml workspaces
- **THEN** CLI auto-adds the workspace to config and proceeds with indexing

### Requirement: reindex reports symbol graph stats
After codebase indexing completes, the `reindex` command SHALL query and display the code_symbols count and symbol_edges count for the workspace.

#### Scenario: Symbol graph populated
- **WHEN** reindex completes and tree-sitter parsed symbols
- **THEN** CLI prints "Symbol graph: X symbols, Y edges" after the file indexing summary

