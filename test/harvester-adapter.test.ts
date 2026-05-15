import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
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

  it('returns empty array when no adapters provided', async () => {
    const result = await runHarvestCycle([], outputDir);
    expect(result).toEqual([]);
  });
});
