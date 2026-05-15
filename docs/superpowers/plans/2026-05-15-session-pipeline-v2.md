# Session Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code JSONL session harvesting alongside OpenCode, using a `SessionSourceAdapter` interface that makes adding future tools (Cursor, Codex, Gemini CLI) a one-file change.

**Architecture:** Extract shared utilities from `src/harvester.ts` into `src/harvesters/shared.ts`. Wrap the existing OpenCode logic as `OpenCodeAdapter`. Implement `ClaudeCodeAdapter` that reads `~/.claude/projects/{slug}/*.jsonl`. An orchestrator in `src/harvesters/index.ts` loops over enabled adapters, runs each through the shared markdown-write + LLM-extraction pipeline. Output path changes from `{hash}/` to `{project-name}/` subdirs for Obsidian readability.

**Tech Stack:** TypeScript ESM, Node.js `fs` (sync), `better-sqlite3`, vitest, YAML config (no Zod — config is plain interface in `src/types.ts`)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/harvesters/types.ts` | Create | `SessionSourceAdapter` interface, `AdapterResult`, `HarvestStats` |
| `src/harvesters/shared.ts` | Create | Move `sessionToMarkdown`, `messagesToMarkdown`, `getOutputPath`, `loadHarvestState`, `saveHarvestState` from `src/harvester.ts`; update `getOutputPath` to use project-name subdir |
| `src/harvesters/opencode.ts` | Create | `OpenCodeAdapter` wrapping `harvestFromDb` + JSON-file logic from `src/harvester.ts` |
| `src/harvesters/claude-code.ts` | Create | `ClaudeCodeAdapter` reading `~/.claude/projects/` JSONL |
| `src/harvesters/index.ts` | Create | `runHarvestCycle(adapters, outputDir, opts)` orchestrator |
| `src/harvester.ts` | Modify | Re-export shim only — all logic moved to `src/harvesters/` |
| `src/types.ts` | Modify | Add `HarvesterConfig` interface to `CollectionConfig` |
| `config.default.yml` | Modify | Add `harvester:` block |
| `src/jobs/watcher.ts` | Modify | Accept `harvesterConfig`, build adapters, call `runHarvestCycle` |
| `test/fixtures/claude-sessions/` | Create | Sample JSONL fixtures |
| `test/claude-harvester.test.ts` | Create | Unit tests for `ClaudeCodeAdapter` |
| `test/harvester-adapter.test.ts` | Create | Orchestrator integration tests |
| `test/harvester.test.ts` | No change | Must still pass via re-export shim |

---

## Task 1: Shared types

**Files:**
- Create: `src/harvesters/types.ts`

- [ ] **Step 1.1: Create `src/harvesters/types.ts`**

```typescript
// src/harvesters/types.ts
import type { HarvestedSession, ExtractionConfig, Store } from '../types.js';

export type { HarvestState, HarvestStateEntry } from '../harvester.js';

export interface HarvestStats {
  processed: number;
  skipped: number;
  incremental: number;
  errors: number;
  extractionStats?: {
    factsExtracted: number;
    duplicatesSkipped: number;
    errors: number;
    limitReached?: boolean;
  };
}

export interface AdapterResult {
  sessions: HarvestedSession[];
  stateChanged: boolean;
  stats: HarvestStats;
}

export interface SessionSourceAdapter {
  readonly name: string;
  isAvailable(): boolean;
  readNewSessions(
    state: Record<string, { mtime: number; retries?: number; skipped?: boolean; messageCount?: number }>,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult>;
}
```

- [ ] **Step 1.2: Verify TypeScript compiles**

```bash
cd /Users/tamlh/workspaces/self/AI/Tools/nano-brain
npx tsc --noEmitOnError false 2>&1 | grep "harvesters/types" | head -5
```
Expected: no errors for the new file.

- [ ] **Step 1.3: Commit**

```bash
git add src/harvesters/types.ts
git commit -m "feat(harvesters): add SessionSourceAdapter interface and types"
```

---

## Task 2: Shared utilities

**Files:**
- Create: `src/harvesters/shared.ts`
- Modify: `src/harvester.ts` (add re-exports; keep all existing functions intact for now)

- [ ] **Step 2.1: Create `src/harvesters/shared.ts`** — copy `sessionToMarkdown`, `messagesToMarkdown`, `loadHarvestState`, `saveHarvestState` verbatim from `src/harvester.ts`, then write updated `getOutputPath`:

```typescript
// src/harvesters/shared.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HarvestedSession } from '../types.js';

export type HarvestStateEntry = {
  mtime: number;
  retries?: number;
  skipped?: boolean;
  messageCount?: number;
};
export type HarvestState = Record<string, HarvestStateEntry>;

export function sessionToMarkdown(session: HarvestedSession): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`session: ${session.sessionId}`);
  lines.push(`agent: ${session.agent}`);
  lines.push(`date: "${session.date}"`);
  lines.push(`title: "${session.title}"`);
  lines.push(`project: ${session.project}`);
  lines.push(`projectHash: ${session.projectHash}`);
  lines.push('---');
  lines.push('');
  for (const message of session.messages) {
    if (message.role === 'user') {
      lines.push('## User');
    } else {
      lines.push(`## Assistant (${message.agent || 'assistant'})`);
    }
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  return lines.join('\n');
}

