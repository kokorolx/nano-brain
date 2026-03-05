## Context

nano-brain currently outputs diagnostic messages via scattered `console.error("[tag] ...")` calls across ~10 source files. These messages go to stderr and are lost when the MCP server restarts. There is no file-based logging, no way to control verbosity, and no persistent record of operations.

The MCP server uses stdio transport, meaning stdout is reserved for protocol messages. Any logging must avoid stdout entirely.

## Goals / Non-Goals

**Goals:**
- Provide a file-based logger that writes to `~/.nano-brain/logs/`
- Simple on/off toggle via `NANO_BRAIN_LOG=1` environment variable
- Zero overhead when disabled (boolean guard, no string formatting)
- Replace all existing `console.error("[tag]")` patterns with logger calls
- Add logging to currently-silent operations (MCP tool calls, store ops, config loading)
- Daily log file rotation by filename (`nano-brain-YYYY-MM-DD.log`)

**Non-Goals:**
- Multiple log levels (info/debug/trace) — keeping it simple: on or off
- Log rotation by size or automatic cleanup of old log files
- Structured JSON logging
- Remote log shipping
- Adding logging as a config.yml option (ENV-only for now)

## Decisions

### 1. Singleton module pattern over class instance

The logger will be a module-level singleton initialized on first import. Every source file does `import { log } from './logger.js'` and calls `log('tag', 'message')`.

**Why**: Matches the existing codebase pattern where modules export functions directly. No need to pass a logger instance through dependency injection — the codebase doesn't use DI anywhere.

**Alternative considered**: Logger class passed via `ServerDeps` — rejected because it would require threading the instance through every function call, and CLI commands (index.ts) don't use `ServerDeps`.

### 2. `fs.appendFileSync` for writes

Each log call appends synchronously to the log file.

**Why**: Simplicity. nano-brain is not a high-throughput server — log writes happen at most a few times per second during indexing bursts. Async buffered writes add complexity (flush-on-exit, lost-on-crash) for negligible benefit.

**Alternative considered**: Buffered async writes with periodic flush — rejected as over-engineering for the write frequency.

### 3. ENV variable (`NANO_BRAIN_LOG`) over config.yml

Logging is controlled exclusively by the `NANO_BRAIN_LOG` environment variable.

**Why**: Config.yml is loaded after the store is created, but we need logging during startup before config is available. ENV is available immediately. It's also the standard pattern for debug logging in Node.js ecosystem (`DEBUG=*`, `NODE_DEBUG=*`).

### 4. Keep `console.error` for MCP server lifecycle messages

The existing `console.error("[memory] Workspace: ...")` and `console.error("MCP server started on stdio")` messages in server.ts will be kept as-is AND additionally logged to file. These stderr messages are useful for MCP client integration (opencode reads them).

**Why**: MCP clients may depend on these stderr messages for status. Removing them could break integrations.

### 5. Log file path: `~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log`

**Why**: Consistent with the existing `~/.nano-brain/` directory structure. Daily files prevent unbounded growth without needing rotation logic.

## Risks / Trade-offs

- **[Disk usage]** → Daily log files could accumulate. Mitigated by: logs are text-only and small (KB/day typical). Users can delete old files manually. Future enhancement could add auto-cleanup.
- **[Sync I/O on hot path]** → `appendFileSync` blocks the event loop briefly. Mitigated by: log calls are guarded by a boolean check; when disabled, zero I/O. When enabled, writes are small strings and infrequent relative to the event loop budget.
- **[Missing logs on crash]** → Sync writes mean no buffered data is lost on crash. This is actually an advantage over async approaches.
