## Why

When `nano-brain docker start` is run and the CLI is called immediately from inside the agent container, the server is still running its DB integrity check (up to 8 minutes on large databases). The HTTP port is not yet open, so the CLI sees the same error as when the server has never been started:

```
Error: nano-brain server not reachable at host.docker.internal:3100. Ensure the Docker container is running:
  docker start nano-brain
```

This is misleading. The container IS running; the server is just initializing. The user (or agent) gets no useful guidance.

Discovered and confirmed during real container testing (PR #9).

## What Changes

**Server side:** Bind the HTTP port at the very start of `startServer()` — before `createStore()`. During the bootstrap phase the `/health` endpoint returns `{"status":"starting","ready":false}`. All other endpoints return 503. After bootstrap completes, the full request handler takes over.

**CLI side:** 
1. `detectRunningServer()` is updated to return `true` only when the server is fully ready (`ready: true`). Previously it returned `true` for any 200 response, including the starting state.
2. New `assertContainerServer(port?)` helper centralizes the container guard across all 8 commands. It distinguishes "starting" from "down" and shows the appropriate message.
3. All 8 CLI commands that duplicate the container guard boilerplate are simplified to a single `await assertContainerServer()` call.

## Non-Goals

- Does not wait/poll for the server to finish starting (user must retry manually)
- Does not change `ready: false` responses for Qdrant/embedding checks — only the startup window
- Does not change non-container behaviour
