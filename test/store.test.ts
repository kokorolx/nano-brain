import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, computeHash, indexDocument, extractProjectHashFromPath } from '../src/store.js';
import type { Store } from '../src/types.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Store', () => {
  let store: Store;
  let dbPath: string;
  
  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });
  
  afterEach(() => {
    store.close();
    const dir = path.dirname(dbPath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  
  describe('schema creation', () => {
    it('should create all required tables', () => {
      const health = store.getIndexHealth();
      expect(health).toBeDefined();
      expect(health.documentCount).toBe(0);
      expect(health.embeddedCount).toBe(0);
    });

    it('should create file_edges table with correct schema', () => {
      const db = new Database(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_edges'").all();
      expect(tables.length).toBe(1);
      
      const columns = db.prepare("PRAGMA table_info(file_edges)").all() as Array<{ name: string; type: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('source_path');
      expect(columnNames).toContain('target_path');
      expect(columnNames).toContain('edge_type');
      expect(columnNames).toContain('project_hash');
      db.close();
    });

    it('should create document_tags table with correct schema', () => {
      const db = new Database(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_tags'").all();
      expect(tables.length).toBe(1);
      
      const columns = db.prepare("PRAGMA table_info(document_tags)").all() as Array<{ name: string; type: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('document_id');
      expect(columnNames).toContain('tag');
      db.close();
    });

    it('should create symbols table with correct schema', () => {
      const db = new Database(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbols'").all();
      expect(tables.length).toBe(1);
      
      const columns = db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string; type: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('type');
      expect(columnNames).toContain('pattern');
      expect(columnNames).toContain('operation');
      expect(columnNames).toContain('repo');
      expect(columnNames).toContain('file_path');
      expect(columnNames).toContain('line_number');
      expect(columnNames).toContain('raw_expression');
      expect(columnNames).toContain('project_hash');
      db.close();
    });

    it('should add centrality, cluster_id, superseded_by columns to documents table', () => {
      const db = new Database(dbPath);
      const columns = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string; type: string }>;
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('centrality');
      expect(columnNames).toContain('cluster_id');
      expect(columnNames).toContain('superseded_by');
      db.close();
    });

    it('should handle idempotent schema creation (calling createStore twice)', () => {
      store.close();
      const store2 = createStore(dbPath);
      const health = store2.getIndexHealth();
      expect(health).toBeDefined();
      store2.close();
      store = createStore(dbPath);
    });
  });

  describe('file_edges constraints', () => {
    it('should enforce unique constraint on (source_path, target_path, project_hash)', () => {
      const db = new Database(dbPath);
      db.prepare("INSERT INTO file_edges (source_path, target_path, edge_type, project_hash) VALUES (?, ?, ?, ?)").run('a.ts', 'b.ts', 'import', 'global');
      
      expect(() => {
        db.prepare("INSERT INTO file_edges (source_path, target_path, edge_type, project_hash) VALUES (?, ?, ?, ?)").run('a.ts', 'b.ts', 'import', 'global');
      }).toThrow();
      
      expect(() => {
        db.prepare("INSERT INTO file_edges (source_path, target_path, edge_type, project_hash) VALUES (?, ?, ?, ?)").run('a.ts', 'b.ts', 'import', 'other');
      }).not.toThrow();
      
      db.close();
    });
  });

  describe('document_tags constraints', () => {
    it('should enforce unique constraint on (document_id, tag)', () => {
      const body = '# Tagged Doc';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      const docId = store.insertDocument({
        collection: 'test',
        path: 'tagged/doc.md',
        title: 'Tagged Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const db = new Database(dbPath);
      db.prepare("INSERT INTO document_tags (document_id, tag) VALUES (?, ?)").run(docId, 'test-tag');
      
      expect(() => {
        db.prepare("INSERT INTO document_tags (document_id, tag) VALUES (?, ?)").run(docId, 'test-tag');
      }).toThrow();
      
      expect(() => {
        db.prepare("INSERT INTO document_tags (document_id, tag) VALUES (?, ?)").run(docId, 'other-tag');
      }).not.toThrow();
      
      db.close();
    });

    it('should cascade delete tags when document is deleted', () => {
      const body = '# Cascade Doc';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      const docId = store.insertDocument({
        collection: 'test',
        path: 'cascade/doc.md',
        title: 'Cascade Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const db = new Database(dbPath);
      db.prepare("INSERT INTO document_tags (document_id, tag) VALUES (?, ?)").run(docId, 'cascade-tag');
      
      const tagsBefore = db.prepare("SELECT * FROM document_tags WHERE document_id = ?").all(docId);
      expect(tagsBefore.length).toBe(1);
      
      db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
      
      const tagsAfter = db.prepare("SELECT * FROM document_tags WHERE document_id = ?").all(docId);
      expect(tagsAfter.length).toBe(0);
      
      db.close();
    });
  });

  describe('symbols constraints', () => {
    it('should enforce unique constraint on symbol combination', () => {
      const db = new Database(dbPath);
      db.prepare(`
        INSERT INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('function', 'myFunc', 'definition', 'test-repo', 'src/index.ts', 10, 'function myFunc() {}', 'global');
      
      expect(() => {
        db.prepare(`
          INSERT INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('function', 'myFunc', 'definition', 'test-repo', 'src/index.ts', 10, 'function myFunc() {}', 'global');
      }).toThrow();
      
      expect(() => {
        db.prepare(`
          INSERT INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('function', 'myFunc', 'definition', 'test-repo', 'src/index.ts', 20, 'function myFunc() {}', 'global');
      }).not.toThrow();
      
      db.close();
    });
  });
  
  describe('insertContent + insertDocument', () => {
    it('should insert content and document', () => {
      const body = '# Test Document\n\nThis is test content.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      const docId = store.insertDocument({
        collection: 'test-collection',
        path: 'test/doc.md',
        title: 'Test Document',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      expect(docId).toBeGreaterThan(0);
    });
  });
  
  describe('findDocument', () => {
    it('should find document by path', () => {
      const body = '# Find Me\n\nContent here.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'docs',
        path: 'find/me.md',
        title: 'Find Me',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const doc = store.findDocument('find/me.md');
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Find Me');
      expect(doc?.collection).toBe('docs');
    });
    
    it('should find document by docid (6-char hash prefix)', () => {
      const body = '# Docid Test\n\nFind by hash prefix.';
      const hash = computeHash(body);
      const docid = hash.substring(0, 6);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'docs',
        path: 'docid/test.md',
        title: 'Docid Test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const doc = store.findDocument(docid);
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Docid Test');
    });
    
    it('should return null for non-existent document', () => {
      const doc = store.findDocument('nonexistent/path.md');
      expect(doc).toBeNull();
    });
  });
  
  describe('deactivateDocument', () => {
    it('should deactivate a document', () => {
      const body = '# Deactivate Me';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'docs',
        path: 'deactivate/me.md',
        title: 'Deactivate Me',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      let doc = store.findDocument('deactivate/me.md');
      expect(doc).not.toBeNull();
      
      store.deactivateDocument('docs', 'deactivate/me.md');
      
      doc = store.findDocument('deactivate/me.md');
      expect(doc).toBeNull();
    });
  });
  
  describe('FTS trigger', () => {
    it('should index document in FTS on insert', () => {
      const body = '# Searchable Document\n\nThis contains unique searchterm xyz123.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'searchable',
        path: 'search/doc.md',
        title: 'Searchable Document',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const results = store.searchFTS('xyz123');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Searchable Document');
    });
    
    it('should search by title', () => {
      const body = '# Unique Title ABC\n\nSome content.';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'titles',
        path: 'title/doc.md',
        title: 'Unique Title ABC',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const results = store.searchFTS('Unique Title ABC');
      expect(results.length).toBe(1);
    });
    
    it('should filter by collection', () => {
      const body1 = '# Doc One\n\nShared keyword findme.';
      const hash1 = computeHash(body1);
      const body2 = '# Doc Two\n\nShared keyword findme.';
      const hash2 = computeHash(body2);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'collection-a',
        path: 'a/doc.md',
        title: 'Doc One',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'collection-b',
        path: 'b/doc.md',
        title: 'Doc Two',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const allResults = store.searchFTS('findme');
      expect(allResults.length).toBe(2);
      
      const filteredResults = store.searchFTS('findme', { limit: 10, collection: 'collection-a' });
      expect(filteredResults.length).toBe(1);
      expect(filteredResults[0].collection).toBe('collection-a');
    });
  });
  
  describe('getIndexHealth', () => {
    it('should return correct counts', () => {
      const body1 = '# Health Doc 1';
      const hash1 = computeHash(body1);
      const body2 = '# Health Doc 2';
      const hash2 = computeHash(body2);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'health',
        path: 'health/doc1.md',
        title: 'Health Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'health',
        path: 'health/doc2.md',
        title: 'Health Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const health = store.getIndexHealth();
      expect(health.documentCount).toBe(2);
      expect(health.collections.length).toBe(1);
      expect(health.collections[0].name).toBe('health');
      expect(health.collections[0].documentCount).toBe(2);
    });
  });
  
  describe('getDocumentBody', () => {
    it('should return full body', () => {
      const body = '# Line 1\nLine 2\nLine 3\nLine 4';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      
      const result = store.getDocumentBody(hash);
      expect(result).toBe(body);
    });
    
    it('should return partial body with fromLine and maxLines', () => {
      const body = 'Line 0\nLine 1\nLine 2\nLine 3\nLine 4';
      const hash = computeHash(body);
      
      store.insertContent(hash, body);
      
      const result = store.getDocumentBody(hash, 1, 2);
      expect(result).toBe('Line 1\nLine 2');
    });
  });
  
  describe('LLM cache', () => {
    it('should store and retrieve cached results', () => {
      const hash = 'test-cache-key';
      const result = '{"expanded": ["query1", "query2"]}';
      
      expect(store.getCachedResult(hash)).toBeNull();
      
      store.setCachedResult(hash, result);
      
      expect(store.getCachedResult(hash)).toBe(result);
    });
  });
  
  describe('bulkDeactivateExcept', () => {
    it('should deactivate documents not in active list', () => {
      const body1 = '# Doc 1';
      const hash1 = computeHash(body1);
      const body2 = '# Doc 2';
      const hash2 = computeHash(body2);
      const body3 = '# Doc 3';
      const hash3 = computeHash(body3);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'bulk-test',
        path: 'doc1.md',
        title: 'Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'bulk-test',
        path: 'doc2.md',
        title: 'Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash3, body3);
      store.insertDocument({
        collection: 'bulk-test',
        path: 'doc3.md',
        title: 'Doc 3',
        hash: hash3,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const deactivatedCount = store.bulkDeactivateExcept('bulk-test', ['doc1.md', 'doc3.md']);
      expect(deactivatedCount).toBe(1);
      
      expect(store.findDocument('doc1.md')).not.toBeNull();
      expect(store.findDocument('doc2.md')).toBeNull();
      expect(store.findDocument('doc3.md')).not.toBeNull();
    });
    
    it('should deactivate all documents when active list is empty', () => {
      const body1 = '# Doc A';
      const hash1 = computeHash(body1);
      const body2 = '# Doc B';
      const hash2 = computeHash(body2);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'empty-test',
        path: 'docA.md',
        title: 'Doc A',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'empty-test',
        path: 'docB.md',
        title: 'Doc B',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const deactivatedCount = store.bulkDeactivateExcept('empty-test', []);
      expect(deactivatedCount).toBe(2);
      
      expect(store.findDocument('docA.md')).toBeNull();
      expect(store.findDocument('docB.md')).toBeNull();
    });
    
    it('should only affect specified collection', () => {
      const body1 = '# Collection A Doc';
      const hash1 = computeHash(body1);
      const body2 = '# Collection B Doc';
      const hash2 = computeHash(body2);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'collection-a',
        path: 'doc.md',
        title: 'Collection A Doc',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'collection-b',
        path: 'doc.md',
        title: 'Collection B Doc',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const deactivatedCount = store.bulkDeactivateExcept('collection-a', []);
      expect(deactivatedCount).toBe(1);
      
      const docA = store.findDocument('doc.md');
      expect(docA).not.toBeNull();
      expect(docA?.collection).toBe('collection-b');
    });
  });
  
  describe('indexDocument', () => {
    it('should index a new document', () => {
      const content = '# Test Document\n\nThis is test content for indexing.';
      const result = indexDocument(store, 'test-collection', 'test/doc.md', content, 'Test Document');
      
      expect(result.skipped).toBe(false);
      expect(result.chunks).toBeGreaterThan(0);
      expect(result.hash).toBe(computeHash(content));
      
      const doc = store.findDocument('test/doc.md');
      expect(doc).not.toBeNull();
      expect(doc?.title).toBe('Test Document');
      expect(doc?.collection).toBe('test-collection');
      expect(doc?.hash).toBe(result.hash);
    });
    
    it('should skip indexing when content hash matches', () => {
      const content = '# Unchanged Document\n\nThis content will not change.';
      
      const result1 = indexDocument(store, 'test-collection', 'unchanged/doc.md', content, 'Unchanged Document');
      expect(result1.skipped).toBe(false);
      expect(result1.chunks).toBeGreaterThan(0);
      
      const result2 = indexDocument(store, 'test-collection', 'unchanged/doc.md', content, 'Unchanged Document');
      expect(result2.skipped).toBe(true);
      expect(result2.chunks).toBe(0);
      expect(result2.hash).toBe(result1.hash);
    });
    
    it('should re-index when content changes', () => {
      const content1 = '# Original Content\n\nThis is the original version.';
      const content2 = '# Updated Content\n\nThis is the updated version.';
      
      const result1 = indexDocument(store, 'test-collection', 'updated/doc.md', content1, 'Document');
      expect(result1.skipped).toBe(false);
      const hash1 = result1.hash;
      
      const result2 = indexDocument(store, 'test-collection', 'updated/doc.md', content2, 'Document');
      expect(result2.skipped).toBe(false);
      expect(result2.chunks).toBeGreaterThan(0);
      expect(result2.hash).not.toBe(hash1);
      
      const doc = store.findDocument('updated/doc.md');
      expect(doc?.hash).toBe(result2.hash);
    });
    
    it('should make document searchable via FTS', () => {
      const content = '# Searchable Content\n\nThis document contains the unique term xyzabc123.';
      indexDocument(store, 'search-test', 'searchable/doc.md', content, 'Searchable Content');
      
      const results = store.searchFTS('xyzabc123');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Searchable Content');
      expect(results[0].collection).toBe('search-test');
    });
    
    it('should handle large documents with multiple chunks', () => {
      const largeContent = '# Large Document\n\n' + 'Lorem ipsum dolor sit amet. '.repeat(500);
      const result = indexDocument(store, 'large-test', 'large/doc.md', largeContent, 'Large Document');
      
      expect(result.skipped).toBe(false);
      expect(result.chunks).toBeGreaterThan(1);
    });
  });
  
  describe('extractProjectHashFromPath', () => {
    it('should extract projectHash from valid session path', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/sessions/abc123def456/2024-01-15-session.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBe('abc123def456');
    });
    
    it('should return undefined for non-session path (memory dir)', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/memory/2024-01-15.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBeUndefined();
    });
    
    it('should return undefined for path with non-hex subdirectory', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/sessions/not-a-hex-dir/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBeUndefined();
    });
    
    it('should return undefined for path without sessionsDir prefix', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/other/path/abc123def456/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBeUndefined();
    });
    
    it('should return undefined for empty string inputs', () => {
      expect(extractProjectHashFromPath('', '/home/user/.nano-brain/sessions')).toBeUndefined();
      expect(extractProjectHashFromPath('/some/path', '')).toBeUndefined();
      expect(extractProjectHashFromPath('', '')).toBeUndefined();
    });
    
    it('should handle trailing slashes on sessionsDir', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions/';
      const filePath = '/home/user/.nano-brain/sessions/abc123def456/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBe('abc123def456');
    });
    
    it('should return lowercase hash even if path has uppercase', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/sessions/ABC123DEF456/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBe('abc123def456');
    });
    
    it('should return undefined for hash with wrong length', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/sessions/abc123/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBeUndefined();
    });
    
    it('should return undefined for file directly in sessionsDir (no subdirectory)', () => {
      const sessionsDir = '/home/user/.nano-brain/sessions';
      const filePath = '/home/user/.nano-brain/sessions/file.md';
      const result = extractProjectHashFromPath(filePath, sessionsDir);
      expect(result).toBeUndefined();
    });
  });

  describe('clearWorkspace', () => {
    it('should delete all documents for the given projectHash and return correct count', () => {
      const body1 = '# Workspace Doc 1';
      const hash1 = computeHash(body1);
      const body2 = '# Workspace Doc 2';
      const hash2 = computeHash(body2);

      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'test',
        path: 'ws/doc1.md',
        title: 'Workspace Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'test',
        path: 'ws/doc2.md',
        title: 'Workspace Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      const result = store.clearWorkspace('workspace_a');
      expect(result.documentsDeleted).toBe(2);

      expect(store.findDocument('ws/doc1.md')).toBeNull();
      expect(store.findDocument('ws/doc2.md')).toBeNull();
    });

    it('should preserve documents with project_hash = global', () => {
      const globalBody = '# Global Doc';
      const globalHash = computeHash(globalBody);
      const wsBody = '# Workspace Doc';
      const wsHash = computeHash(wsBody);

      store.insertContent(globalHash, globalBody);
      store.insertDocument({
        collection: 'memory',
        path: 'global/doc.md',
        title: 'Global Doc',
        hash: globalHash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'global',
      });

      store.insertContent(wsHash, wsBody);
      store.insertDocument({
        collection: 'test',
        path: 'ws/doc.md',
        title: 'Workspace Doc',
        hash: wsHash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      store.clearWorkspace('workspace_a');

      expect(store.findDocument('global/doc.md')).not.toBeNull();
      expect(store.findDocument('ws/doc.md')).toBeNull();
    });

    it('should preserve documents from other workspaces', () => {
      const bodyA = '# Workspace A Doc';
      const hashA = computeHash(bodyA);
      const bodyB = '# Workspace B Doc';
      const hashB = computeHash(bodyB);

      store.insertContent(hashA, bodyA);
      store.insertDocument({
        collection: 'test',
        path: 'a/doc.md',
        title: 'Workspace A Doc',
        hash: hashA,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      store.insertContent(hashB, bodyB);
      store.insertDocument({
        collection: 'test',
        path: 'b/doc.md',
        title: 'Workspace B Doc',
        hash: hashB,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_b',
      });

      store.clearWorkspace('workspace_a');

      expect(store.findDocument('a/doc.md')).toBeNull();
      expect(store.findDocument('b/doc.md')).not.toBeNull();
    });

    it('should clean up orphaned content (hash only used by deleted workspace)', () => {
      const body = '# Orphan Content';
      const hash = computeHash(body);

      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'test',
        path: 'orphan/doc.md',
        title: 'Orphan Content',
        hash: hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      store.clearWorkspace('workspace_a');

      const content = store.getDocumentBody(hash);
      expect(content).toBeNull();
    });

    it('should preserve shared content (hash used by both deleted and other workspace)', () => {
      const sharedBody = '# Shared Content';
      const sharedHash = computeHash(sharedBody);

      store.insertContent(sharedHash, sharedBody);
      store.insertDocument({
        collection: 'test',
        path: 'shared/doc_a.md',
        title: 'Shared A',
        hash: sharedHash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });

      store.insertDocument({
        collection: 'test',
        path: 'shared/doc_b.md',
        title: 'Shared B',
        hash: sharedHash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_b',
      });

      store.clearWorkspace('workspace_a');

      expect(store.findDocument('shared/doc_a.md')).toBeNull();
      expect(store.findDocument('shared/doc_b.md')).not.toBeNull();
      const content = store.getDocumentBody(sharedHash);
      expect(content).toBe(sharedBody);
    });

    it('should return { documentsDeleted: 0, embeddingsDeleted: 0 } when no documents match', () => {
      const result = store.clearWorkspace('nonexistent_workspace');
      expect(result.documentsDeleted).toBe(0);
      expect(result.embeddingsDeleted).toBe(0);
    });
  });

});
