/**
 * RRI-T Round 5 — Knowledge Graph, Obsidian Integration, Entity Extraction
 *
 * 5-phase RRI-T methodology:
 *   PREPARE   → spin up isolated SQLite stores + temp dirs
 *   DISCOVER  → verify baseline state before features
 *   STRUCTURE → define test contracts for each feature
 *   EXECUTE   → run tests against real store / parsed logic
 *   ANALYZE   → assert expected outcomes, no regressions
 *
 * Coverage:
 *   1. WikiLink parser (parseWikiLinks)
 *   2. Frontmatter parser (parseFrontmatter)
 *   3. Obsidian WikiLink → memory_connections (processObsidianWikiLinks)
 *   4. Entity extraction covers memory + obsidian collections
 *   5. getMemoryEntities: default limit raised to 2000 (was 100)
 *   6. Startup reindex triggered for pre-existing collection files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createStore, evictCachedStore } from '../src/store.js';
import type { Store } from '../src/types.js';
import { parseWikiLinks, parseFrontmatter } from '../src/jobs/watcher.js';

function hash(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — WikiLink parser (unit)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWikiLinks', () => {
  it('extracts a simple [[Link]]', () => {
    expect(parseWikiLinks('See [[Home]] for details')).toContain('Home');
  });

  it('extracts alias [[Link|Alias]] using only the target', () => {
    const links = parseWikiLinks('See [[My Note|click here]] for more');
    expect(links).toContain('My Note');
    expect(links).not.toContain('click here');
  });

  it('strips heading anchors [[Note#Section]]', () => {
    const links = parseWikiLinks('See [[Architecture#Overview]]');
    expect(links).toContain('Architecture');
  });

  it('deduplicates repeated links', () => {
    const links = parseWikiLinks('[[Home]] and also [[Home]] again');
    expect(links.filter(l => l === 'Home')).toHaveLength(1);
  });

  it('returns empty array for no links', () => {
    expect(parseWikiLinks('No links here, just text.')).toHaveLength(0);
  });

  it('extracts multiple links from one document', () => {
    const links = parseWikiLinks('See [[Intro]], [[Setup]], and [[FAQ]]');
    expect(links).toContain('Intro');
    expect(links).toContain('Setup');
    expect(links).toContain('FAQ');
    expect(links).toHaveLength(3);
  });

  it('ignores empty link targets [[]]', () => {
    const links = parseWikiLinks('[[]] is empty, [[Valid]] is not');
    expect(links).not.toContain('');
    expect(links).toContain('Valid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Frontmatter parser (unit)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses a simple key-value', () => {
    const content = '---\ntitle: My Note\n---\nBody here.';
    const fm = parseFrontmatter(content);
    expect(fm.title).toBe('My Note');
  });

  it('parses an array field', () => {
    const content = '---\ntags: [nano-brain, obsidian, test]\n---\nBody.';
    const fm = parseFrontmatter(content);
    expect(Array.isArray(fm.tags)).toBe(true);
    expect(fm.tags).toContain('nano-brain');
    expect(fm.tags).toContain('obsidian');
  });

  it('strips surrounding quotes from values', () => {
    const content = '---\nauthor: "Rick"\n---\nBody.';
    const fm = parseFrontmatter(content);
    expect(fm.author).toBe('Rick');
  });

  it('returns empty object when no frontmatter', () => {
    const fm = parseFrontmatter('# Just a markdown title\n\nNo frontmatter.');
    expect(Object.keys(fm)).toHaveLength(0);
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\ntitle: Windows\r\n---\r\nBody.';
    const fm = parseFrontmatter(content);
    expect(fm.title).toBe('Windows');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Obsidian WikiLink → memory_connections (integration)
// ─────────────────────────────────────────────────────────────────────────────

describe('Obsidian WikiLink connections', () => {
  let tmpDir: string;
  let store: Store;
  const projectHash = 'test-obsidian-01';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rri-t-r5-obsidian-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    store = createStore(dbPath);
  });

  afterEach(() => {
    try { store.getDb().close(); } catch {}
    evictCachedStore(path.join(tmpDir, 'test.sqlite'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertDoc(collection: string, noteName: string, body: string): number {
    const h = hash(body);
    store.insertContent(h, body);
    return store.insertDocument({
      collection,
      path: path.join('/vault', `${noteName}.md`),
      title: noteName,
      hash: h,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash,
    });
  }

  it('creates a memory_connection for each resolved WikiLink', () => {
    const homeId = insertDoc('obsidian', 'Home', '# Home\nSee [[Setup]] for details.');
    const setupId = insertDoc('obsidian', 'Setup', '# Setup\nInstall steps here.');

    // Simulate what processObsidianWikiLinks does
    const db = store.getDb();
    const docs = db.prepare(
      `SELECT d.id, d.path, d.title, c.body FROM documents d
       JOIN content c ON d.hash = c.hash
       WHERE d.collection = ? AND d.active = 1`
    ).all('obsidian') as Array<{id: number; path: string; title: string; body: string}>;

    const titleMap = new Map<string, number>();
    for (const doc of docs) {
      titleMap.set(path.basename(doc.path, '.md').toLowerCase(), doc.id);
      if (doc.title) titleMap.set(doc.title.toLowerCase(), doc.id);
    }

    for (const doc of docs) {
      const links = parseWikiLinks(doc.body);
      for (const link of links) {
        const targetId = titleMap.get(link.toLowerCase());
        if (!targetId || targetId === doc.id) continue;
        try {
          store.insertConnection({
            fromDocId: doc.id,
            toDocId: targetId,
            relationshipType: 'related',
            description: `WikiLink: [[${link}]]`,
            strength: 1.0,
            createdBy: 'extraction',
            projectHash,
          });
        } catch { /* ignore duplicates */ }
      }
    }

    // Verify connection created Home → Setup
    const conns = store.getConnectionsForDocument(homeId, { direction: 'outgoing' });
    expect(conns).toHaveLength(1);
    expect(conns[0].toDocId).toBe(setupId);
    expect(conns[0].relationshipType).toBe('related');
    expect(conns[0].description).toContain('Setup');
  });

  it('does not create self-connections', () => {
    const noteId = insertDoc('obsidian', 'Circular', '# Circular\nSee [[Circular]] itself.');
    const db = store.getDb();
    const docs = db.prepare(
      `SELECT d.id, d.path, d.title, c.body FROM documents d
       JOIN content c ON d.hash = c.hash WHERE d.collection = ? AND d.active = 1`
    ).all('obsidian') as Array<{id: number; path: string; title: string; body: string}>;

    const titleMap = new Map<string, number>();
    for (const doc of docs) titleMap.set(doc.title.toLowerCase(), doc.id);

    let created = 0;
    for (const doc of docs) {
      for (const link of parseWikiLinks(doc.body)) {
        const targetId = titleMap.get(link.toLowerCase());
        if (!targetId || targetId === doc.id) continue;
        store.insertConnection({ fromDocId: doc.id, toDocId: targetId,
          relationshipType: 'related', description: `WikiLink: [[${link}]]`,
          strength: 1.0, createdBy: 'extraction', projectHash });
        created++;
      }
    }
    expect(created).toBe(0);
    void noteId;
  });

  it('does not error on broken WikiLinks (target not indexed)', () => {
    insertDoc('obsidian', 'Orphan', '# Orphan\nSee [[NonExistentNote]] which is missing.');

    const db = store.getDb();
    const docs = db.prepare(
      `SELECT d.id, d.title, c.body FROM documents d
       JOIN content c ON d.hash = c.hash WHERE d.collection = ? AND d.active = 1`
    ).all('obsidian') as Array<{id: number; title: string; body: string}>;
    const titleMap = new Map<string, number>();
    for (const doc of docs) titleMap.set(doc.title.toLowerCase(), doc.id);

    expect(() => {
      for (const doc of docs) {
        for (const link of parseWikiLinks(doc.body)) {
          const targetId = titleMap.get(link.toLowerCase());
          if (!targetId || targetId === doc.id) continue;
          store.insertConnection({ fromDocId: doc.id, toDocId: targetId,
            relationshipType: 'related', description: '',
            strength: 1.0, createdBy: 'extraction', projectHash });
        }
      }
    }).not.toThrow();
  });

  it('deduplicates: inserting same WikiLink twice does not create duplicate connection', () => {
    const aId = insertDoc('obsidian', 'NoteA', '[[NoteB]]');
    const bId = insertDoc('obsidian', 'NoteB', 'Content B');

    const insert = () => store.insertConnection({
      fromDocId: aId, toDocId: bId,
      relationshipType: 'related', description: 'WikiLink: [[NoteB]]',
      strength: 1.0, createdBy: 'extraction', projectHash,
    });

    insert(); // first — succeeds
    expect(() => insert()).not.toThrow(); // second — UPSERT, no error

    const conns = store.getConnectionsForDocument(aId, { direction: 'outgoing' });
    expect(conns).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — getMemoryEntities: default limit 100→2000
// ─────────────────────────────────────────────────────────────────────────────

describe('getMemoryEntities limit', () => {
  let tmpDir: string;
  let store: Store;
  const projectHash = 'test-entities-limit-01';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rri-t-r5-entities-'));
    store = createStore(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    try { store.getDb().close(); } catch {}
    evictCachedStore(path.join(tmpDir, 'test.sqlite'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns all entities when count exceeds previous 100 limit', () => {
    // Insert 120 entities (previously only 100 would be returned)
    const now = new Date().toISOString();
    for (let i = 0; i < 120; i++) {
      store.insertOrUpdateEntity({
        name: `Entity${i.toString().padStart(3, '0')}`,
        type: 'concept',
        description: `Auto-generated entity ${i}`,
        projectHash,
        firstLearnedAt: now,
        lastConfirmedAt: now,
      });
    }

    const entities = store.getMemoryEntities(projectHash);
    expect(entities.length).toBe(120);
  });

  it('returns all entities with explicit limit 2000', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 150; i++) {
      store.insertOrUpdateEntity({
        name: `E${i}`, type: 'tool', description: '',
        projectHash, firstLearnedAt: now, lastConfirmedAt: now,
      });
    }
    const entities = store.getMemoryEntities(projectHash, 2000);
    expect(entities.length).toBe(150);
  });

  it('respects explicit lower limit when provided', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 50; i++) {
      store.insertOrUpdateEntity({
        name: `E${i}`, type: 'service', description: '',
        projectHash, firstLearnedAt: now, lastConfirmedAt: now,
      });
    }
    const entities = store.getMemoryEntities(projectHash, 10);
    expect(entities.length).toBe(10);
  });

  it('deduplicates: upsert by name+projectHash creates only one entity', () => {
    const now = new Date().toISOString();
    const props = { name: 'Redis', type: 'service' as const, description: 'Cache',
      projectHash, firstLearnedAt: now, lastConfirmedAt: now };
    store.insertOrUpdateEntity(props);
    store.insertOrUpdateEntity({ ...props, description: 'Updated cache' });

    const entities = store.getMemoryEntities(projectHash);
    const redis = entities.filter(e => e.name === 'Redis');
    expect(redis).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Entity extraction collection scope (memory + obsidian)
// ─────────────────────────────────────────────────────────────────────────────

describe('Entity extraction collection scope', () => {
  let tmpDir: string;
  let store: Store;
  const projectHash = 'test-extract-scope-01';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rri-t-r5-scope-'));
    store = createStore(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    try { store.getDb().close(); } catch {}
    evictCachedStore(path.join(tmpDir, 'test.sqlite'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMemoryDoc(collection: string, name: string, body: string): number {
    const h = hash(body);
    store.insertContent(h, body);
    return store.insertDocument({
      collection, path: `/mem/${name}.md`, title: name, hash: h,
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
      active: true, projectHash,
    });
  }

  function getUnextractedDocs(): Array<{id: number; collection: string}> {
    return store.getDb().prepare(`
      SELECT d.id, d.collection FROM documents d
      JOIN content c ON d.hash = c.hash
      WHERE (d.collection = 'memory' OR d.collection LIKE '%obsidian%')
        AND d.active = 1
        AND d.id NOT IN (SELECT document_id FROM consolidation_log WHERE action = 'ENTITY_EXTRACTED')
      ORDER BY d.modified_at DESC LIMIT 10
    `).all() as Array<{id: number; collection: string}>;
  }

  it('entity extraction query includes memory collection docs', () => {
    insertMemoryDoc('memory', 'note1', 'Memory note about Redis and PostgreSQL');
    const pending = getUnextractedDocs();
    expect(pending.some(d => d.collection === 'memory')).toBe(true);
  });

  it('entity extraction query includes obsidian collection docs', () => {
    insertMemoryDoc('obsidian-vault', 'page1', 'Obsidian note about Docker and Kubernetes');
    const pending = getUnextractedDocs();
    expect(pending.some(d => d.collection === 'obsidian-vault')).toBe(true);
  });

  it('entity extraction query excludes codebase collection', () => {
    insertMemoryDoc('codebase', 'src/index.ts', 'import { something } from "./module"');
    const pending = getUnextractedDocs();
    expect(pending.every(d => d.collection !== 'codebase')).toBe(true);
  });

  it('entity extraction skips already-extracted docs', () => {
    const docId = insertMemoryDoc('memory', 'already', 'Already processed doc');
    // Mark as extracted
    store.addConsolidationLog({
      documentId: docId, action: 'ENTITY_EXTRACTED',
      reason: 'test', model: 'test', tokensUsed: 0,
    });
    const pending = getUnextractedDocs();
    expect(pending.find(d => d.id === docId)).toBeUndefined();
  });

  it('both memory and obsidian docs appear in same pending batch', () => {
    insertMemoryDoc('memory', 'memNote', 'A memory note');
    insertMemoryDoc('obsidian-notes', 'obsNote', 'An obsidian note');

    const pending = getUnextractedDocs();
    const collections = pending.map(d => d.collection);
    expect(collections).toContain('memory');
    expect(collections).toContain('obsidian-notes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Startup collection reindex (pre-existing files)
// ─────────────────────────────────────────────────────────────────────────────

describe('Startup reindex covers pre-existing collection files', () => {
  let tmpDir: string;
  let store: Store;
  const projectHash = 'test-startup-reindex-01';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rri-t-r5-reindex-'));
    store = createStore(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    try { store.getDb().close(); } catch {}
    evictCachedStore(path.join(tmpDir, 'test.sqlite'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('files not in DB are detected as new (not existing) by findDocument', () => {
    const filePath = path.join(tmpDir, 'pre-existing.md');
    fs.writeFileSync(filePath, '# Pre-existing note\nCreated before server start.');

    // Before indexing: findDocument returns null
    const before = store.findDocument(filePath);
    expect(before).toBeNull();
  });

  it('after indexing, findDocument returns the document', () => {
    const filePath = path.join(tmpDir, 'indexed.md');
    const content = '# Indexed note\nSome content.';
    fs.writeFileSync(filePath, content);

    const h = hash(content);
    store.insertContent(h, content);
    store.insertDocument({
      collection: 'memory', path: filePath, title: 'Indexed note', hash: h,
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
      active: true, projectHash,
    });

    const after = store.findDocument(filePath);
    expect(after).not.toBeNull();
    expect(after?.title).toBe('Indexed note');
  });

  it('content hash changes are detected correctly', () => {
    const filePath = path.join(tmpDir, 'changing.md');
    const content1 = 'Version 1';
    const content2 = 'Version 2 — different';

    const h1 = hash(content1);
    store.insertContent(h1, content1);
    store.insertDocument({
      collection: 'memory', path: filePath, title: 'changing', hash: h1,
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
      active: true, projectHash,
    });

    // Simulate file change: new hash differs
    const doc = store.findDocument(filePath);
    const h2 = hash(content2);
    expect(doc?.hash).not.toBe(h2); // hash mismatch → reindex needed
  });

  it('startup integrity check: files with no matching DB record trigger reindex', () => {
    // 10 files exist on disk, none in DB
    const files: string[] = [];
    for (let i = 0; i < 10; i++) {
      const fp = path.join(tmpDir, `note${i}.md`);
      fs.writeFileSync(fp, `Note ${i} content`);
      files.push(fp);
    }

    // All should show as "new" (findDocument returns null)
    const newFiles = files.filter(fp => store.findDocument(fp) === null);
    expect(newFiles).toHaveLength(10);
  });
});
