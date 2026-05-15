## 1. Setup: types and shared utilities

- [ ] 1.1 Create `src/harvesters/types.ts` — define `SessionSourceAdapter` interface, `AdapterResult`, `HarvestStats`
- [ ] 1.2 Create `src/harvesters/shared.ts` — move `sessionToMarkdown`, `messagesToMarkdown`, `loadHarvestState`, `saveHarvestState`, `getOutputPath` (with project-subfolder change), `computeFactHash` from `src/harvester.ts`
- [ ] 1.3 Update `getOutputPath()` in `shared.ts` to use project name (last path segment, sanitized) as subdirectory instead of projectHash. Add collision detection (append 6-char hash if two paths share same name).
- [ ] 1.4 Update `src/harvester.ts` to re-export from `src/harvesters/shared.ts` — all existing named exports must remain available for backward compatibility

## 2. OpenCodeAdapter

- [ ] 2.1 Create `src/harvesters/opencode.ts` — implement `OpenCodeAdapter` wrapping existing `harvestFromDb`, `parseSession`, `parseMessages`, `parseParts` logic moved from `src/harvester.ts`
- [ ] 2.2 `OpenCodeAdapter.isAvailable()` checks `~/.local/share/opencode/storage/` or configured dir exists
- [ ] 2.3 `OpenCodeAdapter.readNewSessions()` returns `AdapterResult` — same harvest logic, different return shape
- [ ] 2.4 Keep `harvestSessions()` function in `src/harvester.ts` as a compatibility shim calling the orchestrator with only `OpenCodeAdapter`

## 3. ClaudeCodeAdapter

- [ ] 3.1 Create `src/harvesters/claude-code.ts` — implement `ClaudeCodeAdapter`
- [ ] 3.2 `isAvailable()` — check `~/.claude/projects/` (or configured dir) exists
- [ ] 3.3 Session discovery — enumerate project dirs, read `sessions-index.json`, extract `sessionId`, `modified`, `projectPath`, `firstPrompt`
- [ ] 3.4 State tracking — keyed by `sessionId`, value `{ mtime: modified_timestamp, messageCount }`, skip sessions where mtime unchanged
- [ ] 3.5 JSONL parser — extract `ai-title`, `user` messages, `assistant` messages; skip `attachment`, `permission-mode`, `system/*`
- [ ] 3.6 Content array handling — concatenate `{type:"text"}` items; skip `tool_use`, `tool_result` blocks
- [ ] 3.7 Fallback when `sessions-index.json` missing — scan `*.jsonl` files directly, use file mtime for state
- [ ] 3.8 Map JSONL session to `HarvestedSession` with `agent: 'claude-code'`

## 4. Orchestrator

- [ ] 4.1 Create `src/harvesters/index.ts` — implement `runHarvestCycle(adapters, outputDir, options)`
- [ ] 4.2 Per-adapter state file: `{outputDir}/.harvest-state-{adapter.name}.json`
- [ ] 4.3 Loop: for each adapter, call `readNewSessions`, write markdown files, run LLM extraction, save state
- [ ] 4.4 Per-adapter error isolation — catch errors per adapter, log warn, continue to next adapter
- [ ] 4.5 Aggregate and return all `HarvestedSession[]` from all adapters
- [ ] 4.6 Export `runHarvestCycle` from `src/harvesters/index.ts`

## 5. Config schema

- [ ] 5.1 Add `HarvesterSourceSchema` and `HarvesterConfigSchema` to `src/types.ts` (or config Zod file)
- [ ] 5.2 Wire `harvesterConfig` into the top-level config schema
- [ ] 5.3 Add `harvester:` block to `config.default.yml` with `opencode.enabled: true`, `claudeCode.enabled: false`
- [ ] 5.4 Update config loading in `src/server/bootstrap.ts` to pass `harvesterConfig` to watcher options

## 6. watcher.ts integration

- [ ] 6.1 Update `src/jobs/watcher.ts` to accept `harvesterConfig` in options
- [ ] 6.2 Construct `adapters[]` from config (OpenCodeAdapter always, ClaudeCodeAdapter if `claudeCode.enabled`)
- [ ] 6.3 Replace `harvestSessions({ sessionDir, outputDir })` call with `runHarvestCycle(adapters, outputDir, { extractionConfig, store })`
- [ ] 6.4 Preserve existing `sessionStorageDir` env var override as default for OpenCode adapter

## 7. Tests

- [ ] 7.1 Create `test/fixtures/claude-sessions/` with sample project dir and JSONL fixtures covering: normal session, session with tool_use blocks, session with content array, session without ai-title, empty session
- [ ] 7.2 Create `test/claude-harvester.test.ts` — unit tests for `ClaudeCodeAdapter`: isAvailable, session discovery, JSONL parsing, content array handling, tool_use skipping, state tracking, project path reconstruction, missing sessions-index fallback
- [ ] 7.3 Create `test/harvester-adapter.test.ts` — orchestrator tests: both adapters called, separate state files, error isolation (one adapter throws, other succeeds), output files in project subfolders
- [ ] 7.4 Run `test/harvester.test.ts` (existing) — verify all pass via re-export shim
- [ ] 7.5 Verify `getOutputPath` project-subfolder behavior in existing tests — update expected paths if needed

## 8. Release

- [ ] 8.1 Create GitHub issue on nano-step/nano-brain for session-pipeline-v2
- [ ] 8.2 Create branch `feat/session-pipeline-v2`
- [ ] 8.3 Commit in logical units: types+shared → opencode adapter → claude-code adapter → orchestrator → config → watcher → tests
- [ ] 8.4 Run full test suite, verify 0 failures
- [ ] 8.5 Publish `nano-brain@2026.8.17-beta.1`, test Claude Code harvest in container with `claudeCode.enabled: true`
- [ ] 8.6 Create PR, merge, bump version to `2026.8.17`
