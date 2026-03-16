## Why

`npx nano-brain serve stop` can terminate unrelated host processes when fallback stop-by-port logic returns multiple PIDs (for example Docker networking/proxy helpers bound to the same port). This can unintentionally disrupt running containers.

## What Changes

- Make `serve stop` PID-safe:
  - Prefer PID file stop path
  - Validate PID ownership before sending SIGTERM
  - Refuse to kill Docker-related/helper processes unless explicitly forced
- Replace broad port PID parsing with strict single-PID handling
- Add clear diagnostics when stop is skipped for safety
- Add optional `--force` override for advanced/manual recovery

## Capabilities

### New Capabilities

- `serve-safe-stop`: Safe server stop with PID ownership validation and Docker-process protection

### Modified Capabilities

- `container-runtime`: No change
- `cli`: `serve stop` behavior hardened against unrelated PID termination

## Impact

- **Primary file**: `src/index.ts` (`handleServe` stop branch)
- **Behavioral change**: safer default stop semantics
- **Risk**: low; only affects stop command fallback behavior