export function messagesToMarkdown(messages: Array<{ role: string; agent?: string; text: string }>): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## User');
    } else {
      lines.push(`## Assistant (${message.agent || 'assistant'})`);
    }
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  return lines.join('\n');
}

export function loadHarvestState(stateFile: string): HarvestState {
  try {
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, 'utf-8');
      return JSON.parse(content) as HarvestState;
    }
  } catch {
    // corrupt state file — start fresh
  }
  return {};
}

export function saveHarvestState(stateFile: string, state: HarvestState): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

/**
 * Returns output path for a session markdown file.
 * New structure: {outputDir}/{projectName}/{date}-{slug}.md
 * projectName = last segment of projectPath, sanitized, with hash suffix on collision.
 */
export function getOutputPath(
  outputDir: string,
  projectPath: string,
  date: string,
  slug: string,
  title?: string,
  knownNames?: Map<string, string>,   // projectPath → sanitized name, for collision detection
): string {
  const hash = createHash('sha256').update(projectPath).digest('hex');
  const projectHash = hash.substring(0, 12);

  // Derive project name from last path segment
  const rawName = projectPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'unknown';
  let sanitizedName = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);

  // Collision: if a different projectPath already claimed this name, append hash suffix
  if (knownNames) {
    const existingPath = knownNames.get(sanitizedName);
    if (existingPath && existingPath !== projectPath) {
      sanitizedName = `${sanitizedName}-${projectHash.substring(0, 6)}`;
    }
    knownNames.set(sanitizedName, projectPath);
  }

  const raw = (title && title.trim()) ? title : (slug || 'untitled');
  const sanitizedSlug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .substring(0, 60);

  const filename = `${date}-${sanitizedSlug}.md`;
  return join(outputDir, sanitizedName, filename);
}
```

- [ ] **Step 2.2: Write tests for `getOutputPath` new behavior**

```typescript
// test/harvesters-shared.test.ts
import { describe, it, expect } from 'vitest';
import { getOutputPath, sessionToMarkdown, loadHarvestState, saveHarvestState } from '../src/harvesters/shared.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('getOutputPath — project-name subdir', () => {
  it('uses last path segment as subdirectory', () => {
    const result = getOutputPath(
      '/out',
      '/Users/tamlh/workspaces/nano-brain',
      '2026-05-15',
      'fix-proxy',
    );
    expect(result).toBe('/out/nano-brain/2026-05-15-fix-proxy.md');
  });

  it('sanitizes project name to lowercase alphanumeric', () => {
    const result = getOutputPath('/out', '/Users/My Project!', '2026-05-15', 'slug');
    expect(result).toBe('/out/my-project/2026-05-15-slug.md');
  });

  it('appends hash suffix on project name collision', () => {
    const names = new Map<string, string>();
    getOutputPath('/out', '/a/zengamingx', '2026-05-15', 's1', undefined, names);
    const result = getOutputPath('/out', '/b/zengamingx', '2026-05-15', 's2', undefined, names);
    // second path gets hash suffix
    expect(result).not.toBe('/out/zengamingx/2026-05-15-s2.md');
    expect(result).toMatch(/\/out\/zengamingx-[a-f0-9]{6}\/2026-05-15-s2\.md/);
  });

  it('uses title over slug when title provided', () => {
    const result = getOutputPath('/out', '/proj/nano-brain', '2026-05-15', 'session-slug', 'Fix Proxy Bug');
    expect(result).toBe('/out/nano-brain/2026-05-15-fix-proxy-bug.md');
  });
});

describe('sessionToMarkdown', () => {
  it('produces correct frontmatter and message headings', () => {
    const md = sessionToMarkdown({
      sessionId: 'abc', slug: 'test', title: 'Test Session',
      agent: 'claude-code', date: '2026-05-15',
      project: '/proj', projectHash: 'aabbcc112233',
      messages: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', agent: 'claude-code', text: 'Hi there' },
      ],
    });
    expect(md).toContain('agent: claude-code');
    expect(md).toContain('## User');
    expect(md).toContain('## Assistant (claude-code)');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
  });
});

