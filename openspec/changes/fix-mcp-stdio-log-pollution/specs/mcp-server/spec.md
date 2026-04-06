## MODIFIED Requirements

### Requirement: MCP stdio transport MUST preserve a clean JSON-RPC stream
When running `nano-brain mcp` in stdio transport mode (default), the system SHALL avoid writing non-protocol plain-text logs to stdout/stderr before and during MCP transport handshake.

#### Scenario: Stdio startup emits no plain-text preamble
- **WHEN** the server starts in stdio mode
- **THEN** startup log lines are suppressed from stdout/stderr writes before `StdioServerTransport` is connected
- **AND** stdout remains reserved for MCP JSON-RPC frames

#### Scenario: Compatibility handshake is not broken by log pollution
- **WHEN** an MCP client performs initial version/capability negotiation over stdio
- **THEN** the negotiation succeeds without parse/handshake errors caused by plain-text startup logs

### Requirement: HTTP transport logging remains unchanged
The system SHALL continue emitting normal startup logs for HTTP transport mode.

#### Scenario: HTTP startup still logs endpoint information
- **WHEN** the server starts with `--http`
- **THEN** startup logs include bind address/port and endpoint information as before
