# Design: Session Pipeline v2

## Architecture

```
~/.claude/projects/{slug}/*.jsonl  ──► ClaudeCodeAdapter
                                             │
~/.local/share/opencode/storage/   ──► OpenCodeAdapter
                                             │
                                   runHarvestCycle(adapters[])
                                             │
                                    ┌────────┴────────┐
                              readNewSessions()    shared pipeline:
                              (per adapter)        - write markdown
                                                   - LLM extraction
                                                   - state save
                                                        │
                                           {outputDir}/{project-name}/
                                           {date}-{slug}.md
                                           (~/.nano-brain/sessions/ ← Obsidian vault)
```

Future tools (Cursor, Codex, Gemini CLI) add one file + one config flag. Orchestrator unchanged.

---

## File Structure

```
src/
  harvesters/
    types.ts        ← SessionSourceAdapter interface, HarvestState, shared types
    shared.ts       ← sessionToMarkdown, getOutputPath, loadHarvestState,
                      saveHarvestState, extractFacts pipeline (moved from harvester.ts)
    opencode.ts     ← OpenCodeAdapter (wraps existing harvester.ts DB/JSON logic)
    claude-code.ts  ← ClaudeCodeAdapter (new JSONL parser)
    index.ts        ← runHarvestCycle(adapters, outputDir, options)
  harvester.ts      ← re-export shim: `export * from './harvesters/shared.js'`
                      `export { harvestSessions } from './harvesters/index.js'`
```

---

## Interface: SessionSourceAdapter

```typescript
// src/harvesters/types.ts

export interface SessionSourceAdapter {
  readonly name: string          // 'opencode' | 'claude-code' | 'cursor' | ...
  isAvailable(): boolean         // source dir exists and is readable
  readNewSessions(
    state: HarvestState,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult>
}

export interface AdapterResult {
  sessions: HarvestedSession[]
  stateChanged: boolean
  stats: HarvestStats
}

export interface HarvestStats {
  processed: number
  skipped: number
  incremental: number
  errors: number
  extractionStats?: ExtractionStats
}
```

---

## Orchestrator: runHarvestCycle

```typescript
// src/harvesters/index.ts

export async function runHarvestCycle(
  adapters: SessionSourceAdapter[],
  outputDir: string,
  options?: { extractionConfig?: ExtractionConfig; store?: Store }
): Promise<HarvestedSession[]>
```

For each enabled adapter that `isAvailable()`:
1. Load per-adapter state file: `{outputDir}/.harvest-state-{adapter.name}.json`
2. Call `adapter.readNewSessions(state, outputDir, ...)`
3. Write markdown files via `getOutputPath()` (project-subfolder structure)
4. Run LLM extraction if `extractionConfig.enabled`
5. Save state if changed
6. Aggregate all harvested sessions and return

State files are per-adapter to avoid cross-contamination when one adapter fails.

---

## Output Path: Project Subfolder

```typescript
// src/harvesters/shared.ts

export function getOutputPath(
  outputDir: string,
  projectPath: string,
  date: string,
  slug: string,
  title?: string
): string
```

**Change**: subdirectory is now `projectName` (last segment of `projectPath`) instead of `projectHash`.

```
Before: ~/.nano-brain/sessions/d1915ee19311/2026-05-15-fix-proxy.md
After:  ~/.nano-brain/sessions/nano-brain/2026-05-15-fix-proxy.md
        ~/.nano-brain/sessions/zengamingx/2026-05-15-fix-auth.md
```

Project name sanitization: lowercase, alphanumeric + hyphens, max 40 chars. Collision fallback: if two different `projectPath` values share the same name, append first 6 chars of hash (e.g., `zengamingx-d1915e`).

Existing sessions in `{hash}/` subdirs remain — they are still indexed by the `sessions` collection via `pattern: "**/*.md"`.

---

## ClaudeCodeAdapter

```typescript
// src/harvesters/claude-code.ts

export class ClaudeCodeAdapter implements SessionSourceAdapter {
  readonly name = 'claude-code'
  constructor(private sessionDir: string) {}
  isAvailable(): boolean  // check ~/.claude/projects/ exists
  readNewSessions(...): Promise<AdapterResult>
}
```