describe('loadHarvestState / saveHarvestState', () => {
  it('round-trips state through disk', () => {
    const dir = join(tmpdir(), `nb-test-state-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '.state.json');
    const state = { 'sess-1': { mtime: 12345, messageCount: 3 } };
    saveHarvestState(file, state);
    const loaded = loadHarvestState(file);
    expect(loaded).toEqual(state);
    rmSync(dir, { recursive: true });
  });

  it('returns empty object when state file missing', () => {
    expect(loadHarvestState('/nonexistent/path/.state.json')).toEqual({});
  });
});
```

- [ ] **Step 2.3: Run tests — expect PASS**

```bash
npx vitest run test/harvesters-shared.test.ts
```
Expected: all green.

- [ ] **Step 2.4: Commit**

```bash
git add src/harvesters/shared.ts test/harvesters-shared.test.ts
git commit -m "feat(harvesters): shared utilities with project-name output paths"
```

---

## Task 3: OpenCodeAdapter

**Files:**
- Create: `src/harvesters/opencode.ts`

- [ ] **Step 3.1: Create `src/harvesters/opencode.ts`** — wraps existing `harvestSessions` logic:

```typescript
// src/harvesters/opencode.ts
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { SessionSourceAdapter, AdapterResult } from './types.js';
import type { HarvestState } from './shared.js';
import { getOutputPath, sessionToMarkdown } from './shared.js';
import type { ExtractionConfig, Store } from '../types.js';
import { log } from '../logger.js';
import { harvestSessions as _harvestSessions } from '../harvester.js';

const DEFAULT_SESSION_DIR = join(homedir(), '.local/share/opencode/storage');

export class OpenCodeAdapter implements SessionSourceAdapter {
  readonly name = 'opencode';

  constructor(private sessionDir: string = DEFAULT_SESSION_DIR) {}

  isAvailable(): boolean {
    return existsSync(this.sessionDir);
  }

  async readNewSessions(
    _state: HarvestState,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult> {
    // Delegate to existing harvestSessions which manages its own state file
    const sessions = await _harvestSessions({
      sessionDir: this.sessionDir,
      outputDir,
      extractionConfig,
      store,
    });

    return {
      sessions,
      stateChanged: sessions.length > 0,
      stats: {
        processed: sessions.length,
        skipped: 0,
        incremental: 0,
        errors: 0,
      },
    };
  }
}
```

- [ ] **Step 3.2: Verify compile**

```bash
npx tsc --noEmitOnError false 2>&1 | grep "harvesters/opencode" | head -5
```
Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add src/harvesters/opencode.ts
git commit -m "feat(harvesters): OpenCodeAdapter wrapping existing harvestSessions"
```

---

## Task 4: ClaudeCodeAdapter + fixtures

**Files:**
- Create: `src/harvesters/claude-code.ts`
- Create: `test/fixtures/claude-sessions/` (sample JSONL files)
- Create: `test/claude-harvester.test.ts`

- [ ] **Step 4.1: Create fixture JSONL files**

```bash
mkdir -p /Users/tamlh/workspaces/self/AI/Tools/nano-brain/test/fixtures/claude-sessions/-Users-test-projects-my-project
```

Create `test/fixtures/claude-sessions/-Users-test-projects-my-project/sessions-index.json`:
```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "aaaa1111-0000-0000-0000-000000000001",
      "fullPath": "aaaa1111-0000-0000-0000-000000000001.jsonl",
      "fileMtime": 1747267200000,
      "firstPrompt": "Fix the authentication bug",
      "messageCount": 4,
      "created": "2026-05-15T01:00:00.000Z",
      "modified": "2026-05-15T01:30:00.000Z",
      "gitBranch": "main",
      "projectPath": "/Users/test/projects/my-project",
      "isSidechain": false
    },
    {
      "sessionId": "bbbb2222-0000-0000-0000-000000000002",
      "fullPath": "bbbb2222-0000-0000-0000-000000000002.jsonl",
      "fileMtime": 1747270800000,
      "firstPrompt": "Add new feature",
      "messageCount": 2,
      "created": "2026-05-15T02:00:00.000Z",
      "modified": "2026-05-15T02:10:00.000Z",
      "gitBranch": "feat/new-feature",
      "projectPath": "/Users/test/projects/my-project",
      "isSidechain": false
    }
  ]
}
```

Create `test/fixtures/claude-sessions/-Users-test-projects-my-project/aaaa1111-0000-0000-0000-000000000001.jsonl`:
```
{"type":"ai-title","aiTitle":"Fix authentication bug","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
{"type":"permission-mode","permissionMode":"auto","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
{"parentUuid":null,"type":"user","message":{"role":"user","content":"Fix the authentication bug"},"uuid":"u1","timestamp":"2026-05-15T01:00:00.000Z","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
{"parentUuid":"u1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll fix the authentication bug now."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/src/auth.ts"}}]},"uuid":"a1","timestamp":"2026-05-15T01:01:00.000Z","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
{"parentUuid":"a1","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file content here"}]},"uuid":"u2","timestamp":"2026-05-15T01:02:00.000Z","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
{"parentUuid":"u2","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The bug is fixed. The issue was a missing null check."}]},"uuid":"a2","timestamp":"2026-05-15T01:03:00.000Z","sessionId":"aaaa1111-0000-0000-0000-000000000001"}
```

Create `test/fixtures/claude-sessions/-Users-test-projects-my-project/bbbb2222-0000-0000-0000-000000000002.jsonl`:
```
{"type":"ai-title","aiTitle":"Add new feature","sessionId":"bbbb2222-0000-0000-0000-000000000002"}
{"type":"user","message":{"role":"user","content":"Add a new feature"},"uuid":"u1","timestamp":"2026-05-15T02:00:00.000Z","sessionId":"bbbb2222-0000-0000-0000-000000000002"}
{"type":"assistant","message":{"role":"assistant","content":"Here is the new feature implementation."},"uuid":"a1","timestamp":"2026-05-15T02:01:00.000Z","sessionId":"bbbb2222-0000-0000-0000-000000000002"}
```

- [ ] **Step 4.2: Write failing tests**

Create `test/claude-harvester.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeCodeAdapter } from '../src/harvesters/claude-code.js';

