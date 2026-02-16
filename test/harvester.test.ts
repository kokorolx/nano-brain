import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  sessionToMarkdown,
  getOutputPath,
  parseParts,
  parseSession,
  parseMessages,
  harvestSessions,
  loadHarvestState,
  saveHarvestState
} from '../src/harvester.js';
import type { HarvestedSession } from '../src/types.js';

describe('sessionToMarkdown', () => {
  it('generates correct YAML frontmatter and message sections', () => {
    const session: HarvestedSession = {
      sessionId: 'ses_abc123',
      slug: 'test-session',
      title: 'Implement auth flow',
      agent: 'sisyphus',
      date: '2026-02-16',
      project: '/path/to/project',
      projectHash: '0a86b20b1234',
      messages: [
        {
          role: 'user',
          text: 'How should we implement auth?'
        },
        {
          role: 'assistant',
          agent: 'sisyphus',
          text: 'Let me help you implement authentication...'
        },
        {
          role: 'user',
          text: 'Can you add JWT support?'
        },
        {
          role: 'assistant',
          agent: 'sisyphus-junior',
          text: "I'll add JWT support..."
        }
      ]
    };

    const markdown = sessionToMarkdown(session);

    expect(markdown).toContain('---');
    expect(markdown).toContain('session: ses_abc123');
    expect(markdown).toContain('agent: sisyphus');
    expect(markdown).toContain('date: "2026-02-16"');
    expect(markdown).toContain('title: "Implement auth flow"');
    expect(markdown).toContain('project: /path/to/project');
    expect(markdown).toContain('projectHash: 0a86b20b1234');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('How should we implement auth?');
    expect(markdown).toContain('## Assistant (sisyphus)');
    expect(markdown).toContain('Let me help you implement authentication...');
    expect(markdown).toContain('## Assistant (sisyphus-junior)');
    expect(markdown).toContain("I'll add JWT support...");
  });

  it('handles missing agent name', () => {
    const session: HarvestedSession = {
      sessionId: 'ses_xyz789',
      slug: 'no-agent',
      title: 'Test',
      agent: 'assistant',
      date: '2026-02-16',
      project: '/test',
      projectHash: 'abc123',
      messages: [
        {
          role: 'user',
          text: 'Hello'
        },
        {
          role: 'assistant',
          text: 'Hi there'
        }
      ]
    };

    const markdown = sessionToMarkdown(session);

    expect(markdown).toContain('## Assistant (assistant)');
    expect(markdown).toContain('Hi there');
  });
});

describe('getOutputPath', () => {
  it('generates correct path with sanitized slug', () => {
    const outputDir = '/output';
    const projectPath = '/path/to/project';
    const date = '2026-02-16';
    const slug = 'test-session';

    const path = getOutputPath(outputDir, projectPath, date, slug);

    expect(path).toMatch(/^\/output\/[a-f0-9]{12}\/2026-02-16-test-session\.md$/);
  });

  it('handles special characters in slug', () => {
    const outputDir = '/output';
    const projectPath = '/path/to/project';
    const date = '2026-02-16';
    const slug = 'Test Session! @#$ With Spaces';

    const path = getOutputPath(outputDir, projectPath, date, slug);

    expect(path).toMatch(/^\/output\/[a-f0-9]{12}\/2026-02-16-test-session-with-spaces\.md$/);
  });

  it('collapses multiple hyphens', () => {
    const outputDir = '/output';
    const projectPath = '/path/to/project';
    const date = '2026-02-16';
    const slug = 'test---multiple---hyphens';

    const path = getOutputPath(outputDir, projectPath, date, slug);

    expect(path).toMatch(/^\/output\/[a-f0-9]{12}\/2026-02-16-test-multiple-hyphens\.md$/);
  });

  it('removes leading and trailing hyphens', () => {
    const outputDir = '/output';
    const projectPath = '/path/to/project';
    const date = '2026-02-16';
    const slug = '---test-slug---';

    const path = getOutputPath(outputDir, projectPath, date, slug);

    expect(path).toMatch(/^\/output\/[a-f0-9]{12}\/2026-02-16-test-slug\.md$/);
  });
});

