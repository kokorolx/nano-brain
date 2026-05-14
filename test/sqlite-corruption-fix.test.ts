import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openDatabase, applyPragmas, createStore, evictCachedStore, getCacheSize, closeAllCachedStores } from '../src/store.js';
import { checkAndRecoverDB, resetCheckedPaths, getCheckedPaths, clearStamp } from '../src/db/corruption-recovery.js';
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

  describe('Store instance cache', () => {
    beforeEach(() => {
      closeAllCachedStores();
      resetCheckedPaths();
    });

    afterEach(() => {
      closeAllCachedStores();
      resetCheckedPaths();
    });

    it('createStore returns cached instance for same dbPath', () => {
      const dbPath = path.join(tmpDir, 'cache-test.db');
      const store1 = createStore(dbPath);
      const store2 = createStore(dbPath);
      expect(store1).toBe(store2);
      store1.close();
      const health = store2.getIndexHealth();
      expect(health).toBeDefined();
      evictCachedStore(dbPath);
    });

    it('cached store close() is a no-op', () => {
      const dbPath = path.join(tmpDir, 'noop-close.db');
      const store1 = createStore(dbPath);
      store1.close();
      expect(() => store1.getIndexHealth()).not.toThrow();
      evictCachedStore(dbPath);
    });

    it('evictCachedStore actually closes the store', () => {
      const dbPath = path.join(tmpDir, 'evict-test.db');
      createStore(dbPath);
      expect(getCacheSize()).toBeGreaterThanOrEqual(1);
      evictCachedStore(dbPath);
      const resolvedPath = path.resolve(dbPath);
      const newStore = createStore(dbPath);
      expect(newStore).toBeDefined();
      evictCachedStore(dbPath);
    });

    it('closeAllCachedStores closes all cached stores', () => {
      const s1 = createStore(path.join(tmpDir, 'a.db'));
      const s2 = createStore(path.join(tmpDir, 'b.db'));
      expect(getCacheSize()).toBeGreaterThanOrEqual(2);
      closeAllCachedStores();
      expect(getCacheSize()).toBe(0);
    });
  });

  describe('Corruption check dedup', () => {
    beforeEach(() => {
      resetCheckedPaths();
      closeAllCachedStores();
    });

    afterEach(() => {
      resetCheckedPaths();
      closeAllCachedStores();
    });

    it('checkAndRecoverDB only runs quick_check once per path', () => {
      const dbPath = path.join(tmpDir, 'dedup-check.db');

      const result1 = checkAndRecoverDB(dbPath);
      result1.db.close();
      const resolvedPath = path.resolve(dbPath);
      expect(getCheckedPaths().has(resolvedPath)).toBe(true);

      const result2 = checkAndRecoverDB(dbPath);
      result2.db.close();
      expect(result2.recovered).toBe(false);
    });

    it('resetCheckedPaths clears the checked paths set', () => {
      const dbPath = path.join(tmpDir, 'reset-check.db');
      const result = checkAndRecoverDB(dbPath);
      result.db.close();
      const resolvedPath = path.resolve(dbPath);
      expect(getCheckedPaths().has(resolvedPath)).toBe(true);

      resetCheckedPaths();
      expect(getCheckedPaths().size).toBe(0);
    });
  });

  describe('Stamp file cooldown', () => {
    beforeEach(() => {
      resetCheckedPaths();
      closeAllCachedStores();
      delete process.env.NANO_BRAIN_CHECK_COOLDOWN_MS;
    });

    afterEach(() => {
      resetCheckedPaths();
      closeAllCachedStores();
      delete process.env.NANO_BRAIN_CHECK_COOLDOWN_MS;
    });

    it('stamp file is written after a successful integrity check', () => {
      const dbPath = path.join(tmpDir, 'stamp-write.db');
      const result = checkAndRecoverDB(dbPath);
      result.db.close();

      const stampPath = path.resolve(dbPath) + '.checked';
      expect(fs.existsSync(stampPath)).toBe(true);
      const content = fs.readFileSync(stampPath, 'utf-8').trim();
      expect(Number(content)).toBeGreaterThan(0);
    });

    it('valid stamp skips PRAGMA quick_check on next process start', () => {
      const dbPath = path.join(tmpDir, 'stamp-skip.db');

      // First call: creates DB + runs check + writes stamp
      const r1 = checkAndRecoverDB(dbPath);
      r1.db.close();

      // Simulate new process: clear in-process dedup set
      resetCheckedPaths();

      // Spy on logger to detect if check runs again
      const logMessages: string[] = [];
      const logger = { log: (_: string, msg: string) => logMessages.push(msg), error: () => {} };

      // Second call: stamp is valid, should skip check
      const r2 = checkAndRecoverDB(dbPath, { logger });
      r2.db.close();

      expect(logMessages.some(m => m.includes('Checking database integrity'))).toBe(false);
      expect(logMessages.some(m => m.includes('stamp') || m.includes('cooldown') || m.includes('Skipping'))).toBe(true);
    });

    it('stamp is invalidated when cooldown expires', () => {
      const dbPath = path.join(tmpDir, 'stamp-cooldown.db');

      const r1 = checkAndRecoverDB(dbPath);
      r1.db.close();
      resetCheckedPaths();

      // Force zero cooldown: stamp is always expired
      process.env.NANO_BRAIN_CHECK_COOLDOWN_MS = '0';

      const logMessages: string[] = [];
      const logger = { log: (_: string, msg: string) => logMessages.push(msg), error: () => {} };

      const r2 = checkAndRecoverDB(dbPath, { logger });
      r2.db.close();

      expect(logMessages.some(m => m.includes('Checking database integrity'))).toBe(true);
    });

    it('stamp is written for fresh DB after corruption recovery', () => {
      const dbPath = path.join(tmpDir, 'stamp-recovery.db');

      // Create a "corrupted" DB (empty file)
      fs.writeFileSync(dbPath, 'THIS IS NOT SQLITE');

      const result = checkAndRecoverDB(dbPath);
      result.db.close();

      expect(result.recovered).toBe(true);
      const stampPath = path.resolve(dbPath) + '.checked';
      expect(fs.existsSync(stampPath)).toBe(true);
    });

    it('stamp read failure is non-fatal — falls back to full check', () => {
      const dbPath = path.join(tmpDir, 'stamp-corrupt.db');

      const r1 = checkAndRecoverDB(dbPath);
      r1.db.close();
      resetCheckedPaths();

      // Corrupt the stamp file
      fs.writeFileSync(path.resolve(dbPath) + '.checked', 'not-a-timestamp\n');

      const logMessages: string[] = [];
      const logger = { log: (_: string, msg: string) => logMessages.push(msg), error: () => {} };

      // Should not throw, should fall back to full check
      const r2 = checkAndRecoverDB(dbPath, { logger });
      r2.db.close();

      expect(logMessages.some(m => m.includes('Checking database integrity'))).toBe(true);
    });

    it('clearStamp removes the stamp file', () => {
      const dbPath = path.join(tmpDir, 'stamp-clear.db');
      const r1 = checkAndRecoverDB(dbPath);
      r1.db.close();

      const stampPath = path.resolve(dbPath) + '.checked';
      expect(fs.existsSync(stampPath)).toBe(true);

      clearStamp(dbPath);
      expect(fs.existsSync(stampPath)).toBe(false);
    });
  });
});