const FIXTURES = join(import.meta.dirname ?? __dirname, 'fixtures/claude-sessions');

describe('ClaudeCodeAdapter.isAvailable()', () => {
  it('returns true when session dir exists', () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    expect(adapter.isAvailable()).toBe(true);
  });

  it('returns false when session dir missing', () => {
    const adapter = new ClaudeCodeAdapter('/nonexistent/path');
    expect(adapter.isAvailable()).toBe(false);
  });
});

describe('ClaudeCodeAdapter.readNewSessions()', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = join(tmpdir(), `nb-claude-test-${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('discovers sessions from sessions-index.json', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    expect(result.sessions).toHaveLength(2);
  });

  it('extracts ai-title as session title', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    const session1 = result.sessions.find(s => s.sessionId === 'aaaa1111-0000-0000-0000-000000000001');
    expect(session1?.title).toBe('Fix authentication bug');
  });

  it('uses firstPrompt as title fallback when ai-title absent', async () => {
    // bbbb session has ai-title so test a session without one via direct JSONL
    const dir = join(tmpdir(), `nb-notitle-${Date.now()}`);
    mkdirSync(join(dir, 'proj'), { recursive: true });
    writeFileSync(join(dir, 'proj', 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [{
        sessionId: 'cccc',
        fullPath: 'cccc.jsonl',
        fileMtime: 1000,
        firstPrompt: 'My first prompt',
        messageCount: 1,
        created: '2026-05-15T00:00:00.000Z',
        modified: '2026-05-15T00:00:00.000Z',
        gitBranch: '',
        projectPath: '/proj',
        isSidechain: false,
      }],
    }));
    writeFileSync(join(dir, 'proj', 'cccc.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'My first prompt' }, uuid: 'u1', timestamp: '2026-05-15T00:00:00.000Z', sessionId: 'cccc' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Response' }, uuid: 'a1', timestamp: '2026-05-15T00:01:00.000Z', sessionId: 'cccc' }),
    ].join('\n'));
    const outDir = join(tmpdir(), `nb-out-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    const adapter = new ClaudeCodeAdapter(dir);
    const result = await adapter.readNewSessions({}, outDir);
    expect(result.sessions[0]?.title).toBe('My first prompt');
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('extracts user and assistant messages, skips tool_use/tool_result', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    const session1 = result.sessions.find(s => s.sessionId === 'aaaa1111-0000-0000-0000-000000000001');
    expect(session1).toBeDefined();
    // user messages: u1 (text), u2 (tool_result only — should produce empty text, filtered out or empty)
    // assistant messages: a1 (text + tool_use — only text part kept), a2 (text only)
    const userMsgs = session1!.messages.filter(m => m.role === 'user');
    const asstMsgs = session1!.messages.filter(m => m.role === 'assistant');
    expect(userMsgs.some(m => m.text.includes('Fix the authentication bug'))).toBe(true);
    expect(asstMsgs.some(m => m.text.includes("I'll fix the authentication bug now."))).toBe(true);
    expect(asstMsgs.some(m => m.text.includes('The bug is fixed.'))).toBe(true);
    // tool_use and tool_result content must not appear
    expect(session1!.messages.every(m => !m.text.includes('tool_use'))).toBe(true);
    expect(session1!.messages.every(m => !m.text.includes('tool_result'))).toBe(true);
  });

  it('sets agent to "claude-code"', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    expect(result.sessions.every(s => s.agent === 'claude-code')).toBe(true);
  });

  it('skips sessions unchanged since last harvest (state tracking)', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const state: Record<string, { mtime: number; messageCount?: number }> = {
      'aaaa1111-0000-0000-0000-000000000001': { mtime: 1747267200000, messageCount: 4 },
      'bbbb2222-0000-0000-0000-000000000002': { mtime: 1747270800000, messageCount: 2 },
    };
    const result = await adapter.readNewSessions(state, outputDir);
    expect(result.sessions).toHaveLength(0);
    expect(result.stats.skipped).toBe(2);
  });

  it('writes markdown file to project-name subdir', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    await adapter.readNewSessions({}, outputDir);
    // project name from "/Users/test/projects/my-project" → "my-project"
    const files = existsSync(join(outputDir, 'my-project'))
      ? require('fs').readdirSync(join(outputDir, 'my-project'))
      : [];
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f: string) => f.endsWith('.md'))).toBe(true);
  });

  it('handles string content (not array) in messages', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    const session2 = result.sessions.find(s => s.sessionId === 'bbbb2222-0000-0000-0000-000000000002');
    expect(session2?.messages.some(m => m.text.includes('Add a new feature'))).toBe(true);
    expect(session2?.messages.some(m => m.text.includes('new feature implementation'))).toBe(true);
  });
});
```

- [ ] **Step 4.3: Run tests — expect FAIL (ClaudeCodeAdapter not yet created)**

```bash
npx vitest run test/claude-harvester.test.ts 2>&1 | tail -10
```
Expected: import error or "ClaudeCodeAdapter not found".

- [ ] **Step 4.4: Implement `ClaudeCodeAdapter`**

Create `src/harvesters/claude-code.ts`:
```typescript
// src/harvesters/claude-code.ts
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { SessionSourceAdapter, AdapterResult } from './types.js';
import type { HarvestState } from './shared.js';
import { getOutputPath, sessionToMarkdown, loadHarvestState, saveHarvestState } from './shared.js';
import type { ExtractionConfig, Store, HarvestedSession } from '../types.js';
import { log } from '../logger.js';
import { extractFactsFromSession, storeExtractedFact } from '../extraction.js';
import { createLLMProvider } from '../llm-provider.js';
import type { ConsolidationConfig } from '../types.js';

