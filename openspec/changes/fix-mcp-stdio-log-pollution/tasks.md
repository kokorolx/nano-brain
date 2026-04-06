## 1. OpenSpec artifacts

- [x] 1.1 Create `proposal.md` describing stdio log-pollution handshake failure and intended fix.
- [x] 1.2 Create `design.md` with early-guard decisions in CLI and server startup.
- [x] 1.3 Create `specs/mcp-server/spec.md` with modified stdio cleanliness requirements.

## 2. Implementation

- [x] 2.1 Update `src/index.ts` `handleMcp()` to enable `setStdioMode(true)` before any stdio-path log output.
- [x] 2.2 Update `src/server.ts` `startServer()` to enable stdio mode at the beginning of startup when running stdio transport.
- [x] 2.3 Keep HTTP transport logging behavior unchanged.

## 3. Validation

- [x] 3.1 Run `openspec validate "fix-mcp-stdio-log-pollution" --strict --no-interactive`.
- [x] 3.2 Run `npx -y nano-brain mcp` and verify no plain-text startup log pollution on stdout.
- [x] 3.3 Verify MCP client handshake/version negotiation no longer fails from polluted stdio channel.
