## 1. Specification

- [ ] 1.1 Add requirement for safe `serve stop` PID validation
- [ ] 1.2 Add scenarios for Docker/helper PID protection and `--force` override

## 2. Implementation

- [ ] 2.1 Add PID command-line lookup helper in `src/index.ts`
- [ ] 2.2 Add PID safety classifier (deny Docker/helper processes by default)
- [ ] 2.3 Update `serve stop` fallback to validate and stop only safe PIDs
- [ ] 2.4 Add user-facing diagnostics for skipped unsafe PIDs and no-safe-target case

## 3. Validation

- [ ] 3.1 Validate OpenSpec change: `openspec validate safe-serve-stop-pid-validation --strict --no-interactive`
- [ ] 3.2 Run typecheck or tests covering `serve stop` behavior