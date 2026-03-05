## Why

nano-brain runs as a background MCP server with no visibility into its operations. When something goes wrong (failed embeddings, stale indexes, watcher issues), there's no way to diagnose after the fact. The only output is scattered `console.error` calls to stderr, which are lost once the process restarts. Users need a persistent log file to debug issues and understand what nano-brain is doing.

## What Changes

- Add a new `src/logger.ts` module providing a file-based logger
- Introduce `NANO_BRAIN_LOG` environment variable: set to `1` to enable logging, unset to disable (default: disabled)
- Log file written to `~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log` with daily rotation by filename
- When disabled, all log calls are no-ops (single boolean check, near-zero CPU overhead)
- Replace existing ad-hoc `console.error("[tag] ...")` calls across all source files with structured logger calls
- Add logging to currently-silent operations: MCP tool invocations, config loading, store operations, search queries
- Log format: `[ISO-timestamp] [TAG] message`

## Capabilities

### New Capabilities
- `file-logging`: File-based logging system with ENV toggle, daily log files, and instrumentation across all modules

### Modified Capabilities

## Impact

- All source files in `src/` will be modified to import and use the logger (~10 files)
- New file: `src/logger.ts`
- New directory created at runtime: `~/.nano-brain/logs/`
- No new dependencies — uses Node.js built-in `fs` only
- No performance impact when disabled (boolean guard on every call)
- MCP stdio transport unaffected — logger writes to file, not stdout/stderr
