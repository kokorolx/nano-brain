import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createStore, sanitizeFTS5Query, extractProjectHashFromPath, indexDocument } from '../src/store.js';
import type { Store } from '../src/types.js';

describe('FTS5 Query Sanitization', () => {
  it('wraps normal query in quotes', () => {
    expect(sanitizeFTS5Query('hello world')).toBe('"hello world"');
  });

  it('preserves hyphenated words', () => {
    expect(sanitizeFTS5Query('nano-brain')).toBe('"nano-brain"');
  });

  it('escapes internal double quotes', () => {
    expect(sanitizeFTS5Query('hello "world"')).toBe('"hello ""world"""');
  });

  it('neutralizes FTS5 operators', () => {
    expect(sanitizeFTS5Query('AND OR NOT')).toBe('"AND OR NOT"');
  });

  it('neutralizes FTS5 column names', () => {
    expect(sanitizeFTS5Query('filepath: test')).toBe('"filepath: test"');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFTS5Query('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeFTS5Query('   ')).toBe('');
  });
});

describe('Real Database Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let store: Store;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-test-'));
    dbPath = path.join(tempDir, 'test.db');
    store = createStore(dbPath);

    const doc1Content = '# Nano Brain\n\nThis is a test document about nano-brain architecture and memory systems.';
    const doc1Hash = crypto.createHash('sha256').update(doc1Content).digest('hex');
    store.insertContent(doc1Hash, doc1Content);
    store.insertDocument({
      collection: 'test-collection',
      path: '/test/doc1.md',
      title: 'Nano Brain',
      hash: doc1Hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });

    const doc2Content = '# Search Guide\n\nHow to use AND OR NOT operators in search queries.';
    const doc2Hash = crypto.createHash('sha256').update(doc2Content).digest('hex');
    store.insertContent(doc2Hash, doc2Content);
    store.insertDocument({
      collection: 'test-collection',
      path: '/test/doc2.md',
      title: 'Search Guide',
      hash: doc2Hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });

    const doc3Content = '# Daily Log\n\nToday I worked on the filepath indexing feature.';
    const doc3Hash = crypto.createHash('sha256').update(doc3Content).digest('hex');
    store.insertContent(doc3Hash, doc3Content);
    store.insertDocument({
      collection: 'daily',
      path: '/daily/2024-01-01.md',
      title: 'Daily Log',
      hash: doc3Hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('search finds indexed documents', () => {
    const results = store.searchFTS('memory', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.title === 'Nano Brain')).toBe(true);
  });

  it('hyphenated query works without error', () => {
    expect(() => {
      const results = store.searchFTS('nano-brain', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
    }).not.toThrow();
  });

  it('FTS5 operator words work without error', () => {
    expect(() => {
      const results = store.searchFTS('AND OR NOT', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
    }).not.toThrow();
  });

  it('FTS5 column name words work without error', () => {
    expect(() => {
      const results = store.searchFTS('filepath', { limit: 10 });
      expect(Array.isArray(results)).toBe(true);
    }).not.toThrow();
  });

  it('empty query returns empty array', () => {
    const results = store.searchFTS('', { limit: 10 });
    expect(results).toEqual([]);
  });

  it('collection filter works', () => {
    const results = store.searchFTS('log', { limit: 10, collection: 'daily' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.collection === 'daily')).toBe(true);
  });

  it('getHealth() returns correct document count', () => {
    const health = store.getIndexHealth();
    expect(health.documentCount).toBe(3);
  });

  it('getHealth() returns correct collection stats', () => {
    const health = store.getIndexHealth();
    expect(health.collections.length).toBe(2);
    
    const testCollection = health.collections.find(c => c.name === 'test-collection');
    expect(testCollection).toBeDefined();
    expect(testCollection?.documentCount).toBe(2);
    
    const dailyCollection = health.collections.find(c => c.name === 'daily');
    expect(dailyCollection).toBeDefined();
    expect(dailyCollection?.documentCount).toBe(1);
  });
});

describe('Workspace-scoped session indexing', () => {
  let tempDir: string;
  let dbPath: string;
  let store: Store;
  let sessionsDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-workspace-test-'));
    dbPath = path.join(tempDir, 'test.db');
    store = createStore(dbPath);
    sessionsDir = path.join(tempDir, 'sessions');

    const hash1Dir = path.join(sessionsDir, 'abc123def456');
    const hash2Dir = path.join(sessionsDir, 'fff000eee111');
    fs.mkdirSync(hash1Dir, { recursive: true });
    fs.mkdirSync(hash2Dir, { recursive: true });

    const sessionA = path.join(hash1Dir, 'session-a.md');
    const sessionB = path.join(hash2Dir, 'session-b.md');
    fs.writeFileSync(sessionA, '# Session Alpha\n\nThis is workspace alpha content about testing.');
    fs.writeFileSync(sessionB, '# Session Beta\n\nThis is workspace beta content about testing.');
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should store correct project_hash for each session file (task 5.1)', () => {
    const sessionAPath = path.join(sessionsDir, 'abc123def456', 'session-a.md');
    const sessionBPath = path.join(sessionsDir, 'fff000eee111', 'session-b.md');

    const contentA = fs.readFileSync(sessionAPath, 'utf-8');
    const contentB = fs.readFileSync(sessionBPath, 'utf-8');

    const hashA = extractProjectHashFromPath(sessionAPath, sessionsDir);
    const hashB = extractProjectHashFromPath(sessionBPath, sessionsDir);

    expect(hashA).toBe('abc123def456');
    expect(hashB).toBe('fff000eee111');

    indexDocument(store, 'sessions', sessionAPath, contentA, 'Session Alpha', hashA);
    indexDocument(store, 'sessions', sessionBPath, contentB, 'Session Beta', hashB);

    const docA = store.findDocument(sessionAPath);
    const docB = store.findDocument(sessionBPath);

    expect(docA).not.toBeNull();
    expect(docB).not.toBeNull();
    expect(docA!.projectHash).toBe('abc123def456');
    expect(docB!.projectHash).toBe('fff000eee111');
  });

  it('should filter search results by workspace (task 5.2)', () => {
    const resultsAlpha = store.searchFTS('testing', { limit: 10, projectHash: 'abc123def456' });
    expect(resultsAlpha.length).toBe(1);
    expect(resultsAlpha[0].title).toBe('Session Alpha');

    const resultsBeta = store.searchFTS('testing', { limit: 10, projectHash: 'fff000eee111' });
    expect(resultsBeta.length).toBe(1);
    expect(resultsBeta[0].title).toBe('Session Beta');

    const resultsAll = store.searchFTS('testing', { limit: 10, projectHash: 'all' });
    expect(resultsAll.length).toBe(2);
    const titles = resultsAll.map(r => r.title).sort();
    expect(titles).toEqual(['Session Alpha', 'Session Beta']);
  });
});

