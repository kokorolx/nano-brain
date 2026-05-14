## 1. Server: early HTTP binding

- [ ] 1.1 In `src/server/bootstrap.ts`, before `createStore()`: declare `let requestHandler: http.RequestListener` with a minimal implementation that returns `/health → {"status":"starting","ready":false}` and 503 for all others
- [ ] 1.2 Start `httpServer = createHttpServer(httpPort, httpHost, (req, res) => requestHandler(req, res))` before `createStore()` (only in HTTP mode)
- [ ] 1.3 After full bootstrap (after `httpCtx` is built): assign `requestHandler = async (req, res) => { await handleRequest(req, res, httpCtx); }`

## 2. CLI utils: new helpers

- [ ] 2.1 Update `detectRunningServer()` to return `true` only when `/health` returns `ready: true` (parse JSON, check `data.ready === true`)
- [ ] 2.2 Add `isServerStarting(port)`: returns `true` when `/health` returns HTTP 200 with `ready: false`
- [ ] 2.3 Add `assertContainerServer(port?)`: checks container + server state, shows right error message, calls `process.exit(1)` if container + not ready; returns `serverRunning: boolean`

## 3. CLI commands: replace guard boilerplate

Replace the 5-line guard pattern in each command with `const serverRunning = await assertContainerServer()`:

- [ ] 3.1 `src/cli/commands/tags.ts`
- [ ] 3.2 `src/cli/commands/update.ts`
- [ ] 3.3 `src/cli/commands/status.ts`
- [ ] 3.4 `src/cli/commands/write.ts`
- [ ] 3.5 `src/cli/commands/search.ts`
- [ ] 3.6 `src/cli/commands/embed.ts`
- [ ] 3.7 `src/cli/commands/reindex.ts`
- [ ] 3.8 `src/cli/commands/wake-up.ts`

## 4. Tests

- [ ] 4.1 `test/cli-proxy.test.ts`: add test — when `/health` returns `ready: false`, `assertContainerServer()` exits with "starting up" message (not "not running")
- [ ] 4.2 `test/cli-proxy.test.ts`: add test — `detectRunningServer()` returns `false` when `/health` returns `ready: false`
- [ ] 4.3 `test/cli-proxy.test.ts`: add test — `detectRunningServer()` returns `true` when `/health` returns `ready: true`
- [ ] 4.4 Existing tests in `test/cli-proxy.test.ts` still pass (server mock updated to return `ready: true`)
