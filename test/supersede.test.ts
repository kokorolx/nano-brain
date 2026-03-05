import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, computeHash } from '../src/store.js';
import type { Store } from '../src/types.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Supersede', () => {
  let store: Store;
  let dbPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-supersede-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('supersedeDocument store method', () => {
    it('should set superseded_by on target document', () => {
      const body = '# Original Doc';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      const docId = store.insertDocument({
        collection: 'test',
        path: 'original.md',
        title: 'Original Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      store.supersedeDocument(docId, 0);

      const db = new Database(dbPath);
      const row = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docId) as { superseded_by: number | null };
      expect(row.superseded_by).toBe(0);
      db.close();
    });

    it('should set superseded_by to specific newId', () => {
      const bodyA = '# Doc A';
      const hashA = computeHash(bodyA);
      store.insertContent(hashA, bodyA);
      const docIdA = store.insertDocument({
        collection: 'test',
        path: 'docA.md',
        title: 'Doc A',
        hash: hashA,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const bodyB = '# Doc B';
      const hashB = computeHash(bodyB);
      store.insertContent(hashB, bodyB);
      const docIdB = store.insertDocument({
        collection: 'test',
        path: 'docB.md',
        title: 'Doc B',
        hash: hashB,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      store.supersedeDocument(docIdA, docIdB);

      const db = new Database(dbPath);
      const row = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdA) as { superseded_by: number | null };
      expect(row.superseded_by).toBe(docIdB);
      db.close();
    });
  });

  describe('supersede by path', () => {
    it('should mark document A as superseded when B supersedes A by path', () => {
      const bodyA = '# Document A - Original';
      const hashA = computeHash(bodyA);
      store.insertContent(hashA, bodyA);
      const docIdA = store.insertDocument({
        collection: 'memory',
        path: '/test/docA.md',
        title: 'Document A',
        hash: hashA,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const targetDoc = store.findDocument('/test/docA.md');
      expect(targetDoc).not.toBeNull();
      store.supersedeDocument(targetDoc!.id, 0);

      const db = new Database(dbPath);
      const row = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdA) as { superseded_by: number | null };
      expect(row.superseded_by).toBe(0);
      db.close();
    });
  });

  describe('supersede by docid', () => {
    it('should mark document A as superseded when B supersedes A by docid (6-char hash prefix)', () => {
      const bodyA = '# Document A - For Docid Test';
      const hashA = computeHash(bodyA);
      const docidA = hashA.substring(0, 6);
      store.insertContent(hashA, bodyA);
      const docIdA = store.insertDocument({
        collection: 'memory',
        path: '/test/docid-test.md',
        title: 'Document A Docid',
        hash: hashA,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const targetDoc = store.findDocument(docidA);
      expect(targetDoc).not.toBeNull();
      expect(targetDoc!.id).toBe(docIdA);
      store.supersedeDocument(targetDoc!.id, 0);

      const db = new Database(dbPath);
      const row = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdA) as { superseded_by: number | null };
      expect(row.superseded_by).toBe(0);
      db.close();
    });
  });

  describe('supersede target not found', () => {
    it('should return null when supersede target does not exist', () => {
      const targetDoc = store.findDocument('nonexistent-path.md');
      expect(targetDoc).toBeNull();

      const targetDocByDocid = store.findDocument('abc123');
      expect(targetDocByDocid).toBeNull();
    });
  });

  describe('multi-level chain independence', () => {
    it('should allow A superseded by B, B superseded by C independently', () => {
      const bodyA = '# Doc A - First';
      const hashA = computeHash(bodyA);
      store.insertContent(hashA, bodyA);
      const docIdA = store.insertDocument({
        collection: 'test',
        path: 'chain/a.md',
        title: 'Doc A',
        hash: hashA,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const bodyB = '# Doc B - Second';
      const hashB = computeHash(bodyB);
      store.insertContent(hashB, bodyB);
      const docIdB = store.insertDocument({
        collection: 'test',
        path: 'chain/b.md',
        title: 'Doc B',
        hash: hashB,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const bodyC = '# Doc C - Third';
      const hashC = computeHash(bodyC);
      store.insertContent(hashC, bodyC);
      const docIdC = store.insertDocument({
        collection: 'test',
        path: 'chain/c.md',
        title: 'Doc C',
        hash: hashC,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      store.supersedeDocument(docIdA, docIdB);
      store.supersedeDocument(docIdB, docIdC);

      const db = new Database(dbPath);
      const rowA = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdA) as { superseded_by: number | null };
      const rowB = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdB) as { superseded_by: number | null };
      const rowC = db.prepare('SELECT superseded_by FROM documents WHERE id = ?').get(docIdC) as { superseded_by: number | null };

      expect(rowA.superseded_by).toBe(docIdB);
      expect(rowB.superseded_by).toBe(docIdC);
      expect(rowC.superseded_by).toBeNull();
      db.close();
    });
  });

  describe('superseded_by column exists', () => {
    it('should have superseded_by column in documents table', () => {
      const db = new Database(dbPath);
      const columns = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('superseded_by');
      db.close();
    });
  });
});
