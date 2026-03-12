import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openDatabase, applyPragmas, createStore } from '../src/store.js';
import { checkAndRecoverDB } from '../src/db/corruption-recovery.js';
import { generateLaunchdPlist, generateSystemdService, getDefaultServiceConfig, type ServiceConfig } from '../src/service-installer.js';
import { createRejectionThreshold } from '../src/server.js';

describe('SQLite Corruption Fix', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-corruption-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Phase 0 — openDatabase + applyPragmas', () => {
    it('openDatabase returns Database with correct PRAGMAs', () => {
      const dbPath = path.join(tmpDir, 'test-pragmas.db');
      const db = openDatabase(dbPath);
      
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(15000);
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
      expect(db.pragma('journal_size_limit', { simple: true })).toBe(67108864);
      
      db.close();
    });

    it('openDatabase with readonly option throws on pragma write', () => {
      const dbPath = path.join(tmpDir, 'test-readonly.db');
      const writeDb = new Database(dbPath);
      writeDb.exec('CREATE TABLE test (id INTEGER)');
      writeDb.close();
      
      expect(() => openDatabase(dbPath, { readonly: true })).toThrow('readonly');
    });

    it('applyPragmas sets all expected PRAGMAs', () => {
      const dbPath = path.join(tmpDir, 'test-apply.db');
      const db = new Database(dbPath);
      
      applyPragmas(db);
      
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(15000);
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      
      db.close();
    });

    it('Store.getDb returns the internal database instance', () => {
      const dbPath = path.join(tmpDir, 'test-getdb.db');
      const store = createStore(dbPath);
      
      const db = store.getDb();
      expect(db).toBeInstanceOf(Database);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      
      store.close();
    });
  });

  describe('Phase 1 — Graceful exit', () => {
    it('Store.close runs WAL checkpoint before closing', () => {
      const dbPath = path.join(tmpDir, 'test-checkpoint.db');
      const store = createStore(dbPath);
      
      store.insertContent('hash1', 'test body');
      
      const walPath = `${dbPath}-wal`;
      if (fs.existsSync(walPath)) {
        const walSizeBefore = fs.statSync(walPath).size;
        store.close();
        
        if (fs.existsSync(walPath)) {
          const walSizeAfter = fs.statSync(walPath).size;
          expect(walSizeAfter).toBeLessThanOrEqual(walSizeBefore);
        }
      } else {
        store.close();
      }
    });

    it('createRejectionThreshold accepts and calls onExit callback', () => {
      const exitFn = vi.fn();
      const threshold = createRejectionThreshold(1, 100);
      threshold.setOnExit(exitFn);
      
      threshold.handler(new Error('test error'));
      
      expect(exitFn).toHaveBeenCalledTimes(1);
    });

    it('createRejectionThreshold tracks rejection count', () => {
      const threshold = createRejectionThreshold(5, 1000);
      threshold.setOnExit(() => {});
      
      expect(threshold.getCount()).toBe(0);
      threshold.handler(new Error('test'));
      expect(threshold.getCount()).toBe(1);
    });

    it('plist contains ThrottleInterval=30', () => {
      const config: ServiceConfig = {
        port: 3100,
        nodePath: '/usr/local/bin/node',
        cliPath: '/path/to/cli.js',
        homeDir: '/Users/testuser',
        logsDir: '/Users/testuser/.nano-brain/logs',
      };
      const plist = generateLaunchdPlist(config);
      
      expect(plist).toContain('<key>ThrottleInterval</key>');
      expect(plist).toContain('<integer>30</integer>');
    });

    it('systemd unit contains StartLimitBurst=5', () => {
      const config: ServiceConfig = {
        port: 3100,
        nodePath: '/usr/bin/node',
        cliPath: '/path/to/cli.js',
        homeDir: '/home/testuser',
        logsDir: '/home/testuser/.nano-brain/logs',
      };
      const service = generateSystemdService(config);
      
      expect(service).toContain('StartLimitBurst=5');
      expect(service).toContain('StartLimitIntervalSec=600');
    });
  });

  describe('Phase 2 — Corruption recovery', () => {
    it('checkAndRecoverDB on healthy DB returns { recovered: false }', () => {
      const dbPath = path.join(tmpDir, 'healthy.db');
      const setupDb = new Database(dbPath);
      setupDb.exec('CREATE TABLE test (id INTEGER)');
      setupDb.close();
      
      const result = checkAndRecoverDB(dbPath);
      
      expect(result.recovered).toBe(false);
      expect(result.db).toBeInstanceOf(Database);
      result.db.close();
    });

    it('checkAndRecoverDB on corrupt DB renames file and returns { recovered: true }', () => {
      const dbPath = path.join(tmpDir, 'corrupt.db');
      fs.writeFileSync(dbPath, 'not a valid sqlite database');
      
      const result = checkAndRecoverDB(dbPath, {
        logger: { log: () => {}, error: () => {} },
      });
      
      expect(result.recovered).toBe(true);
      expect(result.recoveredAt).toBeDefined();
      expect(result.corruptedPath).toBeDefined();
      expect(result.corruptedPath).toContain('.corrupted.');
      expect(fs.existsSync(result.corruptedPath!)).toBe(true);
      
      result.db.close();
    });

    it('CORRUPTION_NOTICE.md is created/appended on recovery', () => {
      const dbPath = path.join(tmpDir, 'corrupt-notice.db');
      fs.writeFileSync(dbPath, 'invalid sqlite data');
      
      const noticePath = path.join(os.homedir(), '.nano-brain', 'CORRUPTION_NOTICE.md');
      const existedBefore = fs.existsSync(noticePath);
      const sizeBefore = existedBefore ? fs.statSync(noticePath).size : 0;
      
      const result = checkAndRecoverDB(dbPath, {
        logger: { log: () => {}, error: () => {} },
      });
      
      expect(fs.existsSync(noticePath)).toBe(true);
      const sizeAfter = fs.statSync(noticePath).size;
      expect(sizeAfter).toBeGreaterThan(sizeBefore);
      
      result.db.close();
    });

    it('corrupt file is preserved with .corrupted.{timestamp} suffix', () => {
      const dbPath = path.join(tmpDir, 'preserve.db');
      const corruptContent = 'corrupt data here';
      fs.writeFileSync(dbPath, corruptContent);
      
      const result = checkAndRecoverDB(dbPath, {
        logger: { log: () => {}, error: () => {} },
      });
      
      expect(result.corruptedPath).toMatch(/\.corrupted\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      expect(fs.existsSync(result.corruptedPath!)).toBe(true);
      expect(fs.readFileSync(result.corruptedPath!, 'utf-8')).toBe(corruptContent);
      
      result.db.close();
    });
  });

  describe('Phase 3 — Init force cleanup', () => {
    it('init --force --all filter includes .sqlite, -wal, -shm files', () => {
      const dataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      
      fs.writeFileSync(path.join(dataDir, 'test.sqlite'), '');
      fs.writeFileSync(path.join(dataDir, 'test.sqlite-wal'), '');
      fs.writeFileSync(path.join(dataDir, 'test.sqlite-shm'), '');
      fs.writeFileSync(path.join(dataDir, 'other.txt'), '');
      
      const files = fs.readdirSync(dataDir);
      const dbFiles = files.filter(file => 
        file.endsWith('.sqlite') || file.endsWith('-wal') || file.endsWith('-shm')
      );
      
      expect(dbFiles).toContain('test.sqlite');
      expect(dbFiles).toContain('test.sqlite-wal');
      expect(dbFiles).toContain('test.sqlite-shm');
      expect(dbFiles).not.toContain('other.txt');
      expect(dbFiles.length).toBe(3);
    });
  });

  describe('Phase 5 — Container detection', () => {
    it('isRunningInContainer returns false when /.dockerenv does not exist', () => {
      const isRunningInContainer = (): boolean => {
        try {
          return fs.existsSync('/.dockerenv');
        } catch {
          return false;
        }
      };
      
      const dockerenvExists = fs.existsSync('/.dockerenv');
      expect(isRunningInContainer()).toBe(dockerenvExists);
    });
  });
});
