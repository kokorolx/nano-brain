## 1. Foundation modules

- [ ] 1.1 Create `src/cli/types.ts` — export `GlobalOptions` interface (extracted from `src/index.ts`)
- [ ] 1.2 Create `src/cli/utils.ts` — export `DEFAULT_HTTP_PORT`, `detectRunningServer`, `detectRunningServerContainer`, `proxyGet`, `proxyPost`, `proxyGetContainer`, `proxyPostContainer`, `isRunningInContainer`, `getHttpHost`, `getHttpPort`

## 2. Trivial command handlers (< 50 lines each)

- [ ] 2.1 Create `src/cli/commands/harvest.ts` — extract `handleHarvest`
- [ ] 2.2 Create `src/cli/commands/tags.ts` — extract `handleTags`
- [ ] 2.3 Create `src/cli/commands/update.ts` — extract `handleUpdate`
- [ ] 2.4 Create `src/cli/commands/get.ts` — extract `handleGet`
- [ ] 2.5 Create `src/cli/commands/graph-stats.ts` — extract `handleGraphStats`
- [ ] 2.6 Create `src/cli/commands/wake-up.ts` — extract `handleWakeUp`
- [ ] 2.7 Create `src/cli/commands/focus.ts` — extract `handleFocus`
- [ ] 2.8 Create `src/cli/commands/consolidate.ts` — extract `handleConsolidate`
- [ ] 2.9 Create `src/cli/commands/learning.ts` — extract `handleLearning`
- [ ] 2.10 Create `src/cli/commands/mcp.ts` — extract `handleMcp`

## 3. Medium command handlers (50–200 lines each)

- [ ] 3.1 Create `src/cli/commands/embed.ts` — extract `handleEmbed`
- [ ] 3.2 Create `src/cli/commands/search.ts` — extract `handleSearch`
- [ ] 3.3 Create `src/cli/commands/write.ts` — extract `handleWrite`
- [ ] 3.4 Create `src/cli/commands/symbols.ts` — extract `handleSymbols`
- [ ] 3.5 Create `src/cli/commands/impact.ts` — extract `handleImpact`
- [ ] 3.6 Create `src/cli/commands/context.ts` — extract `handleContext`
- [ ] 3.7 Create `src/cli/commands/code-impact.ts` — extract `handleCodeImpact`
- [ ] 3.8 Create `src/cli/commands/detect-changes.ts` — extract `handleDetectChanges`
- [ ] 3.9 Create `src/cli/commands/reindex.ts` — extract `handleReindex`
- [ ] 3.10 Create `src/cli/commands/cache.ts` — extract `handleCache`
- [ ] 3.11 Create `src/cli/commands/logs.ts` — extract `handleLogs`

## 4. Large command handlers (200+ lines each)

- [ ] 4.1 Create `src/cli/commands/status.ts` — extract `handleStatus`
- [ ] 4.2 Create `src/cli/commands/collection.ts` — extract `handleCollection`
- [ ] 4.3 Create `src/cli/commands/init.ts` — extract `handleInit`
- [ ] 4.4 Create `src/cli/commands/reset.ts` — extract `handleReset`
- [ ] 4.5 Create `src/cli/commands/rm.ts` — extract `handleRm`
- [ ] 4.6 Create `src/cli/commands/categorize-backfill.ts` — extract `handleCategorizeBackfill`
- [ ] 4.7 Create `src/cli/commands/docker.ts` — extract `handleDocker`
- [ ] 4.8 Create `src/cli/commands/qdrant.ts` — extract `handleQdrant` (810 lines — copy as-is, no internal refactor)

## 5. CLI index and barrel shim

- [ ] 5.1 Create `src/cli/index.ts` — import all 29 handlers from `commands/`, contain the `main()` dispatch switch and `process.argv` bootstrap
- [ ] 5.2 Replace `src/index.ts` content with 3-line barrel shim: `export * from './cli/index.js'; export { main } from './cli/index.js';`

## 6. Verification

- [ ] 6.1 Run `npx tsc --noEmit` — verify zero type errors
- [ ] 6.2 Run full test suite — verify 1,518+ tests pass (watcher.test.ts failures are pre-existing, acceptable)
- [ ] 6.3 Run `lsp_diagnostics` on `src/cli/index.ts` and `src/index.ts` — verify clean
- [ ] 6.4 Manually verify `npx nano-brain status` executes without error (smoke test)

## 7. Commit

- [ ] 7.1 Stage all new `src/cli/` files and modified `src/index.ts`
- [ ] 7.2 Create atomic commit: `refactor: split index.ts into src/cli/commands/ modules`
