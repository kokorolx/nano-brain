import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeCodeAdapter } from '../src/harvesters/claude-code.js';

const FIXTURES = join(new URL(import.meta.url).pathname, '..', 'fixtures/claude-sessions');

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

  it('extracts user and assistant messages, skips tool_use/tool_result content', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    const session1 = result.sessions.find(s => s.sessionId === 'aaaa1111-0000-0000-0000-000000000001');
    expect(session1).toBeDefined();
    const userMsgs = session1!.messages.filter(m => m.role === 'user');
    const asstMsgs = session1!.messages.filter(m => m.role === 'assistant');
    expect(userMsgs.some(m => m.text.includes('Fix the authentication bug'))).toBe(true);
    expect(asstMsgs.some(m => m.text.includes("I'll fix the authentication bug now."))).toBe(true);
    expect(asstMsgs.some(m => m.text.includes('The bug is fixed.'))).toBe(true);
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
    const projectSubdir = join(outputDir, 'my-project');
    expect(existsSync(projectSubdir)).toBe(true);
    const files = readdirSync(projectSubdir);
    expect(files.some(f => f.endsWith('.md'))).toBe(true);
  });

  it('handles string content (not array) in messages', async () => {
    const adapter = new ClaudeCodeAdapter(FIXTURES);
    const result = await adapter.readNewSessions({}, outputDir);
    const session2 = result.sessions.find(s => s.sessionId === 'bbbb2222-0000-0000-0000-000000000002');
    expect(session2?.messages.some(m => m.text.includes('Add a new feature'))).toBe(true);
    expect(session2?.messages.some(m => m.text.includes('new feature implementation'))).toBe(true);
  });
});
