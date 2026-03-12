## MODIFIED Requirements

### Requirement: reindex CLI command
The CLI SHALL expose a `reindex` command that runs codebase indexing only — scanning files, updating chunks, and rebuilding the tree-sitter symbol graph. It SHALL NOT harvest sessions, index collections, or generate embeddings. It SHALL accept `--root=<path>` to specify workspace root (default: cwd). When triggered via the `memory_update` MCP tool or `npx nano-brain update` CLI, it SHALL bypass the reindex cooldown by passing `force=true` to `triggerReindex()`.

#### Scenario: Reindex current workspace
- **WHEN** user runs `nano-brain reindex`
- **THEN** CLI scans codebase files, indexes changed files, runs tree-sitter symbol graph indexing, and prints summary (files scanned, indexed, unchanged, symbols, edges)

#### Scenario: Reindex with explicit root
- **WHEN** user runs `nano-brain reindex --root=/path/to/project`
- **THEN** CLI indexes the specified workspace root instead of cwd

#### Scenario: Workspace not configured
- **WHEN** user runs `nano-brain reindex` in a directory not in config.yml workspaces
- **THEN** CLI auto-adds the workspace to config and proceeds with indexing

#### Scenario: Manual reindex bypasses cooldown
- **WHEN** user runs `nano-brain update` or calls `memory_update` MCP tool
- **AND** the reindex cooldown is active
- **THEN** the reindex SHALL proceed immediately, bypassing the cooldown