describe('parseParts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harvester-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts only text parts, skips tool/step-start', () => {
    const messageId = 'msg_001';
    const partDir = join(tmpDir, 'part', messageId);
    mkdirSync(partDir, { recursive: true });

    writeFileSync(
      join(partDir, 'prt_001.json'),
      JSON.stringify({
        id: 'prt_001',
        type: 'text',
        text: 'First text part'
      })
    );

    writeFileSync(
      join(partDir, 'prt_002.json'),
      JSON.stringify({
        id: 'prt_002',
        type: 'tool',
        callID: 'toolu_123',
        tool: 'bash'
      })
    );

    writeFileSync(
      join(partDir, 'prt_003.json'),
      JSON.stringify({
        id: 'prt_003',
        type: 'step-start',
        snapshot: '618a2220'
      })
    );

    writeFileSync(
      join(partDir, 'prt_004.json'),
      JSON.stringify({
        id: 'prt_004',
        type: 'text',
        text: 'Second text part'
      })
    );

    const result = parseParts(messageId, tmpDir);

    expect(result).toBe('First text part\nSecond text part');
  });

  it('skips synthetic parts', () => {
    const messageId = 'msg_002';
    const partDir = join(tmpDir, 'part', messageId);
    mkdirSync(partDir, { recursive: true });

    writeFileSync(
      join(partDir, 'prt_001.json'),
      JSON.stringify({
        id: 'prt_001',
        type: 'text',
        text: 'Real text'
      })
    );

    writeFileSync(
      join(partDir, 'prt_002.json'),
      JSON.stringify({
        id: 'prt_002',
        type: 'text',
        synthetic: true,
        text: 'Synthetic text'
      })
    );

    const result = parseParts(messageId, tmpDir);

    expect(result).toBe('Real text');
    expect(result).not.toContain('Synthetic text');
  });

  it('returns empty string for missing directory', () => {
    const result = parseParts('msg_nonexistent', tmpDir);
    expect(result).toBe('');
  });

  it('handles malformed JSON gracefully', () => {
    const messageId = 'msg_003';
    const partDir = join(tmpDir, 'part', messageId);
    mkdirSync(partDir, { recursive: true });

    writeFileSync(join(partDir, 'prt_001.json'), 'invalid json{');

    const result = parseParts(messageId, tmpDir);
    expect(result).toBe('');
  });
});

describe('parseSession', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harvester-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses valid session JSON', () => {
    const sessionPath = join(tmpDir, 'ses_test1.json');
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: 'ses_test1',
        slug: 'test-session',
        title: 'Test Session',
        projectID: 'abc123',
        directory: '/path/to/project',
        time: {
          created: 1770106366269,
          updated: 1770223889563
        }
      })
    );

    const result = parseSession(sessionPath);

    expect(result).not.toBeNull();
    expect(result?.id).toBe('ses_test1');
    expect(result?.slug).toBe('test-session');
    expect(result?.title).toBe('Test Session');
    expect(result?.projectID).toBe('abc123');
    expect(result?.directory).toBe('/path/to/project');
    expect(result?.created).toBe(1770106366269);
  });

  it('returns null for missing file', () => {
    const result = parseSession(join(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const sessionPath = join(tmpDir, 'ses_bad.json');
    writeFileSync(sessionPath, 'invalid json{');

    const result = parseSession(sessionPath);
    expect(result).toBeNull();
  });

  it('handles missing title field', () => {
    const sessionPath = join(tmpDir, 'ses_notitle.json');
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: 'ses_notitle',
        slug: 'no-title',
        projectID: 'abc123',
        directory: '/path',
        time: { created: 1770106366269 }
      })
    );

    const result = parseSession(sessionPath);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('');
  });
});