describe('init --force clearWorkspace', () => {
  let tempDir: string;
  let dbPath: string;
  let store: Store;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-force-test-'));
    dbPath = path.join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should clear workspace data and allow re-indexing', () => {
    const projectHash = 'abc123def456';
    const content1 = '# Original Document\n\nThis is the original content.';
    
    indexDocument(store, 'codebase', 'src/original.ts', content1, 'Original Document', projectHash);
    
    let doc = store.findDocument('src/original.ts');
    expect(doc).not.toBeNull();
    expect(doc!.projectHash).toBe(projectHash);
    
    const cleared = store.clearWorkspace(projectHash);
    expect(cleared.documentsDeleted).toBe(1);
    
    doc = store.findDocument('src/original.ts');
    expect(doc).toBeNull();
    
    const content2 = '# New Document\n\nThis is the new content after force re-init.';
    indexDocument(store, 'codebase', 'src/new.ts', content2, 'New Document', projectHash);
    
    const newDoc = store.findDocument('src/new.ts');
    expect(newDoc).not.toBeNull();
    expect(newDoc!.title).toBe('New Document');
    expect(newDoc!.projectHash).toBe(projectHash);
  });

  it('should preserve global and other workspace documents', () => {
    const globalContent = '# Global Memory\n\nThis is global content.';
    const workspaceAContent = '# Workspace A\n\nThis is workspace A content.';
    const workspaceBContent = '# Workspace B\n\nThis is workspace B content.';
    
    indexDocument(store, 'memory', 'memory/global.md', globalContent, 'Global Memory', 'global');
    indexDocument(store, 'codebase', 'src/a.ts', workspaceAContent, 'Workspace A', 'workspace_a');
    indexDocument(store, 'codebase', 'src/b.ts', workspaceBContent, 'Workspace B', 'workspace_b');
    
    expect(store.findDocument('memory/global.md')).not.toBeNull();
    expect(store.findDocument('src/a.ts')).not.toBeNull();
    expect(store.findDocument('src/b.ts')).not.toBeNull();
    
    const cleared = store.clearWorkspace('workspace_a');
    expect(cleared.documentsDeleted).toBe(1);
    
    expect(store.findDocument('memory/global.md')).not.toBeNull();
    expect(store.findDocument('src/a.ts')).toBeNull();
    expect(store.findDocument('src/b.ts')).not.toBeNull();
  });
});
