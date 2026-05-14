## Context

`startServer()` in `src/server/bootstrap.ts` calls `createStore()` at line 102, which runs `PRAGMA quick_check` (up to 8 minutes on large DBs). The HTTP server is created at line 326, after all bootstrap work. During the 8-minute window, the TCP port is closed and the CLI cannot distinguish "starting" from "not running".

## Decisions

### Decision 1: Early HTTP binding strategy

**Choice:** Create a mutable handler reference before `createStore()`. Start listening immediately with a minimal handler that serves only `/health` → `{"status":"starting","ready":false}` and returns 503 for all other requests. After bootstrap, atomically swap to the full `handleRequest` handler.

```typescript
// Before createStore()
let requestHandler: http.RequestListener = (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'starting', ready: false }));
    return;
  }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'server is starting up, please retry in a moment' }));
};
httpServer = createHttpServer(httpPort, httpHost, (req, res) => requestHandler(req, res));

// ... createStore(), full bootstrap ...

// After bootstrap:
const httpCtx = { ... };
requestHandler = async (req, res) => { await handleRequest(req, res, httpCtx); };
```

**Rationale:** Zero-downtime swap of the inner handler; the `http.Server` instance stays the same, only the closure variable changes. Thread-safe because Node.js is single-threaded in the event loop.

**Alternative considered:** Two `createHttpServer()` calls (close first, open second). Rejected — brief port closure window causes false "server down" readings.

### Decision 2: detectRunningServer() semantics

**Choice:** Change `detectRunningServer()` to return `true` only when `/health` responds with `ready: true`. When server is starting (`ready: false`), return `false`.

**Rationale:** Commands that call `if (serverRunning) { proxy }` should only proxy when the server can actually handle requests. A starting server returns 503 for most endpoints; proxying to it would give confusing HTTP 503 errors.

**Side-effect:** Commands will fall back to local SQLite during server startup (when not in container mode). This is correct — local mode is the fallback.

### Decision 3: assertContainerServer() helper

**Choice:** Add `assertContainerServer(port?)` to `src/cli/utils.ts`. Returns the `serverRunning` boolean (avoids double HTTP round-trip). Handles the container guard check internally:

```typescript
export async function assertContainerServer(port = DEFAULT_HTTP_PORT): Promise<boolean> {
  const inContainer = isInsideContainer();
  const serverRunning = await detectRunningServer(port);
  if (serverRunning || !inContainer) return serverRunning;

  // In container, server not ready — check if it's starting
  const starting = await isServerStarting(port);
  if (starting) {
    cliError(`Server is starting up at ${getHttpHost()}:${port} — please retry in a moment.`);
    cliError(`  Monitor: docker logs nano-brain`);
  } else {
    cliError(`Error: nano-brain server not reachable at ${getHttpHost()}:${port}. Ensure the Docker container is running:`);
    cliError(`  docker start nano-brain`);
  }
  process.exit(1);
}
```

**Rationale:** 8 commands currently duplicate 5 lines of identical guard logic. Single point of change for future improvements. Returns `serverRunning` so callers can replace two separate calls with one.

### Decision 4: isServerStarting() implementation

**Choice:** Probe `/health` with a 2s timeout. If HTTP 200 AND `ready === false` → starting. Any error or non-200 → down.

```typescript
async function isServerStarting(port: number): Promise<boolean> {
  const host = getHttpHost();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = await resp.json() as { ready?: boolean };
    return data.ready === false;
  } catch { return false; }
}
```

**Rationale:** Mirrors `detectRunningServer()` logic but checks for the opposite condition. Named `isServerStarting` not `detectServerState` to keep it narrowly scoped.

## Error Messages

| State | Message |
|---|---|
| Starting | `Server is starting up at host.docker.internal:3100 — please retry in a moment.\n  Monitor: docker logs nano-brain` |
| Down | `Error: nano-brain server not reachable at host.docker.internal:3100. Ensure the Docker container is running:\n  docker start nano-brain` |

## Files Changed

| File | Change |
|---|---|
| `src/server/bootstrap.ts` | Early HTTP binding with mutable handler |
| `src/cli/utils.ts` | `detectRunningServer()` updated, `isServerStarting()` added, `assertContainerServer()` added |
| `src/cli/commands/{embed,reindex,search,status,tags,update,wake-up,write}.ts` | Replace guard boilerplate with `await assertContainerServer()` |
