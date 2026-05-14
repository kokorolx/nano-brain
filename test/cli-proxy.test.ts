import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Mock fetch globally before importing anything that uses it
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock isInsideContainer to control container mode per-test
const mockIsInsideContainer = vi.fn().mockReturnValue(false);
vi.mock('../src/host.js', () => ({
  isInsideContainer: () => mockIsInsideContainer(),
  resolveHostUrl: (url: string) => url,
}));

import { handleTags } from '../src/cli/commands/tags.js';
import { handleUpdate } from '../src/cli/commands/update.js';
import { handleStatus } from '../src/cli/commands/status.js';
import { createStore } from '../src/store.js';
import type { GlobalOptions } from '../src/cli/types.js';

function makeTempDb(): { dbPath: string; configPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-proxy-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const configPath = path.join(dir, 'config.yml');
  const store = createStore(dbPath);
  store.close();
  fs.writeFileSync(configPath, 'collections: []\n');
  return { dbPath, configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeOpts(dbPath: string, configPath?: string): GlobalOptions {
  return { dbPath, configPath: configPath ?? '/nonexistent/config.yml', remaining: [] };
}

// Capture stdout/stderr
function captureOutput(): { lines: () => string[]; restore: () => void } {
  const captured: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    captured.push(String(data));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    lines: () => captured.join(''),
    restore: () => spy.mockRestore(),
  };
}

function mockServerStarting() {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/health')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'starting', ready: false }) });
    }
    return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
  });
}

function mockServerRunning(tagResponse = { tags: [{ tag: 'memory', count: 5 }, { tag: 'code', count: 3 }] }) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/health')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'ok', ready: true }) });
    }
    if (String(url).includes('/api/v1/tags')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(tagResponse) });
    }
    if (String(url).includes('/api/v1/update')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'started', workspace: process.cwd() }) });
    }
    if (String(url).includes('/api/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ uptime: 100, ready: true, index: { documentCount: 10, embeddedCount: 8, pendingEmbeddings: 2 } }) });
    }
    return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
  });
}

function mockServerDown() {
  mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockIsInsideContainer.mockReturnValue(false);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── handleTags ─────────────────────────────────────────────────────────────

describe('handleTags — proxy when server running', () => {
  it('calls GET /api/v1/tags instead of opening SQLite', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerRunning();

    const out = captureOutput();
    await handleTags(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    const tagCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/tags'));
    expect(tagCalls.length).toBe(1);
  });

  it('formats tags from server response', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerRunning();

    const out = captureOutput();
    await handleTags(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    const output = out.lines();
    expect(output).toContain('memory');
    expect(output).toContain('5');
    expect(output).toContain('code');
    expect(output).toContain('3');
  });

  it('shows "No tags found" when server returns empty tags', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerRunning({ tags: [] });

    const out = captureOutput();
    await handleTags(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    expect(out.lines()).toContain('No tags found.');
  });
});

describe('handleTags — container mode, server not running', () => {
  it('exits with error and does not fall back to SQLite', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockIsInsideContainer.mockReturnValue(true);
    mockServerDown();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(handleTags(makeOpts(dbPath, configPath))).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const tagCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/tags'));
    expect(tagCalls.length).toBe(0);

    exitSpy.mockRestore();
    cleanup();
  });
});

describe('handleTags — local mode (not container, server not running)', () => {
  it('reads from local SQLite when server is not running', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerDown();

    const store = createStore(dbPath);
    const hash = crypto.createHash('sha256').update('test content').digest('hex');
    store.insertContent(hash, 'test content');
    const docId = store.insertDocument({ collection: 'memory', path: '/test.md', title: 'test', hash, createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), active: true, projectHash: 'abc123' });
    store.insertTags(docId, ['local-tag']);
    store.close();

    const out = captureOutput();
    await handleTags(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    expect(out.lines()).toContain('local-tag');
    const tagCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/tags'));
    expect(tagCalls.length).toBe(0);
  });
});

// ─── handleUpdate ────────────────────────────────────────────────────────────

describe('handleUpdate — proxy when server running', () => {
  it('calls POST /api/update instead of scanning files locally', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerRunning();

    const out = captureOutput();
    await handleUpdate(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    const updateCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/update'));
    expect(updateCalls.length).toBe(1);
    expect(mockFetch.mock.calls.find(([url]) => String(url).includes('/api/v1/update'))?.[1]?.method).toBe('POST');
  });

  it('shows success message after proxy update', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockServerRunning();

    const out = captureOutput();
    await handleUpdate(makeOpts(dbPath, configPath));
    out.restore();
    cleanup();

    expect(out.lines()).not.toContain('Error');
  });
});

describe('handleUpdate — container mode, server not running', () => {
  it('exits with error and does not try to scan local files', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockIsInsideContainer.mockReturnValue(true);
    mockServerDown();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(handleUpdate(makeOpts(dbPath, configPath))).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    cleanup();
  });
});

// ─── handleStatus — container guard ─────────────────────────────────────────

describe('handleStatus — container mode, server not running', () => {
  it('exits with error instead of reading local SQLite', async () => {
    const { dbPath, configPath, cleanup } = makeTempDb();
    mockIsInsideContainer.mockReturnValue(true);
    mockServerDown();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(handleStatus(makeOpts(dbPath, configPath), [])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    cleanup();
  });
});

// ─── server startup UX ───────────────────────────────────────────────────────

import { assertContainerServer } from '../src/cli/utils.js';

describe('detectRunningServer — ready flag', () => {
  it('returns true only when /health responds with ready: true', async () => {
    mockServerRunning();
    const { detectRunningServer } = await import('../src/cli/utils.js');
    const result = await detectRunningServer();
    expect(result).toBe(true);
  });

  it('returns false when /health responds with ready: false (server starting)', async () => {
    mockServerStarting();
    const { detectRunningServer } = await import('../src/cli/utils.js');
    const result = await detectRunningServer();
    expect(result).toBe(false);
  });

  it('returns false when server is completely down', async () => {
    mockServerDown();
    const { detectRunningServer } = await import('../src/cli/utils.js');
    const result = await detectRunningServer();
    expect(result).toBe(false);
  });
});

describe('assertContainerServer — startup hint', () => {
  it('exits with "starting up" message when server is starting (not "not reachable")', async () => {
    mockIsInsideContainer.mockReturnValue(true);
    mockServerStarting();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrLines.push(String(data));
      return true;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(assertContainerServer()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const stderr = stderrLines.join('');
    expect(stderr).toContain('starting up');
    expect(stderr).not.toContain('docker start nano-brain');

    exitSpy.mockRestore();
  });

  it('exits with "not reachable" + docker start hint when server is completely down', async () => {
    mockIsInsideContainer.mockReturnValue(true);
    mockServerDown();

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
      stderrLines.push(String(data));
      return true;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(assertContainerServer()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const stderr = stderrLines.join('');
    expect(stderr).toContain('docker start nano-brain');
    expect(stderr).not.toContain('starting up');

    exitSpy.mockRestore();
  });

  it('returns true and does not exit when server is ready', async () => {
    mockIsInsideContainer.mockReturnValue(true);
    mockServerRunning();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    const result = await assertContainerServer();
    expect(result).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('returns false without exiting when not in container and server is down', async () => {
    mockIsInsideContainer.mockReturnValue(false);
    mockServerDown();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    const result = await assertContainerServer();
    expect(result).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
