## Context

MCP stdio transport multiplexes protocol messages over process stdio. The JSON-RPC channel must remain clean: any non-protocol stdout/stderr output can break handshake and compatibility checks.

Current flow has two pollution points:

1. `src/index.ts` `handleMcp()`
   - Logs transport startup before calling `startServer()`.
   - In default mode (`nano-brain mcp` without `--http`), this writes plain text to stdout before MCP transport is connected.

2. `src/server.ts` `startServer()`
   - Emits multiple logs during initialization and process handler setup.
   - Calls `setStdioMode(true)` only near the stdio transport connect block, after many earlier log calls.

`logger.ts` already supports stdio-safe mode (`setStdioMode(true)`), but it is activated too late.

## Goals / Non-Goals

**Goals**
- Enable stdio-safe logging before any stdio-path log output.
- Preserve existing HTTP transport behavior and observability.
- Keep fix minimal and low risk.

**Non-Goals**
- Reworking logger architecture.
- Changing MCP protocol handling logic.
- Changing log file persistence behavior.

## Decisions

### Decision 1: Early stdio mode in CLI (`handleMcp`)

**Choice**: In `handleMcp()`, once arguments are parsed and `useHttp` is known, call `setStdioMode(true)` when `useHttp === false`, before the first `log()` call.

**Rationale**: Prevents CLI startup log from contaminating stdio before server startup begins.

### Decision 2: Early stdio mode in server startup (`startServer`)

**Choice**: In `startServer()`, derive `isStdioTransport` from options (`!httpPort`) as early as possible and call `setStdioMode(true)` immediately for stdio mode, before process handlers and startup logs.

**Rationale**: Ensures all startup-phase logs are redirected away from stdout/stderr writes while keeping file logging intact.

### Decision 3: Keep existing connect-time stdio guard

**Choice**: Keep existing `setStdioMode(true)` near stdio connect path as a harmless idempotent safety net.

**Rationale**: Defensive redundancy with negligible risk.

## Risks / Trade-offs

- **Risk**: Reduced console visibility in stdio mode.
  - **Mitigation**: Logs are still appended to log files via logger backend.
- **Risk**: Incorrect transport detection.
  - **Mitigation**: Reuse existing transport contract (`httpPort` indicates HTTP mode; absent indicates stdio mode).
- **Trade-off**: Slightly duplicated stdio guard calls.
  - **Justification**: Simpler, safer startup behavior.

## Verification Plan

1. Run OpenSpec strict validation for the change.
2. Run `npx -y nano-brain mcp` and verify no plain-text startup logs are emitted to stdout.
3. Confirm MCP client no longer fails version handshake due to polluted stdio channel.
4. Confirm HTTP mode still emits expected startup logs.
