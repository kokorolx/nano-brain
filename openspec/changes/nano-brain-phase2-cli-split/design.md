## Context

`src/index.ts` (3,988 lines) is the CLI entry point. It contains:
- 29 `async function handle*()` command handlers (lines 361–3988)
- Shared utilities: `detectRunningServer`, `proxyGet`, `proxyPost`, container detection, port/host resolution (lines 1–360)
- Global option types (`GlobalOptions`) defined inline
- The `main()` dispatch switch at the bottom (lines ~3900–3988)

Phase 1 split `store.ts` using a barrel shim pattern. Phase 2 applies the same pattern to the CLI layer.

Handler size distribution:
- Small (< 100 lines): `handleHarvest` (11), `handleTags` (17), `handleUpdate` (39), `handleLogs` (90)
- Medium (100–300 lines): `handleMcp` (41), `handleCollection` (177), `handleInit` (288), `handleEmbed` (102), `handleSearch` (142), `handleGet` (46), `handleWrite` (97), `handleWakeUp` (63), `handleFocus` (54), `handleGraphStats` (40), `handleSymbols` (67), `handleImpact` (80), `handleContext` (96), `handleCodeImpact` (90), `handleDetectChanges` (66), `handleReindex` (64), `handleCache` (70), `handleReset` (145), `handleLearning` (38), `handleDocker` (293)
- Large (300+ lines): `handleStatus` (233), `handleRm` (217), `handleCategorizeBackfill` (109), `handleConsolidate` (42), `handleQdrant` (810)

## Goals / Non-Goals

**Goals:**
- One file per command handler under `src/cli/commands/<command>.ts`
- Shared utilities extracted to `src/cli/utils.ts`
- `GlobalOptions` type and shared type aliases in `src/cli/types.ts`
- `main()` dispatch loop in `src/cli/index.ts`
- `src/index.ts` reduced to a 3-line barrel shim (same pattern as Phase 1 `src/store.ts`)
- Zero behavior changes — pure structural refactor
- All existing tests continue to pass

**Non-Goals:**
- Refactoring the logic inside any handler
- Splitting `handleQdrant` into sub-handlers (too risky, out of scope)
- Changing the CLI public interface (commands, flags, output format)
- Adding new tests

## Decisions

### D1: Barrel shim pattern (consistent with Phase 1)

`src/index.ts` becomes:
```typescript
export * from './cli/index.js';
export { main } from './cli/index.js';
```
Then the CLI binary (`package.json` `"bin"`) continues to point to the compiled `dist/index.js`. No `package.json` changes needed.

**Alternative considered:** Delete `src/index.ts` and update `package.json` `bin` to point to `dist/cli/index.js`. Rejected — unnecessarily risky, breaks any external consumers that `import from 'nano-brain'`.

### D2: One file per handler, flat naming

`src/cli/commands/init.ts` exports `handleInit`. No subdirectory grouping.

**Alternative considered:** Group by domain (e.g., `src/cli/commands/graph/symbols.ts`). Rejected — adds indirection with no benefit at this scale, inconsistent with the existing flat structure.

### D3: Shared utilities in `src/cli/utils.ts`

Utilities shared across multiple handlers:
- `detectRunningServer()`, `detectRunningServerContainer()`
- `proxyGet()`, `proxyPost()`, `proxyGetContainer()`, `proxyPostContainer()`
- `isRunningInContainer()`, `getHttpHost()`, `getHttpPort()`
- `DEFAULT_HTTP_PORT` constant

**Alternative considered:** Inline these in each handler that uses them. Rejected — would duplicate code across ~15 files.

### D4: `GlobalOptions` type in `src/cli/types.ts`

The `GlobalOptions` interface (workspace, collection, label, verbose, port, etc.) is used by every handler. Extract to a dedicated types file.

### D5: Extraction order — bottom-up, largest-risk last

Extract handlers in order of increasing complexity to de-risk:
1. Trivial handlers (< 50 lines)
2. Medium handlers
3. `handleQdrant` (810 lines, most complex) — extracted last

## Risks / Trade-offs

- **ESM import cycles**: Each command file imports from `store.js`, `search.js`, etc. As long as no command file imports from `src/cli/index.ts`, there are no cycles. → Mitigation: `src/cli/index.ts` is import-only (main loop), never imported by command files.
- **`handleQdrant` size**: 810 lines with complex sub-commands. Copy-paste extraction only — no internal refactor. → Mitigation: Extract as-is, verify with `lsp_diagnostics` after.
- **Shared mutable state**: Some handlers reference `process.env` directly. No shared module-level mutable state exists in `index.ts` that would cause issues when split. → Mitigation: Pre-verified — no module-level mutable state beyond `DEFAULT_HTTP_PORT`.

## Migration Plan

1. Create `src/cli/types.ts` with `GlobalOptions`
2. Create `src/cli/utils.ts` with shared utilities
3. Create `src/cli/commands/<cmd>.ts` for each of the 29 handlers
4. Create `src/cli/index.ts` with `main()` dispatch loop importing from all command files
5. Replace `src/index.ts` content with 3-line barrel shim
6. `tsc --noEmit` (or `npx tsc`) to verify no type errors
7. Run test suite — verify 1,518+ tests pass
8. Commit

Rollback: `git revert` the single commit. Barrel shim means no other files were changed.

## Open Questions

None — this is a pure structural extraction with a proven pattern (Phase 1).
