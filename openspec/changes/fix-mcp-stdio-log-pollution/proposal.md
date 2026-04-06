## Why

`nano-brain mcp` uses MCP stdio transport by default. In stdio mode, the process stdout stream is reserved for JSON-RPC frames. Any plain-text logs written to stdout/stderr before transport connection can corrupt the stream and cause client handshake/version negotiation failures (observed as: "Failed to obtain server version...").

Current startup flow enables stdio log suppression (`setStdioMode(true)`) too late:
- `src/index.ts` logs `mcp server start transport=stdio` before server startup.
- `src/server.ts` emits multiple startup logs before `setStdioMode(true)` is called.

This change ensures stdio suppression is enabled before any MCP stdio-path logs are emitted.

## What Changes

- **Early stdio guard in CLI entrypoint**: In `handleMcp()`, enable stdio suppression immediately when running stdio transport (before the first `log()` call).
- **Early stdio guard in server startup**: In `startServer()`, determine transport mode from options and enable stdio suppression before any startup logs/handlers can write to stdout/stderr.
- **OpenSpec capability update**: Add/modify MCP server transport requirement so stdio mode guarantees clean JSON-RPC channel (no log pollution).

## Capabilities

### Modified Capabilities
- `mcp-server`: tighten stdio transport startup behavior to prevent stdout/stderr log pollution before and during MCP handshake.

## Impact

- **Files affected**:
  - `src/index.ts`
  - `src/server.ts`
  - `openspec/changes/fix-mcp-stdio-log-pollution/specs/mcp-server/spec.md`
- **Behavioral impact**:
  - stdio mode no longer emits plain-text startup logs to stdout/stderr.
  - HTTP transport logging behavior remains unchanged.
- **Risk**: Low. Change is narrowly scoped to transport-mode-aware log suppression timing.
