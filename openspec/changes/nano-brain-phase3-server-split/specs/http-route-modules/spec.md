## ADDED Requirements

### Requirement: HTTP route dispatch is extracted to src/http/routes.ts
All pathname-based request dispatch logic (the `if (pathname === ...)` chain from `startServer`) SHALL be extracted to a `handleRequest(req, res, ctx)` function in `src/http/routes.ts`. The HTTP server creation SHALL be in `src/http/server.ts`.

#### Scenario: All existing HTTP routes are handled after extraction
- **WHEN** a request arrives at any of the following paths: `/health`, `/api/status`, `/api/query`, `/api/search`, `/api/write`, `/api/wake-up`, `/api/init`, `/api/reindex`, `/api/embed`, `/api/maintenance/prepare`, `/api/maintenance/resume`, `/api/v1/status`, `/api/v1/workspaces`, `/api/v1/graph/entities`, `/api/v1/graph/stats`, `/api/v1/code/dependencies`, `/api/v1/search`, `/api/v1/telemetry`, `/api/v1/connections`, `/api/v1/graph/symbols`, `/api/v1/graph/flows`, `/api/v1/graph/connections`, `/api/v1/graph/infrastructure`, `/api/v1/tags`, `/api/vsearch`, `/mcp`, `/web`, `/web/*`, `/api/v1/*`
- **THEN** the response SHALL be identical to before the extraction

### Requirement: HTTP server listens on configured port and host
`src/http/server.ts` SHALL export a `createHttpServer(port, host, handler)` function that creates and starts an `http.Server` instance.

#### Scenario: Server binds to configured port
- **WHEN** `createHttpServer(3100, '127.0.0.1', handler)` is called
- **THEN** the server SHALL listen on `127.0.0.1:3100`