describe('parseMessages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harvester-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses messages and sorts by creation time', () => {
    const sessionId = 'ses_test1';
    const messageDir = join(tmpDir, 'message', sessionId);
    mkdirSync(messageDir, { recursive: true });

    writeFileSync(
      join(messageDir, 'msg_002.json'),
      JSON.stringify({
        id: 'msg_002',
        sessionID: sessionId,
        role: 'assistant',
        agent: 'sisyphus',
        time: { created: 1770106366300 }
      })
    );

    writeFileSync(
      join(messageDir, 'msg_001.json'),
      JSON.stringify({
        id: 'msg_001',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1770106366200 }
      })
    );

    const result = parseMessages(sessionId, tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('msg_001');
    expect(result[0].role).toBe('user');
    expect(result[1].id).toBe('msg_002');
    expect(result[1].role).toBe('assistant');
    expect(result[1].agent).toBe('sisyphus');
  });

  it('returns empty array for missing directory', () => {
    const result = parseMessages('ses_nonexistent', tmpDir);
    expect(result).toEqual([]);
  });

  it('handles malformed JSON gracefully', () => {
    const sessionId = 'ses_test2';
    const messageDir = join(tmpDir, 'message', sessionId);
    mkdirSync(messageDir, { recursive: true });

    writeFileSync(join(messageDir, 'msg_001.json'), 'invalid json{');

    const result = parseMessages(sessionId, tmpDir);
    expect(result).toEqual([]);
  });
});

