## Why

The `serve` command (daemon mode) always uses the **first configured workspace** from `~/.nano-brain/config.yml` as the primary workspace, ignoring `process.cwd()`. This means starting the server from `/path/to/zengamingx` still serves `/path/to/nano-brain` (whichever is listed first in config). Additionally, `code_context`, `code_impact`, and `code_detect_changes` tools lack a `workspace` parameter, so they always query the primary workspace's symbol database — making them useless in multi-workspace setups.

## What Changes

- Fix daemon mode primary workspace selection to respect `cwd` when it matches a configured workspace, falling back to the first configured workspace only when `cwd` is not recognized
- Add `workspace` parameter to `code_context`, `code_impact`, and `code_detect_changes` tools (same pattern as existing `memory_search`/`memory_query` tools)
- When no `workspace` param is provided in daemon mode, `code_*` tools should use the primary workspace (resolved from cwd), not blindly the first config entry

## Capabilities

### New Capabilities
- `daemon-workspace-resolution`: Smart primary workspace selection in daemon mode — use cwd if it matches a configured workspace, fall back to first configured workspace otherwise

### Modified Capabilities
- `workspace-scoping`: Add workspace parameter support to `code_context`, `code_impact`, and `code_detect_changes` tools, matching the existing pattern used by memory/search tools

## Impact

- **Code**: `src/server.ts` — `startServer()` workspace resolution (lines 1434-1440), `code_context` handler (lines 1050-1160), `code_impact` handler (lines 1163-1280), `code_detect_changes` handler (lines 1285-1400)
- **Config**: No config changes needed — existing `~/.nano-brain/config.yml` workspace entries are sufficient
- **APIs**: New optional `workspace` parameter on 3 MCP tools (backward compatible)
- **Behavior change**: Daemon mode primary workspace may change if user starts `serve` from a different directory than before (intentional fix)
