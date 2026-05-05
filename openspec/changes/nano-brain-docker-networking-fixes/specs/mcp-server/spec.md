## MODIFIED Requirements

### Requirement: SSE transport maintains persistent connections with keepalive
The SSE transport SHALL send a keepalive ping (SSE comment `: ping\n\n`) every 30 seconds, register cleanup handlers for `transport.onclose`, `res.on('close')`, and `res.on('error')`, and guard all writes with `res.writableEnded` and `res.destroyed` checks. This replaces any prior requirement that did not mandate keepalive behavior.

#### Scenario: MCP client connected via SSE survives proxy idle timeout
- **WHEN** an MCP client connects via SSE and is idle for 60 seconds
- **THEN** the connection SHALL remain open
- **AND** the client SHALL NOT receive an unexpected disconnection

#### Scenario: SSE session entry is removed on all disconnect paths
- **WHEN** an SSE client disconnects via any means (explicit close, network error, ECONNRESET)
- **THEN** the session entry SHALL be removed from the sessions map
- **AND** the heartbeat interval SHALL be cleared
