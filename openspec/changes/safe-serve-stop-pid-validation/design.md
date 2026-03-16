## Design

### Problem

`serve stop` currently falls back to port-based PID lookup and may kill unrelated processes when lookup returns multiple PIDs.

### Decisions

1. **PID-file first (unchanged)**
   Use `~/.nano-brain/serve.pid` as primary stop path.

2. **Strict PID validation before SIGTERM**
   Before killing, inspect process command and reject suspicious targets by default:
   - reject commands containing: `docker`, `docker-proxy`, `com.docker`, `vpnkit`, `containerd`
   - require numeric PID

3. **Safe port fallback**
   For port fallback, parse all candidate PIDs, validate each, and stop only validated candidates.
   If none are safe, print guidance and do not kill.

4. **Force override**
   `serve stop --force` bypasses command-name safety filter for manual recovery.

### Implementation Notes

- File: `src/index.ts` (`handleServe` stop branch)
- Add helper functions:
  - process command lookup by PID
  - safe/unsafe PID classification
- Improve output:
  - report skipped unsafe PIDs
  - report explicitly when no safe nano-brain PID found