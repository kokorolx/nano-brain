## ADDED Requirements

### Requirement: Daemon mode respects cwd for workspace selection
When the MCP server starts in daemon mode, it SHALL check if `process.cwd()` matches a configured workspace before falling back to the first configured workspace. Resolution order: (1) `--root` flag if provided, (2) cwd if it matches a configured workspace, (3) first configured workspace.

#### Scenario: cwd matches a configured workspace
- **WHEN** server starts in daemon mode and cwd is `/path/to/zengamingx` which is in config.yml workspaces
- **THEN** server uses `/path/to/zengamingx` as the primary workspace and loads its database

#### Scenario: cwd does not match any configured workspace
- **WHEN** server starts in daemon mode and cwd is `/tmp` which is not in config.yml workspaces
- **THEN** server falls back to the first configured workspace (existing behavior)

#### Scenario: --root flag overrides everything
- **WHEN** server starts with `--root=/path/to/project` in daemon mode
- **THEN** server uses `/path/to/project` as the primary workspace regardless of cwd or config order

### Requirement: serve command accepts --root flag
The `serve` command SHALL accept `--root=<path>` to explicitly set the primary workspace. This flag SHALL be forwarded to the underlying `mcp` command.

#### Scenario: serve with --root
- **WHEN** user runs `npx nano-brain serve --root=/path/to/project`
- **THEN** the spawned daemon process uses `/path/to/project` as its primary workspace

### Requirement: mcp command accepts --root flag
The `mcp` command SHALL accept `--root=<path>` to set the primary workspace root, overriding both cwd and config-based resolution.

#### Scenario: mcp with --root
- **WHEN** server starts with `mcp --http --daemon --root=/path/to/project`
- **THEN** server uses `/path/to/project` as the primary workspace
