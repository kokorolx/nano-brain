## 1. Container Detection (Bug 3)

- [x] 1.1 In `src/cli/utils.ts`: remove `isRunningInContainer()` function and its import of `existsSync` if no longer needed
- [x] 1.2 In `src/cli/utils.ts`: update `getHttpHost()` to call `isInsideContainer()` from `'../host.js'`
- [x] 1.3 In `src/cli/commands/wake-up.ts`: replace `isRunningInContainer` import with `isInsideContainer` from `'../../host.js'`
- [x] 1.4 In `src/cli/commands/search.ts`: replace `isRunningInContainer` import with `isInsideContainer`
- [x] 1.5 In `src/cli/commands/write.ts`: replace `isRunningInContainer` import with `isInsideContainer`
- [x] 1.6 In `src/cli/commands/embed.ts`: replace `isRunningInContainer` import with `isInsideContainer`
- [x] 1.7 In `src/cli/commands/reindex.ts`: replace `isRunningInContainer` import with `isInsideContainer`
- [x] 1.8 In `src/cli/commands/init.ts`: replace `isRunningInContainer` import with `isInsideContainer`; verify the container guard that blocks `--force --all` still uses the same `if (inContainer) return` semantics
- [x] 1.9 Run `npx tsc --noEmit` — must be clean before proceeding

## 2. Proxy Unification + Timeouts + resp.ok (Bug 2 + Bug 4, ATOMIC)

- [x] 2.1 In `src/cli/utils.ts`: delete `proxyGetContainer`, `proxyPostContainer`, `detectRunningServerContainer`
- [x] 2.2 In `src/cli/utils.ts`: add `AbortSignal.timeout(timeoutMs)` to `proxyGet` with `timeoutMs = 30_000` default parameter
- [x] 2.3 In `src/cli/utils.ts`: add `AbortSignal.timeout(timeoutMs)` to `proxyPost` with `timeoutMs = 30_000` default parameter
- [x] 2.4 In `src/cli/utils.ts`: add `if (!resp.ok) throw new Error(\`HTTP \${resp.status}: \${resp.statusText}\`)` to both `proxyGet` and `proxyPost` after the fetch call
- [x] 2.5 In `src/cli/utils.ts`: update `detectRunningServer` timeout to 2000ms (was 1000ms)
- [x] 2.6 In `src/cli/commands/wake-up.ts`: remove `proxyPostContainer` and `detectRunningServerContainer` imports; collapse the `inContainer` ternary for proxy selection to always call `proxyPost`; keep `inContainer` variable for the error-path message
- [x] 2.7 In `src/cli/commands/search.ts`: same as 2.6 — remove Container imports, collapse proxy ternary, keep `inContainer` for error path
- [x] 2.8 In `src/cli/commands/write.ts`: remove `proxyPostContainer` import; replace with `proxyPost`
- [x] 2.9 In `src/cli/commands/embed.ts`: remove `proxyPostContainer` import; replace with `proxyPost`
- [x] 2.10 In `src/cli/commands/reindex.ts`: remove `proxyPostContainer` import; replace with `proxyPost`
- [x] 2.11 Run `npx tsc --noEmit` — must be clean
- [x] 2.12 Verify: `grep -r 'Container' src/cli/` returns zero matches

## 3. docker.ts Health Check URLs (Bug 1)

- [x] 3.1 In `src/cli/commands/docker.ts`: import `getHttpHost` from `'../utils.js'`
- [x] 3.2 Replace hardcoded `localhost:3100` fetch URLs at lines ~54, ~105, ~163 with `` `http://${getHttpHost()}:3100` `` (functional URLs only — leave `cliOutput` display strings at ~69, ~123, ~165 as-is)
- [x] 3.5 Run `npx tsc --noEmit` — must be clean

## 4. User Config Migration (Bug 5 — user config)

- [x] 4.1 In `src/cli/commands/docker.ts`: in the `start` command handler, before spawning docker-compose, read `~/.nano-brain/config.yml` using `js-yaml`
- [x] 4.2 Check if `config.vector?.url === 'http://host.docker.internal:6333'`; if so, rewrite to `http://qdrant:6333`, write back to disk, and print migration notice
- [x] 4.3 Run `npx tsc --noEmit` — must be clean

## 5. SSE + Streamable HTTP Heartbeat (Bug 6)

- [x] 5.1 In `src/http/sse.ts` `handleSseConnect`: add `const heartbeatInterval = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 30_000)`
- [x] 5.2 In `src/http/sse.ts`: add `res.on('close', () => clearInterval(heartbeatInterval))` and `res.on('error', () => clearInterval(heartbeatInterval))`
- [x] 5.3 In `src/http/sse.ts`: add `transport.onclose = () => clearInterval(heartbeatInterval)` after transport is created
- [x] 5.4 In `src/http/routes.ts`: locate the Streamable HTTP connection handler and apply the identical heartbeat + cleanup pattern
- [x] 5.5 Run `npx tsc --noEmit` — must be clean

## 6. Verification

- [ ] 6.1 Run full TypeScript check: `npx tsc --noEmit` across entire project
- [ ] 6.2 Verify no Container-suffixed symbols remain: `grep -r 'Container' src/cli/` → zero matches
- [ ] 6.3 Verify no hardcoded `localhost:3100` in docker.ts: `grep 'localhost:3100' src/cli/commands/docker.ts` → zero matches
- [ ] 6.4 Manual smoke test: from inside container, run `npx nano-brain query "test"` and verify it reaches server or fails fast with actionable error (not hang)