**Session discovery**:
1. Enumerate `{sessionDir}/` — each subdirectory is a project slug (workspace path with `/` → `-`)
2. For each project dir, read `sessions-index.json` to get metadata: `sessionId`, `created`, `modified`, `projectPath`, `gitBranch`, `firstPrompt`, `messageCount`
3. Filter: skip sessions already in state with same `modified` mtime

**State tracking**: keyed by `sessionId`, value `{ mtime: modified_timestamp, messageCount }` — same shape as OpenCode state.

**JSONL parsing** per session file:
```
{type:"ai-title",    aiTitle: string}            → session.title
{type:"user",        message:{role,content}}      → user message
{type:"assistant",   message:{role,content}}      → assistant message
{type:"attachment",  ...}                         → skip
{type:"permission-mode", ...}                     → skip
{type:"system/*",    ...}                         → skip
```

`message.content` can be:
- `string` → use directly
- `Array<{type:"text", text:string} | {type:"tool_use",...} | {type:"tool_result",...}>` → concatenate `type:"text"` items; skip tool_use/tool_result blocks (they are internal scaffolding, not human-readable conversation)

**Project path reconstruction**: project slug in dir name (`-Users-tamlh-workspaces-...`) is decoded to absolute path by replacing leading `-` separator pattern. `sessions-index.json` entries have `projectPath` field directly — use that.

**Output**: `HarvestedSession` with `agent: 'claude-code'`. Identical shape to OpenCode output, feeds into same `sessionToMarkdown()` and LLM extraction pipeline.

---

## OpenCodeAdapter

```typescript
// src/harvesters/opencode.ts

export class OpenCodeAdapter implements SessionSourceAdapter {
  readonly name = 'opencode'
  constructor(private sessionDir: string) {}
  isAvailable(): boolean
  readNewSessions(...): Promise<AdapterResult>
}
```

Wraps existing logic from `harvester.ts` (`harvestFromDb`, `parseSession`, `parseMessages`, `parseParts`). No behavioural change. These functions move to `src/harvesters/opencode.ts`; `src/harvester.ts` re-exports them for backward compatibility.

---

## Config Schema

```yaml
# config.default.yml addition
harvester:
  opencode:
    enabled: true
    sessionDir: ""           # default: ~/.local/share/opencode/storage
  claudeCode:
    enabled: false           # opt-in
    sessionDir: ""           # default: ~/.claude/projects
```

Zod schema (in `src/types.ts` or `src/config.ts`):

```typescript
const HarvesterSourceSchema = z.object({
  enabled: z.boolean().default(false),
  sessionDir: z.string().optional(),
})

const HarvesterConfigSchema = z.object({
  opencode: HarvesterSourceSchema.extend({ enabled: z.boolean().default(true) }),
  claudeCode: HarvesterSourceSchema,
}).optional()
```

`watcher.ts` constructs adapters from config:

```typescript
const adapters: SessionSourceAdapter[] = []
if (harvesterConfig?.opencode?.enabled !== false) {
  adapters.push(new OpenCodeAdapter(
    harvesterConfig?.opencode?.sessionDir || defaultOpenCodeDir
  ))
}
if (harvesterConfig?.claudeCode?.enabled) {
  adapters.push(new ClaudeCodeAdapter(
    harvesterConfig?.claudeCode?.sessionDir || defaultClaudeCodeDir
  ))
}
```

---

## Error Handling

- Per-adapter errors do not stop other adapters. Catch at adapter level, log warning, continue.
- Per-session JSONL parse errors: log and skip session, do not abort the adapter.
- Missing `sessions-index.json`: fall back to scanning JSONL files directly using file mtime for state tracking.
- Tool_use/tool_result content blocks in Claude Code messages: silently skip (not an error).
- Compact boundary entries (`{type:"system/compact_boundary"}`): treat as session segmentation hint — optionally split into multiple `HarvestedSession` objects if the session file contains multiple compacted segments (detected by `compact_boundary` entries). Initial implementation: ignore boundaries, harvest as single session.

---

## Testing

- `test/claude-harvester.test.ts`: unit tests with fixture JSONL files covering message parsing, ai-title extraction, content array handling, tool_use skipping, state tracking, project path reconstruction.
- `test/harvester-adapter.test.ts`: integration test — orchestrator with two mock adapters, verify both are called, state files are separate, errors in one adapter don't stop the other.
- `test/harvester.test.ts`: existing tests must continue to pass (via re-export shim).
- Fixtures: `test/fixtures/claude-sessions/` with sample JSONL files (minimal, covering all message type combinations).
