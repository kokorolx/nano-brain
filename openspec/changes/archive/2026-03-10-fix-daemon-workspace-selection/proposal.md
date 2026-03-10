## Why

The `serve` command (daemon mode) always uses the **first configured workspace** from `~/.nano-brain/config.yml` as the primary workspace, ignoring `process.cwd()`. This means starting the server from `/path/to/zengamingx` still serves `/path/to/nano-brain` (whichever is listed first in config).

More critically, **most tools are broken in daemon mode** because they hardcode `currentProjectHash` (the startup workspace) instead of accepting a `workspace` parameter. This affects:
- `code_context`, `code_impact`, `code_detect_changes` — query wrong symbol database
- `memory_symbols`, `memory_impact` — query wrong cross-repo symbol index
- `memory_write` — stamps entries with wrong workspace hash
- `memory_search`, `memory_vsearch`, `memory_query` — silently default to `'all'` instead of requiring explicit workspace selection

Since the MCP server runs as a shared daemon (one process serving multiple AI agent sessions in different workspaces), there is no way to auto-detect which workspace the caller is working in. The agent already knows its `cwd`, so the simplest fix is: **require `workspace` parameter in daemon mode for all workspace-scoped tools, return error with available workspaces if missing.**

## What Changes

- Fix daemon mode startup database selection to respect `cwd`
- **Require `workspace` parameter in daemon mode for ALL workspace-scoped tools** (10 tools total). If missing, return error listing available workspaces so the AI agent can self-correct.
- Non-daemon mode (stdio): keep current behavior unchanged — workspace defaults to cwd

### Tools affected (require `workspace` in daemon mode):

| Tool | Current bug | Fix |
|------|------------|-----|
| `memory_search` | Defaults to `'all'` silently | Require `workspace`, error if missing |
| `memory_vsearch` | Defaults to `'all'` silently | Require `workspace`, error if missing |
| `memory_query` | Defaults to `'all'` silently | Require `workspace`, error if missing |
| `memory_symbols` | Hardcodes `currentProjectHash` | Add `workspace` param, require in daemon |
| `memory_impact` | Hardcodes `currentProjectHash` | Add `workspace` param, require in daemon |
| `memory_write` | Stamps with `currentProjectHash` | Add `workspace` param, require in daemon |
| `code_context` | Uses startup workspace DB | Add `workspace` param, require in daemon |
| `code_impact` | Uses startup workspace DB | Add `workspace` param, require in daemon |
| `code_detect_changes` | Hardcodes first workspace | Add `workspace` param, require in daemon |
| `memory_graph_stats` | Iterates all (OK but inconsistent) | Add `workspace` param, require in daemon |

### Tools NOT affected (global or already resolve from path):

| Tool | Why no change |
|------|--------------|
| `memory_get` | Searches by docid/path globally |
| `memory_multi_get` | Searches by docid/path globally |
| `memory_tags` | Lists all tags globally |
| `memory_update` | Reindexes all collections globally |
| `memory_status` | Has `root` param, iterates all workspaces |
| `memory_index_codebase` | Has `root` param, resolves workspace |
| `memory_focus` | Resolves workspace from `filePath` param |

## Capabilities

### New Capabilities
- `daemon-workspace-resolution`: Smart startup database selection in daemon mode — use cwd if it matches a configured workspace, fall back to first configured workspace otherwise

### Modified Capabilities
- `workspace-scoping`: Require `workspace` parameter in daemon mode for all 10 workspace-scoped tools. Return error with available workspaces if missing.

## Impact

- **Code**: `src/server.ts` — `startServer()` (lines 1434-1440), all 10 tool handlers listed above
- **Config**: No config changes needed
- **APIs**: `workspace` parameter becomes effectively required in daemon mode for 10 tools. Non-daemon mode unchanged. Backward compatible for non-daemon users.
- **Behavior change**: Search tools (`memory_search/vsearch/query`) will error instead of silently searching all workspaces. This is intentional — forces explicit workspace selection.
