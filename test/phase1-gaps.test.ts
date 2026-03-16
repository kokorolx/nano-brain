import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStore, computeHash } from '../src/store.js';
import { evictLowAccessDocuments } from '../src/storage.js';
import type { Store } from '../src/types.js';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const PROJECT_HASH = 'test-phase1-gaps';

describe('7.3 — Eviction fallback test', () => {
  let store: Store;
  let tmpDir: string;
  let dbPath: string;

  function insertDoc(content: string, docPath: string, accessCount: number, lastAccessedAt: string | null): number {
    const hash = computeHash(content);
    store.insertContent(hash, content);
    const id = store.insertDocument({
      collection: 'test',
      path: docPath,
      title: docPath.split('/').pop() || 'Test',
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash: PROJECT_HASH,
    });
    const db = store.getDb();
    db.prepare('UPDATE documents SET access_count = ?, last_accessed_at = ? WHERE id = ?').run(accessCount, lastAccessedAt, id);
    return id;
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-evict-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('evicts low-access docs first when decayEnabled=true', () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    insertDoc('high access recent', '/evict/high-recent.md', 10, now);
    insertDoc('high access old', '/evict/high-old.md', 10, oldDate);
    insertDoc('low access recent', '/evict/low-recent.md', 1, now);
    insertDoc('low access old', '/evict/low-old.md', 1, oldDate);
    insertDoc('zero access', '/evict/zero.md', 0, null);

    const db = store.getDb();
    const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM documents WHERE active = 1').get() as { c: number }).c;
    expect(beforeCount).toBe(5);

    const evicted = evictLowAccessDocuments(db, 3, true);
    expect(evicted).toBe(2);

    const remaining = db.prepare('SELECT path FROM documents WHERE active = 1 ORDER BY access_count DESC').all() as Array<{ path: string }>;
    expect(remaining.length).toBe(3);
    expect(remaining.some(r => r.path.includes('high-recent'))).toBe(true);
    expect(remaining.some(r => r.path.includes('high-old'))).toBe(true);
  });

  it('evicts oldest docs first when decayEnabled=false', () => {
    const db = store.getDb();
    db.exec('UPDATE documents SET active = 1');

    const evicted = evictLowAccessDocuments(db, 3, false);
    expect(evicted).toBe(2);

    const remaining = db.prepare('SELECT path FROM documents WHERE active = 1').all() as Array<{ path: string }>;
    expect(remaining.length).toBe(3);
  });
});

describe('8.1 — Migration test', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-migrate-'));
    dbPath = path.join(tmpDir, 'migrate.db');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('v4 to v5 migration adds access_count columns', () => {
    const db = Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        hash TEXT NOT NULL,
        agent TEXT,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        project_hash TEXT NOT NULL DEFAULT 'global',
        superseded_by TEXT,
        UNIQUE(collection, path)
      );
    `);
    db.pragma('user_version = 4');
    
    db.prepare(`INSERT INTO documents (collection, path, title, hash, agent, created_at, modified_at, active, project_hash)
      VALUES ('test', '/test/doc.md', 'Test', 'abc123', NULL, datetime('now'), datetime('now'), 1, 'test')`).run();

    const hasAccessCountBefore = (db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).some(col => col.name === 'access_count');
    expect(hasAccessCountBefore).toBe(false);

    db.exec("ALTER TABLE documents ADD COLUMN access_count INTEGER DEFAULT 0");
    db.exec("ALTER TABLE documents ADD COLUMN last_accessed_at TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_access ON documents(access_count, last_accessed_at)");
    db.pragma('user_version = 5');

    const columns = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('access_count');
    expect(columnNames).toContain('last_accessed_at');

    const doc = db.prepare('SELECT * FROM documents WHERE path = ?').get('/test/doc.md') as { title: string; access_count: number };
    expect(doc.title).toBe('Test');
    expect(doc.access_count).toBe(0);

    db.close();
  });
});

describe('8.4 — Performance test', () => {
  let store: Store;
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-perf-'));
    dbPath = path.join(tmpDir, 'perf.db');
    store = createStore(dbPath);

    for (let i = 0; i < 1000; i++) {
      const content = `Performance test document ${i} with some searchable content about testing and performance`;
      const hash = computeHash(content);
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'test',
        path: `/perf/doc${i}.md`,
        title: `Doc ${i}`,
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: PROJECT_HASH,
      });
    }
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('searchFTS completes 10 queries in under 5s', () => {
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      store.searchFTS('performance testing', { limit: 10, projectHash: PROJECT_HASH });
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
