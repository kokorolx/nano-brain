## ADDED Requirements

### Requirement: SSE transport sends keepalive pings every 30 seconds
The SSE transport in `src/http/sse.ts` SHALL send an SSE comment (`: ping\n\n`) to the client every 30 seconds to prevent proxy-induced idle disconnections.

#### Scenario: Heartbeat keeps idle connection alive
- **WHEN** an MCP client connects via SSE and sends no messages for 60 seconds
- **THEN** the connection SHALL remain open
- **AND** the client SHALL have received at least one `: ping` comment

#### Scenario: Heartbeat interval is per-connection
- **WHEN** multiple MCP clients are connected simultaneously
- **THEN** each connection SHALL have its own independent heartbeat interval

### Requirement: SSE heartbeat is cleaned up on all close and error events
The heartbeat `setInterval` SHALL be cleared when the connection closes via any code path: `transport.onclose`, `res.on('close')`, or `res.on('error')`.

#### Scenario: Heartbeat stops on client disconnect
- **WHEN** an MCP client disconnects (closes the HTTP connection)
- **THEN** the heartbeat `setInterval` SHALL be cleared
- **AND** no further pings SHALL be written to the response

#### Scenario: Heartbeat stops on network error
- **WHEN** the connection is terminated with ECONNRESET or EPIPE
- **THEN** `res.on('error')` handler SHALL clear the heartbeat interval
- **AND** the error SHALL NOT propagate as an uncaught exception

### Requirement: SSE writes are guarded against writing to closed responses
Before each SSE write (both heartbeat pings and message writes), the handler SHALL check `res.writableEnded` and `res.destroyed` and skip the write if either is true.

#### Scenario: No write to ended response
- **WHEN** a heartbeat fires after the response has already ended
- **THEN** the write SHALL be skipped without error

### Requirement: Streamable HTTP transport also has keepalive and cleanup
The Streamable HTTP transport in `src/http/routes.ts` SHALL apply the same 30s heartbeat and cleanup pattern as the SSE transport.

#### Scenario: Streamable HTTP idle connection survives
- **WHEN** an MCP client connects via Streamable HTTP and is idle for 60 seconds
- **THEN** the connection SHALL remain open