const DEFAULT_SESSION_DIR = join(homedir(), '.claude/projects');
const MAX_EXTRACTED_FACTS = 10000;

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text'
    )
    .map(item => item.text)
    .join('\n');
}

export class ClaudeCodeAdapter implements SessionSourceAdapter {
  readonly name = 'claude-code';

  constructor(private sessionDir: string = DEFAULT_SESSION_DIR) {}

  isAvailable(): boolean {
    return existsSync(this.sessionDir);
  }

  async readNewSessions(
    state: HarvestState,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult> {
    const sessions: HarvestedSession[] = [];
    let stateChanged = false;
    const stats = { processed: 0, skipped: 0, incremental: 0, errors: 0 };
    const extractionStats = { factsExtracted: 0, duplicatesSkipped: 0, errors: 0 };
    const projectNames = new Map<string, string>();

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(this.sessionDir);
    } catch {
      return { sessions, stateChanged, stats };
    }

    for (const projectSlug of projectDirs) {
      const projectDir = join(this.sessionDir, projectSlug);
      const indexPath = join(projectDir, 'sessions-index.json');

      let entries: SessionIndexEntry[] = [];

      if (existsSync(indexPath)) {
        try {
          const raw = readFileSync(indexPath, 'utf-8');
          const index = JSON.parse(raw) as SessionIndex;
          entries = (index.entries ?? []).filter(e => !e.isSidechain);
        } catch {
          log('claude-harvester', `Failed to parse sessions-index.json in ${projectSlug}`, 'warn');
          continue;
        }
      } else {
        // Fallback: scan for .jsonl files directly
        try {
          const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
          entries = files.map(f => ({
            sessionId: f.replace('.jsonl', ''),
            fullPath: f,
            fileMtime: 0,
            firstPrompt: '',
            messageCount: 0,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            gitBranch: '',
            projectPath: projectSlug.replace(/^-/, '/').replace(/-/g, '/'),
            isSidechain: false,
          }));
        } catch {
          continue;
        }
      }

      for (const entry of entries) {
        const { sessionId, fileMtime, firstPrompt, projectPath, created, modified } = entry;

        // State check — skip if unchanged
        const existingState = state[sessionId];
        if (existingState && existingState.mtime >= fileMtime && existingState.messageCount !== undefined) {
          stats.skipped++;
          continue;
        }

        const jsonlPath = join(projectDir, entry.fullPath.endsWith('.jsonl') ? entry.fullPath : `${sessionId}.jsonl`);
        if (!existsSync(jsonlPath)) {
          stats.skipped++;
          continue;
        }

        try {
          const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
          let title = firstPrompt || 'untitled';
          const messages: Array<{ role: 'user' | 'assistant'; agent?: string; text: string }> = [];

          for (const line of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              const type = event.type as string;

              if (type === 'ai-title') {
                title = (event.aiTitle as string) || title;
                continue;
              }

              if (type !== 'user' && type !== 'assistant') continue;

              const msg = event.message as { role?: string; content?: unknown } | undefined;
              if (!msg) continue;

              const role = msg.role === 'user' ? 'user' : 'assistant';
              const text = extractTextFromContent(msg.content);

              // Skip messages with no extractable text (e.g. pure tool_result messages)
              if (!text.trim()) continue;

              messages.push({ role, agent: role === 'assistant' ? 'claude-code' : undefined, text });
            } catch {
              // malformed line — skip
            }
          }

          if (messages.length === 0) {
            state[sessionId] = { mtime: fileMtime, messageCount: 0, skipped: true };
            stateChanged = true;
            stats.skipped++;
            continue;
          }

          const dateStr = created.split('T')[0];
          const slug = sessionId.substring(0, 8);
          const projectHash = createHash('sha256').update(projectPath).digest('hex').substring(0, 12);

          const harvestedSession: HarvestedSession = {
            sessionId,
            slug,
            title,
            agent: 'claude-code',
            date: dateStr,
            project: projectPath,
            projectHash,
            messages,
          };

          const outputPath = getOutputPath(outputDir, projectPath, dateStr, slug, title, projectNames);
          const outputDirPath = dirname(outputPath);
          mkdirSync(outputDirPath, { recursive: true });
          writeFileSync(outputPath, sessionToMarkdown(harvestedSession), 'utf-8');

          sessions.push(harvestedSession);
          state[sessionId] = { mtime: fileMtime, messageCount: messages.length };
          stateChanged = true;
          stats.processed++;

          // Optional LLM extraction
          if (extractionConfig?.enabled && store) {
            try {
              const llmConfig: ConsolidationConfig = {
                enabled: true,
                interval_ms: 0,
                model: extractionConfig.model,
                endpoint: extractionConfig.endpoint,
                apiKey: extractionConfig.apiKey,
                max_memories_per_cycle: 0,
                min_memories_threshold: 0,
                confidence_threshold: 0,
              };
              const provider = createLLMProvider(llmConfig);
              if (provider) {
                const health = store.getIndexHealth();
                if ((health.extractedFacts ?? 0) < MAX_EXTRACTED_FACTS) {
                  const result = await extractFactsFromSession(
                    sessionToMarkdown(harvestedSession),
                    provider,
                    extractionConfig,
                  );
                  for (const fact of result.facts) {
                    const stored = storeExtractedFact(store, fact, sessionId, projectHash);
                    if (stored) extractionStats.factsExtracted++;
                    else extractionStats.duplicatesSkipped++;
                  }
                }
              }
            } catch (err) {
              extractionStats.errors++;
              log('claude-harvester', `Extraction failed for ${sessionId}: ${String(err)}`, 'warn');
            }
          }
        } catch (err) {
          stats.errors++;
          log('claude-harvester', `Failed to process session ${sessionId}: ${String(err)}`, 'warn');
        }
      }
    }

