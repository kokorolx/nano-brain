## ADDED Requirements

### Requirement: SSE session management is extracted to src/http/sse.ts
The SSE session Map and the `/sse` (GET) and `/messages` (POST) handlers SHALL be extracted to `src/http/sse.ts`. The mutable session Map SHALL be encapsulated within this module.

#### Scenario: SSE client can connect and receive messages
- **WHEN** a client sends GET /sse
- **THEN** the server SHALL upgrade the connection and return an SSE stream with identical behavior to before the extraction

#### Scenario: Client message delivery works after extraction
- **WHEN** a client sends POST /messages with a session ID
- **THEN** the server SHALL route the message to the correct SSE session with identical behavior to before
