## Context

**Deployment topology:**
```
macOS Host
├── Ollama (native, port 11434)
├── [docker-compose network: nano-brain_default]
│   ├── nano-brain-server (node:22, port 3100)
│   └── nano-brain-qdrant (qdrant:latest, port 6333)
└── opencode container (ai-sandbox-wrapper, isolated bridge network)
      --add-host=host.docker.internal:host-gateway  ← always injected
      -v ~/.nano-brain:/home/agent/.nano-brain        ← always mounted
```

The CLI runs inside the opencode container. The server runs in a separate docker-compose network. The two containers share no Docker network, but both resolve `host.docker.internal` to the macOS host gateway. The CLI uses `host.docker.internal:3100` to reach the server (via host-gateway → compose port mapping).

**Current failures:**
1. `proxyPost`/`proxyGet` hang forever when server is unreachable (no timeout)
2. Non-2xx responses are silently deserialized, masking server errors
3. `docker.ts` health checks hardcode `localhost:3100` — fails inside container
4. `isRunningInContainer()` misses containerd runtimes (no cgroup check)
5. Duplicate `*Container` proxy functions add dead weight and confuse call sites
6. SSE and Streamable HTTP connections drop silently after proxy idle timeout (no heartbeat)
7. User config has `vector.url: http://host.docker.internal:6333` (set when qdrant was exposed on host) — qdrant is now on the compose-internal network but user config is never migrated

## Goals / Non-Goals

**Goals:**
- All `npx nano-brain` commands work correctly from inside the opencode container
- All proxy calls fail fast (≤30s) with actionable error messages
- SSE and Streamable HTTP MCP connections survive 60+ seconds of idle time
- User config migration runs automatically on `docker start`

**Non-Goals:**
- Supporting arbitrary Docker network topologies (only the ai-sandbox-wrapper + docker-compose setup is supported)
- CORS fixes for the web dashboard (separate concern)
- Adding retry logic to proxy calls (single attempt with timeout is sufficient)

## Decisions

### D1: Use `isInsideContainer()` from `host.ts` instead of `isRunningInContainer()` from `cli/utils.ts`

`isInsideContainer()` checks both `/.dockerenv` and `/proc/self/cgroup` for container markers, while `isRunningInContainer()` only checks `/.dockerenv`. `isInsideContainer()` also caches its result.

**Alternative considered:** Patch `isRunningInContainer()` in-place. Rejected — `isInsideContainer()` already exists in `host.ts` with the correct logic; patching in-place creates two implementations to maintain.

### D2: Delete `*Container` duplicate functions entirely

`proxyPostContainer`, `proxyGetContainer`, and `detectRunningServerContainer` are functionally identical to their non-Container counterparts because `getHttpHost()` already handles container routing. The only difference is a 1s vs 2s timeout in `detectRunningServer`.

**Alternative considered:** Keep both and deprecate. Rejected — the Container variants are already incorrect abstractions and no external callers exist outside this codebase.

### D3: Use `AbortSignal.timeout(30_000)` not manual `AbortController`

`AbortSignal.timeout()` is the established pattern in this codebase (see `src/embedding/embeddings.ts`, `src/llm/llm-provider.ts`, `src/search/reranker.ts`). No cleanup code required.

**Alternative considered:** Manual `AbortController` with `setTimeout` + `clearTimeout`. Rejected — more boilerplate, inconsistent with codebase style.

### D4: Expose optional `timeoutMs` parameter on proxy functions

Signature: `proxyPost(port, path, body, timeoutMs = 30_000)`. This allows callers that need different timeouts (e.g., `detectRunningServer` needs 2s) to pass it inline rather than duplicating the function.

### D5: Migrate qdrant URL in user config during `docker start`

The user's `~/.nano-brain/config.yml` has `vector.url: http://host.docker.internal:6333`. This worked when qdrant was port-mapped, but is fragile and wrong now that qdrant is only reachable internally via compose DNS (`qdrant:6333`) from the server container.

The migration runs in `docker.ts` before spawning containers: read config YAML, check for the legacy URL, rewrite to `http://qdrant:6333`, write back, log notice. Uses `js-yaml` (already a dependency).

**Alternative considered:** Document it and ask users to fix manually. Rejected — the bug is invisible and the migration is a single YAML key rewrite.

### D6: SSE heartbeat as SSE comment, 30s interval, per-connection local var

`setInterval` stored in a local `const heartbeatInterval` inside the SSE/HTTP connection handler. Cleared in all three close paths: `transport.onclose`, `res.on('close')`, `res.on('error')`. Write guarded by `!res.writableEnded && !res.destroyed`.

SSE comment format: `: ping\n\n` — valid SSE per RFC, ignored by compliant clients.

**Alternative considered:** Global heartbeat map. Rejected — per-connection local var is simpler and has no coordination risk.

## Risks / Trade-offs

- **[Risk] Config migration is one-way** → No rollback. If user intentionally had `host.docker.internal:6333` for an atypical setup, migration overwrites it. Mitigation: print notice with old and new value so user can revert manually.
- **[Risk] Bug 2+4 is large atomic change (12 import sites, ~20 call sites)** → A missed call site causes a compile error caught by `tsc`, not a runtime failure. Mitigation: run `npx tsc --noEmit` after each file, not only at the end.
- **[Risk] `init.ts` container guard** → `isRunningInContainer()` on line 24 blocks `--force --all` (destructive op that deletes all databases). Must be replaced with `isInsideContainer()` with identical `if (inContainer) return` semantics. Mitigation: explicit before/after behavior check in implementation task.

## Migration Plan

1. `docker start` command: read config, check for legacy URL, rewrite if found, log notice, then proceed with container startup as normal.
2. No server restart required for other fixes — all changes are in CLI code or HTTP handler code loaded at request time.
3. Rollback: `git revert` on the docker.ts change; restore old config URL manually if needed.

## Open Questions

None — all design questions resolved by cross-critique phase.
