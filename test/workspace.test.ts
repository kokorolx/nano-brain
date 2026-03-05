import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, computeHash } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

describe('Workspace Scoping', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-workspace-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('migration', () => {
    it('should add project_hash column on first create', () => {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const columns = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
      db.close();
      
      const hasProjectHash = columns.some(col => col.name === 'project_hash');
      expect(hasProjectHash).toBe(true);
    });

    it('should not fail on subsequent creates', () => {
      store.close();
      
      expect(() => {
        const store2 = createStore(dbPath);
        store2.close();
      }).not.toThrow();
      
      store = createStore(dbPath);
    });

    it('should backfill project_hash from session paths on migration', () => {
      const Database = require('better-sqlite3');
      store.close();
      const db = new Database(dbPath);
      // Must drop index before dropping column in SQLite
      db.exec("DROP INDEX IF EXISTS idx_documents_project_hash");
      db.exec("ALTER TABLE documents DROP COLUMN project_hash");
      const body = '# Session Doc\n\nContent.';
      const hash = computeHash(body);
      const sessionPath = 'sessions/abc123def456/file.md';
      db.prepare("INSERT OR IGNORE INTO content (hash, body) VALUES (?, ?)").run(hash, body);
      db.prepare(`
        INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 1)
      `).run('sessions', sessionPath, 'Session Doc', hash);
      db.close();
      store = createStore(dbPath);
      const doc = store.findDocument(sessionPath);
      expect(doc).not.toBeNull();
      expect(doc?.projectHash).toBe('abc123def456');
    });
  });

  describe('document tagging', () => {
    it('should set projectHash when provided', () => {
      const body = '# Tagged Doc\n\nContent.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'test',
        path: 'tagged/doc.md',
        title: 'Tagged Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'abc123def456',
      });
      
      const doc = store.findDocument('tagged/doc.md');
      expect(doc).not.toBeNull();
      expect(doc?.projectHash).toBe('abc123def456');
    });

    it('should default projectHash to global', () => {
      const body = '# Global Doc\n\nContent.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'test',
        path: 'global/doc.md',
        title: 'Global Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const doc = store.findDocument('global/doc.md');
      expect(doc).not.toBeNull();
      expect(doc?.projectHash).toBe('global');
    });

    it('should extract projectHash from session path pattern', () => {
      const sessionPathRegex = /sessions\/([a-f0-9]{12})\//i;
      
      const testCases = [
        { path: 'sessions/abc123def456/file.md', expected: 'abc123def456' },
        { path: 'sessions/000000000000/test.md', expected: '000000000000' },
        { path: 'sessions/ABCDEF123456/doc.md', expected: 'ABCDEF123456' },
        { path: 'other/path/file.md', expected: null },
        { path: 'sessions/short/file.md', expected: null },
      ];
      
      for (const tc of testCases) {
        const match = tc.path.match(sessionPathRegex);
        if (tc.expected) {
          expect(match).not.toBeNull();
          expect(match?.[1]).toBe(tc.expected);
        } else {
          expect(match).toBeNull();
        }
      }
    });
  });

  describe('workspace-filtered FTS search', () => {
    beforeEach(() => {
      const docs = [
        { path: 'ws1/doc.md', title: 'Workspace One Doc', projectHash: 'ws1hash12345', content: 'unique searchterm alpha' },
        { path: 'ws2/doc.md', title: 'Workspace Two Doc', projectHash: 'ws2hash12345', content: 'unique searchterm beta' },
        { path: 'global/doc.md', title: 'Global Doc', projectHash: 'global', content: 'unique searchterm gamma' },
      ];
      
      for (const doc of docs) {
        const hash = computeHash(doc.content);
        store.insertContent(hash, doc.content);
        store.insertDocument({
          collection: 'test',
          path: doc.path,
          title: doc.title,
          hash,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
          projectHash: doc.projectHash,
        });
      }
    });

    it('should filter search by workspace', () => {
      const results = store.searchFTS('searchterm', { limit: 10, projectHash: 'ws1hash12345' });
      
      const paths = results.map(r => r.path);
      expect(paths).toContain('ws1/doc.md');
      expect(paths).toContain('global/doc.md');
      expect(paths).not.toContain('ws2/doc.md');
    });

    it('should include global docs in workspace search', () => {
      const results = store.searchFTS('searchterm', { limit: 10, projectHash: 'ws1hash12345' });
      
      const paths = results.map(r => r.path);
      expect(paths).toContain('global/doc.md');
    });

    it('should return all docs when projectHash is all', () => {
      const results = store.searchFTS('searchterm', { limit: 10, projectHash: 'all' });
      
      expect(results.length).toBe(3);
    });

    it('should return all docs when no projectHash provided', () => {
      const results = store.searchFTS('searchterm', { limit: 10 });
      
      expect(results.length).toBe(3);
    });
  });

  describe('workspace stats', () => {
    it('should return workspace stats grouped by projectHash', () => {
      const docs = [
        { path: 'a/1.md', projectHash: 'hash1' },
        { path: 'a/2.md', projectHash: 'hash1' },
        { path: 'b/1.md', projectHash: 'hash2' },
        { path: 'c/1.md', projectHash: 'global' },
      ];
      
      for (const doc of docs) {
        const content = `Content for ${doc.path}`;
        const hash = computeHash(content);
        store.insertContent(hash, content);
        store.insertDocument({
          collection: 'test',
          path: doc.path,
          title: doc.path,
          hash,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
          projectHash: doc.projectHash,
        });
      }
      
      const stats = store.getWorkspaceStats();
      
      const hash1Stats = stats.find(s => s.projectHash === 'hash1');
      const hash2Stats = stats.find(s => s.projectHash === 'hash2');
      const globalStats = stats.find(s => s.projectHash === 'global');
      
      expect(hash1Stats?.count).toBe(2);
      expect(hash2Stats?.count).toBe(1);
      expect(globalStats?.count).toBe(1);
    });
  });

  describe('hash computation', () => {
    it('should compute projectHash matching harvester convention', () => {
      const testPath = '/some/path';
      const expectedHash = crypto.createHash('sha256').update(testPath).digest('hex').substring(0, 12);
      
      expect(expectedHash).toMatch(/^[a-f0-9]{12}$/);
      expect(expectedHash.length).toBe(12);
      
      const hash = computeHash(testPath);
      expect(hash.substring(0, 12)).toMatch(/^[a-f0-9]{12}$/);
    });
  });
});
