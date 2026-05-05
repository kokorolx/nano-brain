## Why

When `npx nano-brain` CLI commands run inside the opencode container (started by ai-sandbox-wrapper) and the nano-brain server runs in a separate docker-compose network, several networking bugs cause silent failures, hangs, and incorrect host resolution. These bugs block nano-brain from being usable as an MCP server and memory tool in any containerized AI agent workflow.

## What Changes

- **Delete** the `*Container` duplicate proxy functions (`proxyPostContainer`, `proxyGetContainer`, `detectRunningServerContainer`) from `cli/utils.ts` — they are redundant because `getHttpHost()` already handles container routing
- **Replace** `isRunningInContainer()` (only checks `/.dockerenv`) with `isInsideContainer()` from `host.ts` (also checks cgroups, works in containerd and Docker-in-Docker environments) across all 7 call sites
- **Add** `AbortSignal.timeout(30_000)` to `proxyGet` and `proxyPost` — currently these hang indefinitely if the server is unreachable
- **Add** `resp.ok` check to `proxyGet` and `proxyPost` — currently non-2xx HTTP responses are silently deserialized as if successful
- **Fix** 3 hardcoded `localhost:3100` URLs in `docker.ts` to use `getHttpHost()` — currently health checks fail when run from inside a container
- **Add** SSE heartbeat (30s `setInterval`) to `src/http/sse.ts` and Streamable HTTP transport in `src/http/routes.ts` — currently idle connections are killed by proxies with no keepalive, leaking session entries and disconnecting MCP clients silently
- **Add** migration logic to `docker start` command to rewrite legacy `vector.url: http://host.docker.internal:6333` → `http://qdrant:6333` in user config **BREAKING** (behavior change: qdrant accessed via compose DNS instead of host-gateway)

## Capabilities

### New Capabilities
- `container-aware-cli`: CLI commands correctly detect container context and route all HTTP calls through `host.docker.internal` when running inside any container runtime (Docker, containerd, Docker-in-Docker)
- `resilient-proxy-calls`: All CLI-to-server proxy calls have a 30s timeout and validate HTTP response status before deserializing, with actionable error messages including the `NANO_BRAIN_HOST` env var hint
- `sse-heartbeat`: SSE and Streamable HTTP MCP transports send a keepalive ping every 30s to prevent proxy-induced disconnections, with proper cleanup on all close/error events

### Modified Capabilities
- `mcp-server`: SSE transport gains heartbeat and error-handler cleanup (behavioral change to connection lifecycle)

## Impact

- **Files**: `src/cli/utils.ts`, `src/cli/commands/docker.ts`, `src/cli/commands/wake-up.ts`, `src/cli/commands/search.ts`, `src/cli/commands/write.ts`, `src/cli/commands/embed.ts`, `src/cli/commands/reindex.ts`, `src/cli/commands/init.ts`, `src/http/sse.ts`, `src/http/routes.ts`
- **Breaking**: Users with `vector.url: http://host.docker.internal:6333` in `~/.nano-brain/config.yml` will have that URL migrated to `http://qdrant:6333` on next `docker start`
- **Dependencies**: No new npm dependencies
- **APIs**: No public API changes; proxy function signatures gain optional `timeoutMs` parameter