    if (stateChanged) {
      const stateFile = join(outputDir, '.harvest-state-claude-code.json');
      saveHarvestState(stateFile, state);
    }

    log('claude-harvester', `Harvest complete: ${stats.processed} processed, ${stats.skipped} skipped, ${stats.errors} errors`);

    return {
      sessions,
      stateChanged,
      stats: { ...stats, extractionStats },
    };
  }
}
```

- [ ] **Step 4.5: Run tests — expect PASS**

```bash
npx vitest run test/claude-harvester.test.ts
```
Expected: all green.

- [ ] **Step 4.6: Commit**

```bash
git add src/harvesters/claude-code.ts test/fixtures/claude-sessions/ test/claude-harvester.test.ts
git commit -m "feat(harvesters): ClaudeCodeAdapter with JSONL parser and state tracking"
```

---

## Task 5: Orchestrator

**Files:**
- Create: `src/harvesters/index.ts`
- Create: `test/harvester-adapter.test.ts`

- [ ] **Step 5.1: Write failing orchestrator tests**

Create `test/harvester-adapter.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runHarvestCycle } from '../src/harvesters/index.js';
import type { SessionSourceAdapter, AdapterResult } from '../src/harvesters/types.js';
import type { HarvestedSession } from '../src/types.js';

function makeSession(id: string, project: string): HarvestedSession {
  return {
    sessionId: id, slug: id, title: `Session ${id}`,
    agent: 'test', date: '2026-05-15',
    project, projectHash: 'aabbcc112233',
    messages: [{ role: 'user', text: 'hello' }],
  };
}

function mockAdapter(name: string, sessions: HarvestedSession[], available = true): SessionSourceAdapter {
  return {
    name,
    isAvailable: () => available,
    readNewSessions: vi.fn().mockResolvedValue({
      sessions,
      stateChanged: sessions.length > 0,
      stats: { processed: sessions.length, skipped: 0, incremental: 0, errors: 0 },
    } satisfies AdapterResult),
  };
}