describe('loadHarvestState and saveHarvestState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harvester-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('round-trip test', () => {
    const stateFile = join(tmpDir, 'state.json');
    const state = {
      'ses_abc123': 1770106366269,
      'ses_xyz789': 1770223889563
    };

    saveHarvestState(stateFile, state);

    expect(existsSync(stateFile)).toBe(true);

    const loaded = loadHarvestState(stateFile);

    expect(loaded).toEqual(state);
  });

  it('creates parent directories if needed', () => {
    const stateFile = join(tmpDir, 'nested', 'dir', 'state.json');
    const state = { 'ses_test': 123456 };

    saveHarvestState(stateFile, state);

    expect(existsSync(stateFile)).toBe(true);
    const loaded = loadHarvestState(stateFile);
    expect(loaded).toEqual(state);
  });

  it('returns empty object for missing file', () => {
    const result = loadHarvestState(join(tmpDir, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('returns empty object for malformed JSON', () => {
    const stateFile = join(tmpDir, 'bad.json');
    writeFileSync(stateFile, 'invalid json{');

    const result = loadHarvestState(stateFile);
    expect(result).toEqual({});
  });
});

describe('harvestSessions', () => {
  let tmpDir: string;
  let outputDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harvester-test-${Date.now()}`);
    outputDir = join(tmpDir, 'output');
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('end-to-end test with fixture data', async () => {
    const projectHash = 'abc123';
    const sessionId = 'ses_test1';
    const messageId1 = 'msg_001';
    const messageId2 = 'msg_002';

    const projectDir = join(tmpDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${projectHash}.json`),
      JSON.stringify({
        id: projectHash,
        worktree: '/path/to/project',
        vcs: 'git',
        time: { created: 1770106366269, updated: 1770223889563 }
      })
    );

    const sessionDir = join(tmpDir, 'session', projectHash);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        slug: 'test-session',
        title: 'Test Session',
        projectID: projectHash,
        directory: '/path/to/project',
        time: { created: 1770106366269, updated: 1770223889563 }
      })
    );

    const messageDir = join(tmpDir, 'message', sessionId);
    mkdirSync(messageDir, { recursive: true });
    writeFileSync(
      join(messageDir, `${messageId1}.json`),
      JSON.stringify({
        id: messageId1,
        sessionID: sessionId,
        role: 'user',
        time: { created: 1770106366200 }
      })
    );
    writeFileSync(
      join(messageDir, `${messageId2}.json`),
      JSON.stringify({
        id: messageId2,
        sessionID: sessionId,
        role: 'assistant',
        agent: 'sisyphus',
        time: { created: 1770106366300 }
      })
    );

    const partDir1 = join(tmpDir, 'part', messageId1);
    mkdirSync(partDir1, { recursive: true });
    writeFileSync(
      join(partDir1, 'prt_001.json'),
      JSON.stringify({
        id: 'prt_001',
        type: 'text',
        text: 'Hello, how can I help?'
      })
    );

    const partDir2 = join(tmpDir, 'part', messageId2);
    mkdirSync(partDir2, { recursive: true });
    writeFileSync(
      join(partDir2, 'prt_002.json'),
      JSON.stringify({
        id: 'prt_002',
        type: 'text',
        text: 'I can help you with that.'
      })
    );
    writeFileSync(
      join(partDir2, 'prt_003.json'),
      JSON.stringify({
        id: 'prt_003',
        type: 'tool',
        callID: 'toolu_123',
        tool: 'bash'
      })
    );
    writeFileSync(
      join(partDir2, 'prt_004.json'),
      JSON.stringify({
        id: 'prt_004',
        type: 'step-start',
        snapshot: '618a2220'
      })
    );

    const result = await harvestSessions({
      sessionDir: tmpDir,
      outputDir
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe(sessionId);
    expect(result[0].slug).toBe('test-session');
    expect(result[0].title).toBe('Test Session');
    expect(result[0].agent).toBe('sisyphus');
    expect(result[0].project).toBe('/path/to/project');
    expect(result[0].messages).toHaveLength(2);
    expect(result[0].messages[0].role).toBe('user');
    expect(result[0].messages[0].text).toBe('Hello, how can I help?');
    expect(result[0].messages[1].role).toBe('assistant');
    expect(result[0].messages[1].agent).toBe('sisyphus');
    expect(result[0].messages[1].text).toBe('I can help you with that.');

    const outputPath = getOutputPath(outputDir, '/path/to/project', result[0].date, 'test-session');
    expect(existsSync(outputPath)).toBe(true);

    const markdown = readFileSync(outputPath, 'utf-8');
    expect(markdown).toContain('session: ses_test1');
    expect(markdown).toContain('title: "Test Session"');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('Hello, how can I help?');
    expect(markdown).toContain('## Assistant (sisyphus)');
    expect(markdown).toContain('I can help you with that.');
  });

  it('returns empty array for missing session directory', async () => {
    const result = await harvestSessions({
      sessionDir: join(tmpDir, 'nonexistent'),
      outputDir
    });

    expect(result).toEqual([]);
  });

  it('handles multiple sessions in multiple projects', async () => {
    const projectHash1 = 'proj1';
    const projectHash2 = 'proj2';
    const sessionId1 = 'ses_001';
    const sessionId2 = 'ses_002';

    const sessionDir1 = join(tmpDir, 'session', projectHash1);
    mkdirSync(sessionDir1, { recursive: true });
    writeFileSync(
      join(sessionDir1, `${sessionId1}.json`),
      JSON.stringify({
        id: sessionId1,
        slug: 'session-one',
        title: 'Session One',
        projectID: projectHash1,
        directory: '/project1',
        time: { created: 1770106366269 }
      })
    );

    const sessionDir2 = join(tmpDir, 'session', projectHash2);
    mkdirSync(sessionDir2, { recursive: true });
    writeFileSync(
      join(sessionDir2, `${sessionId2}.json`),
      JSON.stringify({
        id: sessionId2,
        slug: 'session-two',
        title: 'Session Two',
        projectID: projectHash2,
        directory: '/project2',
        time: { created: 1770106366300 }
      })
    );

    const result = await harvestSessions({
      sessionDir: tmpDir,
      outputDir
    });

    expect(result).toHaveLength(2);
    expect(result.map(s => s.sessionId).sort()).toEqual([sessionId1, sessionId2].sort());
  });
});
