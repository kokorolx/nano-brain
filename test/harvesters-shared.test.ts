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