describe('runHarvestCycle', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = join(tmpdir(), `nb-orch-test-${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it('calls all available adapters', async () => {
    const a1 = mockAdapter('tool-a', [makeSession('s1', '/proj-a')]);
    const a2 = mockAdapter('tool-b', [makeSession('s2', '/proj-b')]);
    const result = await runHarvestCycle([a1, a2], outputDir);
    expect(a1.readNewSessions).toHaveBeenCalledOnce();
    expect(a2.readNewSessions).toHaveBeenCalledOnce();
    expect(result).toHaveLength(2);
  });

  it('skips unavailable adapters', async () => {
    const a1 = mockAdapter('available', [makeSession('s1', '/proj')], true);
    const a2 = mockAdapter('unavailable', [], false);
    await runHarvestCycle([a1, a2], outputDir);
    expect(a1.readNewSessions).toHaveBeenCalledOnce();
    expect(a2.readNewSessions).not.toHaveBeenCalled();
  });

  it('continues when one adapter throws', async () => {
    const a1: SessionSourceAdapter = {
      name: 'broken',
      isAvailable: () => true,
      readNewSessions: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const a2 = mockAdapter('good', [makeSession('s2', '/proj')]);
    const result = await runHarvestCycle([a1, a2], outputDir);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('s2');
  });

  it('returns empty array when no adapters available', async () => {
    const result = await runHarvestCycle([], outputDir);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 5.2: Run tests — expect FAIL**

```bash
npx vitest run test/harvester-adapter.test.ts 2>&1 | tail -5
```
Expected: import error.

- [ ] **Step 5.3: Implement orchestrator**

Create `src/harvesters/index.ts`:
```typescript
// src/harvesters/index.ts
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { SessionSourceAdapter } from './types.js';
import { loadHarvestState, saveHarvestState } from './shared.js';
import type { ExtractionConfig, Store, HarvestedSession } from '../types.js';
import { log } from '../logger.js';

export { OpenCodeAdapter } from './opencode.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export type { SessionSourceAdapter, AdapterResult, HarvestStats } from './types.js';

export async function runHarvestCycle(
  adapters: SessionSourceAdapter[],
  outputDir: string,
  options?: { extractionConfig?: ExtractionConfig; store?: Store },
): Promise<HarvestedSession[]> {
  mkdirSync(outputDir, { recursive: true });
  const allSessions: HarvestedSession[] = [];

  for (const adapter of adapters) {
    if (!adapter.isAvailable()) {
      log('harvester', `Adapter ${adapter.name}: source not available, skipping`);
      continue;
    }

    const stateFile = join(outputDir, `.harvest-state-${adapter.name}.json`);
    const state = loadHarvestState(stateFile);

    try {
      const result = await adapter.readNewSessions(
        state,
        outputDir,
        options?.extractionConfig,
        options?.store,
      );

      if (result.stateChanged) {
        saveHarvestState(stateFile, state);
      }

      if (result.sessions.length > 0) {
        log('harvester', `Adapter ${adapter.name}: ${result.sessions.length} session(s) harvested`);
      }

      allSessions.push(...result.sessions);
    } catch (err) {
      log('harvester', `Adapter ${adapter.name} failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }

  return allSessions;
}
```

- [ ] **Step 5.4: Run tests — expect PASS**

```bash
npx vitest run test/harvester-adapter.test.ts
```
Expected: all green.

- [ ] **Step 5.5: Commit**

```bash
git add src/harvesters/index.ts test/harvester-adapter.test.ts
git commit -m "feat(harvesters): runHarvestCycle orchestrator with per-adapter error isolation"
```

---

## Task 6: Re-export shim + existing tests

**Files:**
- Modify: `src/harvester.ts`

- [ ] **Step 6.1: Add re-exports to `src/harvester.ts`**

At the top of `src/harvester.ts`, add:
```typescript
// Re-exports from src/harvesters/shared.ts for backward compatibility
export {
  sessionToMarkdown,
  messagesToMarkdown,
  loadHarvestState,
  saveHarvestState,
  getOutputPath,
  type HarvestState,
  type HarvestStateEntry,
} from './harvesters/shared.js';
```

Keep all existing function implementations in `harvester.ts` intact — this step only adds re-exports alongside existing code. We do NOT remove the original implementations yet (that would be a separate refactor).

Note: TypeScript will warn about duplicate exports. Resolve by removing the original `export function sessionToMarkdown`, `export function getOutputPath`, etc. declarations from `harvester.ts` and keeping only the re-export. The underlying implementations move to `shared.ts` (already done in Task 2). Replace each original `export function` in `harvester.ts` with an import from `./harvesters/shared.js`.

- [ ] **Step 6.2: Run existing harvester tests — expect PASS**

```bash
npx vitest run test/harvester.test.ts
```
Expected: all green — confirms backward compatibility.

- [ ] **Step 6.3: Run full test suite**

```bash
npx vitest run
```
Expected: 0 failures.

- [ ] **Step 6.4: Commit**

```bash
git add src/harvester.ts
git commit -m "refactor(harvester): re-export shared utilities from src/harvesters/shared"
```

---

## Task 7: Config schema

**Files:**
- Modify: `src/types.ts`
- Modify: `config.default.yml`

- [ ] **Step 7.1: Add `HarvesterConfig` to `src/types.ts`**

In `src/types.ts`, add after `ExtractionConfig`:
```typescript
export interface HarvesterSourceConfig {
  enabled?: boolean;
  sessionDir?: string;
}

export interface HarvesterConfig {
  opencode?: HarvesterSourceConfig & { enabled?: boolean };  // default: enabled true
  claudeCode?: HarvesterSourceConfig;                        // default: enabled false
}
```

Add `harvester?: HarvesterConfig` to `CollectionConfig` interface (after `extraction?`):
```typescript
  harvester?: HarvesterConfig;
```

- [ ] **Step 7.2: Add `harvester:` block to `config.default.yml`**

Add after the `extraction:` comment block:
```yaml
# Session harvesting configuration
# harvester:
#   opencode:
#     enabled: true
#     sessionDir: ""    # default: ~/.local/share/opencode/storage
#   claudeCode:
#     enabled: false    # opt-in; set to true to harvest Claude Code sessions
#     sessionDir: ""    # default: ~/.claude/projects
```

- [ ] **Step 7.3: Verify TypeScript compiles**

```bash
npx tsc --noEmitOnError false 2>&1 | grep -i "harvester\|HarvesterConfig" | head -5
```
Expected: no errors.

- [ ] **Step 7.4: Commit**

```bash
git add src/types.ts config.default.yml
git commit -m "feat(config): add HarvesterConfig schema for per-source harvester flags"
```

---

## Task 8: watcher.ts integration

**Files:**
- Modify: `src/jobs/watcher.ts`

- [ ] **Step 8.1: Update watcher to build adapters and call `runHarvestCycle`**

In `src/jobs/watcher.ts`:

1. Add import:
```typescript
import { runHarvestCycle, OpenCodeAdapter, ClaudeCodeAdapter } from '../harvesters/index.js';
import type { HarvesterConfig } from '../types.js';
```

2. Add `harvesterConfig?: HarvesterConfig` to the watcher options destructuring (alongside `sessionStorageDir`).

3. Replace the `harvestSessions({ sessionDir: sessionStorageDir, outputDir })` call in the session poll with:
```typescript
// Build adapters from config
const adapters = [];
const ocEnabled = harvesterConfig?.opencode?.enabled !== false;  // default true
if (ocEnabled) {
  const ocDir = harvesterConfig?.opencode?.sessionDir || sessionStorageDir;
  adapters.push(new OpenCodeAdapter(ocDir));
}
if (harvesterConfig?.claudeCode?.enabled) {
  const ccDir = harvesterConfig?.claudeCode?.sessionDir || undefined;
  adapters.push(new ClaudeCodeAdapter(ccDir));
}

const sessions = await runHarvestCycle(adapters, outputDir, {
  extractionConfig: options.extractionConfig,
  store: options.store,
});
```

- [ ] **Step 8.2: Pass `harvesterConfig` from bootstrap**

In `src/server/bootstrap.ts`, pass `harvesterConfig: config?.harvester` in the watcher options object (alongside `sessionStorageDir`).

- [ ] **Step 8.3: Run full test suite**

```bash
npx vitest run
```
Expected: 0 failures.

- [ ] **Step 8.4: Commit**

```bash
git add src/jobs/watcher.ts src/server/bootstrap.ts
git commit -m "feat(watcher): integrate adapter-based harvest cycle with claudeCode flag support"
```

---

## Task 9: End-to-end test in container + release

- [ ] **Step 9.1: Publish beta**

```bash
npm version 2026.8.17-beta.1 --no-git-tag-version
npx tsc --noEmitOnError false
npm publish --tag beta --access public
```

- [ ] **Step 9.2: Install in container and enable Claude Code harvesting**

```bash
docker exec -u root 48f851a5b8df npm install -g nano-brain@2026.8.17-beta.1
```

Update `~/.nano-brain/config.yml` on host — add under the root level:
```yaml
harvester:
  opencode:
    enabled: true
  claudeCode:
    enabled: true
```

Restart server:
```bash
docker restart fe04d635dfd0
until curl -s http://localhost:3100/health | grep -q '"ready":true'; do sleep 3; done
```

- [ ] **Step 9.3: Verify Claude Code sessions are harvested**

```bash
docker logs fe04d635dfd0 --since 5m 2>&1 | grep "claude-harvester\|claude-code"
ls ~/.nano-brain/sessions/ | head -20
```
Expected: `claude-code` log entries, and project-name subdirs in `~/.nano-brain/sessions/`.

- [ ] **Step 9.4: Verify sessions searchable**

```bash
docker exec 48f851a5b8df nano-brain query "Claude Code session fix proxy container"
```
Expected: results from harvested Claude Code sessions.

- [ ] **Step 9.5: Create PR and merge**

```bash
gh auth switch --user kokorolx
git push -u origin feat/session-pipeline-v2
gh pr create --repo nano-step/nano-brain \
  --title "feat: session pipeline v2 — Claude Code harvester + adapter pattern" \
  --body "Closes #17"
```
Merge after review. Switch back: `gh auth switch --user nus-rick`.

- [ ] **Step 9.6: Bump stable version and publish**

```bash
git checkout master && git pull
npm version 2026.8.17 --no-git-tag-version
npx tsc --noEmitOnError false
npm publish --access public
git add package.json package-lock.json
git commit -m "chore: bump version to 2026.8.17"
```
