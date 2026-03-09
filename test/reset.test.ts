import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function parseResetFlags(args: string[]) {
  const confirm = args.includes('--confirm');
  const dryRun = args.includes('--dry-run');
  const flagDatabases = args.includes('--databases');
  const flagSessions = args.includes('--sessions');
  const flagMemory = args.includes('--memory');
  const flagLogs = args.includes('--logs');
  const flagVectors = args.includes('--vectors');

  const hasAnyFlag = flagDatabases || flagSessions || flagMemory || flagLogs || flagVectors;
  return {
    confirm,
    dryRun,
    deleteDatabases: !hasAnyFlag || flagDatabases,
    deleteSessions: !hasAnyFlag || flagSessions,
    deleteMemory: !hasAnyFlag || flagMemory,
    deleteLogs: !hasAnyFlag || flagLogs,
    deleteVectors: !hasAnyFlag || flagVectors,
  };
}

describe('Reset Command Flag Parsing', () => {
  describe('category flag selection', () => {
    it('should select all categories when no flags provided', () => {
      const result = parseResetFlags(['--confirm']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(true);
      expect(result.deleteLogs).toBe(true);
      expect(result.deleteVectors).toBe(true);
    });

    it('should select only databases when --databases flag provided', () => {
      const result = parseResetFlags(['--databases', '--confirm']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(false);
      expect(result.deleteMemory).toBe(false);
      expect(result.deleteLogs).toBe(false);
      expect(result.deleteVectors).toBe(false);
    });

    it('should select only sessions when --sessions flag provided', () => {
      const result = parseResetFlags(['--sessions', '--confirm']);
      expect(result.deleteDatabases).toBe(false);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(false);
      expect(result.deleteLogs).toBe(false);
      expect(result.deleteVectors).toBe(false);
    });

    it('should select only memory when --memory flag provided', () => {
      const result = parseResetFlags(['--memory', '--confirm']);
      expect(result.deleteDatabases).toBe(false);
      expect(result.deleteSessions).toBe(false);
      expect(result.deleteMemory).toBe(true);
      expect(result.deleteLogs).toBe(false);
      expect(result.deleteVectors).toBe(false);
    });

    it('should select only logs when --logs flag provided', () => {
      const result = parseResetFlags(['--logs', '--confirm']);
      expect(result.deleteDatabases).toBe(false);
      expect(result.deleteSessions).toBe(false);
      expect(result.deleteMemory).toBe(false);
      expect(result.deleteLogs).toBe(true);
      expect(result.deleteVectors).toBe(false);
    });

    it('should select only vectors when --vectors flag provided', () => {
      const result = parseResetFlags(['--vectors', '--confirm']);
      expect(result.deleteDatabases).toBe(false);
      expect(result.deleteSessions).toBe(false);
      expect(result.deleteMemory).toBe(false);
      expect(result.deleteLogs).toBe(false);
      expect(result.deleteVectors).toBe(true);
    });

    it('should select multiple categories when multiple flags provided', () => {
      const result = parseResetFlags(['--databases', '--sessions', '--confirm']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(false);
      expect(result.deleteLogs).toBe(false);
      expect(result.deleteVectors).toBe(false);
    });

    it('should handle all flags combined', () => {
      const result = parseResetFlags(['--databases', '--sessions', '--memory', '--logs', '--vectors', '--confirm']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(true);
      expect(result.deleteLogs).toBe(true);
      expect(result.deleteVectors).toBe(true);
    });
  });

  describe('confirm and dry-run flags', () => {
    it('should parse --confirm flag', () => {
      const result = parseResetFlags(['--confirm']);
      expect(result.confirm).toBe(true);
      expect(result.dryRun).toBe(false);
    });

    it('should parse --dry-run flag', () => {
      const result = parseResetFlags(['--dry-run']);
      expect(result.confirm).toBe(false);
      expect(result.dryRun).toBe(true);
    });

    it('should parse both --confirm and --dry-run', () => {
      const result = parseResetFlags(['--confirm', '--dry-run']);
      expect(result.confirm).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe('backward compatibility', () => {
    it('should delete all when only --confirm is provided (no category flags)', () => {
      const result = parseResetFlags(['--confirm']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(true);
      expect(result.deleteLogs).toBe(true);
      expect(result.deleteVectors).toBe(true);
    });

    it('should preview all when only --dry-run is provided (no category flags)', () => {
      const result = parseResetFlags(['--dry-run']);
      expect(result.deleteDatabases).toBe(true);
      expect(result.deleteSessions).toBe(true);
      expect(result.deleteMemory).toBe(true);
      expect(result.deleteLogs).toBe(true);
      expect(result.deleteVectors).toBe(true);
    });
  });
});

describe('Reset Command File Deletion', () => {
  let tmpDir: string;
  let dataDir: string;
  let sessionsDir: string;
  let memoryDir: string;
  let logsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-reset-test-'));
    dataDir = path.join(tmpDir, 'data');
    sessionsDir = path.join(tmpDir, 'sessions');
    memoryDir = path.join(tmpDir, 'memory');
    logsDir = path.join(tmpDir, 'logs');
    
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    
    fs.writeFileSync(path.join(dataDir, 'test.sqlite'), 'db content');
    fs.writeFileSync(path.join(sessionsDir, 'session.md'), 'session content');
    fs.writeFileSync(path.join(memoryDir, 'note.md'), 'memory content');
    fs.writeFileSync(path.join(logsDir, 'nano-brain.log'), 'log content');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should delete only databases when --databases flag is used', () => {
    const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
    for (const file of sqliteFiles) {
      fs.unlinkSync(path.join(dataDir, file));
    }
    
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(0);
    expect(fs.existsSync(sessionsDir)).toBe(true);
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('should delete only sessions when --sessions flag is used', () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    
    expect(fs.existsSync(sessionsDir)).toBe(false);
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(1);
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('should delete only memory when --memory flag is used', () => {
    fs.rmSync(memoryDir, { recursive: true, force: true });
    
    expect(fs.existsSync(memoryDir)).toBe(false);
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(1);
    expect(fs.existsSync(sessionsDir)).toBe(true);
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('should delete only logs when --logs flag is used', () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    
    expect(fs.existsSync(logsDir)).toBe(false);
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(1);
    expect(fs.existsSync(sessionsDir)).toBe(true);
    expect(fs.existsSync(memoryDir)).toBe(true);
  });

  it('should delete multiple categories when multiple flags are used', () => {
    const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
    for (const file of sqliteFiles) {
      fs.unlinkSync(path.join(dataDir, file));
    }
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(0);
    expect(fs.existsSync(sessionsDir)).toBe(false);
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('should delete all categories when no flags are provided', () => {
    const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
    for (const file of sqliteFiles) {
      fs.unlinkSync(path.join(dataDir, file));
    }
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
    fs.rmSync(logsDir, { recursive: true, force: true });
    
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'))).toHaveLength(0);
    expect(fs.existsSync(sessionsDir)).toBe(false);
    expect(fs.existsSync(memoryDir)).toBe(false);
    expect(fs.existsSync(logsDir)).toBe(false);
  });
});
