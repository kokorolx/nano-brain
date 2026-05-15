## Why

nano-brain currently harvests only OpenCode sessions (SQLite DB at `~/.local/share/opencode/storage`). Claude Code — the other primary agent tool in use — stores sessions as JSONL files at `~/.claude/projects/{slug}/*.jsonl` and is not harvested at all. This means a large body of work context (Claude Code is used for nano-brain itself, zengamingx, and other projects) is invisible to memory search.

Additionally, the session harvesting code has no extension point: adding support for a third tool (Cursor, Codex, Gemini CLI) would require duplicating the entire harvest + LLM extraction pipeline. The harvesting logic in `src/harvester.ts` is 860 lines with OpenCode-specific parsing tightly coupled to the shared utilities (`sessionToMarkdown`, `getOutputPath`, state tracking, LLM extraction).

Finally, the flat output structure (`~/.nano-brain/sessions/{hash}/{date}-{slug}.md`) is not human-navigable. The user wants to open `~/.nano-brain/sessions/` directly as an Obsidian vault for reviewing and annotating session history. Project-based subfolders enable this without any additional tooling.

## What Changes

- **Adapter pattern for session sources**: Introduce `SessionSourceAdapter` interface in `src/harvesters/types.ts`. Each tool implements one adapter. The orchestrator loops over enabled adapters — no orchestrator changes needed when adding new tools.
- **`src/harvesters/` module**: Shared utilities (`sessionToMarkdown`, `getOutputPath`, state tracking, LLM extraction pipeline) extracted to `src/harvesters/shared.ts`. `OpenCodeAdapter` in `src/harvesters/opencode.ts`. `ClaudeCodeAdapter` in `src/harvesters/claude-code.ts`. Orchestrator in `src/harvesters/index.ts`.
- **Backward compatibility**: `src/harvester.ts` re-exports everything from `src/harvesters/shared.ts` so existing callers (`watcher.ts`, tests) are not broken.
- **Claude Code JSONL parser**: Reads `sessions-index.json` for metadata, parses `{type:"user"/"assistant"}` messages and `{type:"ai-title"}` entries from JSONL. Produces `HarvestedSession[]` identical in shape to OpenCode output.
- **Project-based output structure**: `getOutputPath()` now writes to `{outputDir}/{project-name}/{date}-{slug}.md` instead of `{outputDir}/{hash}/{date}-{slug}.md`. Project name is the last path segment of the workspace path.
- **Config schema**: New `harvester` block in config Zod schema and `config.default.yml` with per-source `enabled` flags and optional `sessionDir` overrides.
- **`watcher.ts` session poll**: Updated to call `runHarvestCycle(adapters, outputDir)` instead of `harvestSessions()` directly.

## Capabilities

### New Capabilities
- `harvester.claude-code`: Harvest Claude Code JSONL sessions into `~/.nano-brain/sessions/` with full conversation markdown and optional LLM fact extraction. Gated by `harvester.claudeCode.enabled`.
- `harvester.adapter-pattern`: `SessionSourceAdapter` interface enabling third-party tool harvesters (Cursor, Codex, Gemini CLI) by adding a new adapter file + config flag, with zero changes to the orchestrator or shared pipeline.

### Modified Capabilities
- `harvester.opencode`: Wrapped as `OpenCodeAdapter` implementing `SessionSourceAdapter`. Behaviour identical to current.
- `harvester.output-structure`: Session files now written to `{outputDir}/{project-name}/` subfolders. `~/.nano-brain/sessions/` becomes directly usable as an Obsidian vault.

## Impact

- **Files added**: `src/harvesters/types.ts`, `src/harvesters/shared.ts`, `src/harvesters/opencode.ts`, `src/harvesters/claude-code.ts`, `src/harvesters/index.ts`
- **Files modified**: `src/harvester.ts` (re-export shim), `src/jobs/watcher.ts` (call orchestrator), `src/types.ts` (harvester config types), `config.default.yml` (harvester block), Zod config schema
- **Output path change**: New sessions write to `sessions/{project-name}/`. Existing sessions in `sessions/{hash}/` remain untouched (no migration).
- **No database schema changes**.
- **No MCP tool changes**.
- **Risk**: Medium — the output path change is additive (old files stay). OpenCode adapter behaviour is identical to current harvester. Claude Code parsing is new but gated by `enabled: false` default.
