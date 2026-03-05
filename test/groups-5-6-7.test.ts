import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, computeHash, indexDocument } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Groups 5, 6, 7: Cross-Workspace, Tags, Temporal', () => {
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

  describe('Group 5: Cross-Workspace Search', () => {
    beforeEach(() => {
      const body1 = '# Workspace A Doc\n\nContent from workspace A with keyword findme.';
      const hash1 = computeHash(body1);
      const body2 = '# Workspace B Doc\n\nContent from workspace B with keyword findme.';
      const hash2 = computeHash(body2);
      const body3 = '# Global Doc\n\nGlobal content with keyword findme.';
      const hash3 = computeHash(body3);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'test',
        path: 'a/doc.md',
        title: 'Workspace A Doc',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_a',
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'test',
        path: 'b/doc.md',
        title: 'Workspace B Doc',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'workspace_b',
      });
      
      store.insertContent(hash3, body3);
      store.insertDocument({
        collection: 'test',
        path: 'global/doc.md',
        title: 'Global Doc',
        hash: hash3,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'global',
      });
    });
    
    it('should search within workspace scope by default', () => {
      const results = store.searchFTS('findme', { projectHash: 'workspace_a' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Workspace A Doc');
      expect(titles).toContain('Global Doc');
      expect(titles).not.toContain('Workspace B Doc');
    });
    
    it('should search across all workspaces with projectHash=all', () => {
      const results = store.searchFTS('findme', { projectHash: 'all' });
      expect(results.length).toBe(3);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Workspace A Doc');
      expect(titles).toContain('Workspace B Doc');
      expect(titles).toContain('Global Doc');
    });
    
    it('should include projectHash in results when scope is all', () => {
      const results = store.searchFTS('findme', { projectHash: 'all' });
      expect(results.length).toBe(3);
      
      const wsADoc = results.find(r => r.title === 'Workspace A Doc');
      const wsBDoc = results.find(r => r.title === 'Workspace B Doc');
      const globalDoc = results.find(r => r.title === 'Global Doc');
      
      expect(wsADoc?.projectHash).toBe('workspace_a');
      expect(wsBDoc?.projectHash).toBe('workspace_b');
      expect(globalDoc?.projectHash).toBe('global');
    });
    
    it('should not include projectHash in results when scope is workspace', () => {
      const results = store.searchFTS('findme', { projectHash: 'workspace_a' });
      for (const result of results) {
        expect(result.projectHash).toBeUndefined();
      }
    });
    
    it('should include global docs in workspace-scoped search', () => {
      const results = store.searchFTS('findme', { projectHash: 'workspace_b' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Workspace B Doc');
      expect(titles).toContain('Global Doc');
    });
  });

  describe('Group 6: Structured Tags', () => {
    let docId: number;
    
    beforeEach(() => {
      const body = '# Tagged Document\n\nThis document has tags.';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      docId = store.insertDocument({
        collection: 'test',
        path: 'tagged/doc.md',
        title: 'Tagged Document',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
    });
    
    describe('insertTags', () => {
      it('should insert tags for a document', () => {
        store.insertTags(docId, ['tag1', 'tag2', 'tag3']);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual(['tag1', 'tag2', 'tag3']);
      });
      
      it('should lowercase and trim tags', () => {
        store.insertTags(docId, ['  TAG1  ', 'Tag2', 'TAG3']);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual(['tag1', 'tag2', 'tag3']);
      });
      
      it('should deduplicate tags', () => {
        store.insertTags(docId, ['tag1', 'TAG1', 'tag1', 'tag2']);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual(['tag1', 'tag2']);
      });
      
      it('should filter out empty tags', () => {
        store.insertTags(docId, ['tag1', '', '  ', 'tag2']);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual(['tag1', 'tag2']);
      });
      
      it('should handle empty tag array', () => {
        store.insertTags(docId, []);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual([]);
      });
    });
    
    describe('getDocumentTags', () => {
      it('should return empty array for document with no tags', () => {
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual([]);
      });
      
      it('should return tags in alphabetical order', () => {
        store.insertTags(docId, ['zebra', 'apple', 'mango']);
        const tags = store.getDocumentTags(docId);
        expect(tags).toEqual(['apple', 'mango', 'zebra']);
      });
    });
    
    describe('listAllTags', () => {
      it('should return empty array when no tags exist', () => {
        const tags = store.listAllTags();
        expect(tags).toEqual([]);
      });
      
      it('should return tags with counts sorted by count descending', () => {
        const body2 = '# Doc 2';
        const hash2 = computeHash(body2);
        store.insertContent(hash2, body2);
        const docId2 = store.insertDocument({
          collection: 'test',
          path: 'doc2.md',
          title: 'Doc 2',
          hash: hash2,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        
        const body3 = '# Doc 3';
        const hash3 = computeHash(body3);
        store.insertContent(hash3, body3);
        const docId3 = store.insertDocument({
          collection: 'test',
          path: 'doc3.md',
          title: 'Doc 3',
          hash: hash3,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        
        store.insertTags(docId, ['common', 'rare']);
        store.insertTags(docId2, ['common', 'medium']);
        store.insertTags(docId3, ['common', 'medium']);
        
        const tags = store.listAllTags();
        expect(tags[0]).toEqual({ tag: 'common', count: 3 });
        expect(tags[1]).toEqual({ tag: 'medium', count: 2 });
        expect(tags[2]).toEqual({ tag: 'rare', count: 1 });
      });
    });
    
    describe('tag filtering on search', () => {
      let tagDocId1: number;
      let tagDocId2: number;
      let tagDocId3: number;
      
      beforeEach(() => {
        const body1 = '# Doc 1\n\nSearchable content here.';
        const hash1 = computeHash(body1);
        store.insertContent(hash1, body1);
        tagDocId1 = store.insertDocument({
          collection: 'test',
          path: 'tagdoc1.md',
          title: 'Doc 1',
          hash: hash1,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        
        const body2 = '# Doc 2\n\nSearchable content here.';
        const hash2 = computeHash(body2);
        store.insertContent(hash2, body2);
        tagDocId2 = store.insertDocument({
          collection: 'test',
          path: 'tagdoc2.md',
          title: 'Doc 2',
          hash: hash2,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        
        const body3 = '# Doc 3\n\nSearchable content here.';
        const hash3 = computeHash(body3);
        store.insertContent(hash3, body3);
        tagDocId3 = store.insertDocument({
          collection: 'test',
          path: 'tagdoc3.md',
          title: 'Doc 3',
          hash: hash3,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        
        store.insertTags(tagDocId1, ['frontend', 'react']);
        store.insertTags(tagDocId2, ['frontend', 'vue']);
        store.insertTags(tagDocId3, ['backend', 'nodejs']);
      });
      
      it('should filter by single tag', () => {
        const results = store.searchFTS('content', { tags: ['frontend'] });
        expect(results.length).toBe(2);
        const titles = results.map(r => r.title);
        expect(titles).toContain('Doc 1');
        expect(titles).toContain('Doc 2');
        expect(titles).not.toContain('Doc 3');
      });
      
      it('should filter by multiple tags with AND logic', () => {
        const results = store.searchFTS('content', { tags: ['frontend', 'react'] });
        expect(results.length).toBe(1);
        expect(results[0].title).toBe('Doc 1');
      });
      
      it('should return no results when no documents match all tags', () => {
        const results = store.searchFTS('content', { tags: ['frontend', 'nodejs'] });
        expect(results.length).toBe(0);
      });
      
      it('should return all results when no tags filter is provided', () => {
        const results = store.searchFTS('Searchable', { limit: 10 });
        expect(results.length).toBe(3);
      });
      
      it('should handle case-insensitive tag matching', () => {
        const results = store.searchFTS('content', { tags: ['FRONTEND'] });
        expect(results.length).toBe(2);
      });
    });
  });

  describe('Group 7: Temporal Queries', () => {
    beforeEach(() => {
      const body1 = '# Old Doc\n\nOld content.';
      const hash1 = computeHash(body1);
      const body2 = '# Recent Doc\n\nRecent content.';
      const hash2 = computeHash(body2);
      const body3 = '# Future Doc\n\nFuture content.';
      const hash3 = computeHash(body3);
      
      store.insertContent(hash1, body1);
      store.insertDocument({
        collection: 'test',
        path: 'old/doc.md',
        title: 'Old Doc',
        hash: hash1,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-15T00:00:00.000Z',
        active: true,
      });
      
      store.insertContent(hash2, body2);
      store.insertDocument({
        collection: 'test',
        path: 'recent/doc.md',
        title: 'Recent Doc',
        hash: hash2,
        createdAt: '2024-06-01T00:00:00.000Z',
        modifiedAt: '2024-06-15T00:00:00.000Z',
        active: true,
      });
      
      store.insertContent(hash3, body3);
      store.insertDocument({
        collection: 'test',
        path: 'future/doc.md',
        title: 'Future Doc',
        hash: hash3,
        createdAt: '2024-12-01T00:00:00.000Z',
        modifiedAt: '2024-12-15T00:00:00.000Z',
        active: true,
      });
    });
    
    it('should filter by since date', () => {
      const results = store.searchFTS('content', { since: '2024-06-01' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Recent Doc');
      expect(titles).toContain('Future Doc');
      expect(titles).not.toContain('Old Doc');
    });
    
    it('should filter by until date', () => {
      const results = store.searchFTS('content', { until: '2024-06-30' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Old Doc');
      expect(titles).toContain('Recent Doc');
      expect(titles).not.toContain('Future Doc');
    });
    
    it('should filter by both since and until dates', () => {
      const results = store.searchFTS('content', { since: '2024-03-01', until: '2024-09-01' });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Recent Doc');
    });
    
    it('should return no results when date range has no matches', () => {
      const results = store.searchFTS('content', { since: '2025-01-01', until: '2025-12-31' });
      expect(results.length).toBe(0);
    });
    
    it('should return all results when no date filter is provided', () => {
      const results = store.searchFTS('content');
      expect(results.length).toBe(3);
    });
    
    it('should use inclusive comparison for since (>=)', () => {
      const results = store.searchFTS('content', { since: '2024-06-15T00:00:00.000Z' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Recent Doc');
      expect(titles).toContain('Future Doc');
    });
    
    it('should use inclusive comparison for until (<=)', () => {
      const results = store.searchFTS('content', { until: '2024-06-15T00:00:00.000Z' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Old Doc');
      expect(titles).toContain('Recent Doc');
    });
  });

  describe('Combined Filters', () => {
    beforeEach(() => {
      const body1 = '# WS-A Tagged Old\n\nContent here.';
      const hash1 = computeHash(body1);
      const body2 = '# WS-A Tagged Recent\n\nContent here.';
      const hash2 = computeHash(body2);
      const body3 = '# WS-B Tagged Recent\n\nContent here.';
      const hash3 = computeHash(body3);
      
      store.insertContent(hash1, body1);
      const docId1 = store.insertDocument({
        collection: 'test',
        path: 'a/old.md',
        title: 'WS-A Tagged Old',
        hash: hash1,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-15T00:00:00.000Z',
        active: true,
        projectHash: 'workspace_a',
      });
      
      store.insertContent(hash2, body2);
      const docId2 = store.insertDocument({
        collection: 'test',
        path: 'a/recent.md',
        title: 'WS-A Tagged Recent',
        hash: hash2,
        createdAt: '2024-06-01T00:00:00.000Z',
        modifiedAt: '2024-06-15T00:00:00.000Z',
        active: true,
        projectHash: 'workspace_a',
      });
      
      store.insertContent(hash3, body3);
      const docId3 = store.insertDocument({
        collection: 'test',
        path: 'b/recent.md',
        title: 'WS-B Tagged Recent',
        hash: hash3,
        createdAt: '2024-06-01T00:00:00.000Z',
        modifiedAt: '2024-06-15T00:00:00.000Z',
        active: true,
        projectHash: 'workspace_b',
      });
      
      store.insertTags(docId1, ['important']);
      store.insertTags(docId2, ['important']);
      store.insertTags(docId3, ['important']);
    });
    
    it('should combine workspace scope with tags filter', () => {
      const results = store.searchFTS('content', { 
        projectHash: 'workspace_a',
        tags: ['important'],
      });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('WS-A Tagged Old');
      expect(titles).toContain('WS-A Tagged Recent');
    });
    
    it('should combine workspace scope with temporal filter', () => {
      const results = store.searchFTS('content', { 
        projectHash: 'workspace_a',
        since: '2024-06-01',
      });
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('WS-A Tagged Recent');
    });
    
    it('should combine all filters: scope, tags, and temporal', () => {
      const results = store.searchFTS('content', { 
        projectHash: 'all',
        tags: ['important'],
        since: '2024-06-01',
      });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('WS-A Tagged Recent');
      expect(titles).toContain('WS-B Tagged Recent');
      expect(titles).not.toContain('WS-A Tagged Old');
    });
    
    it('should combine cross-workspace search with tags and return projectHash', () => {
      const results = store.searchFTS('content', { 
        projectHash: 'all',
        tags: ['important'],
        since: '2024-06-01',
      });
      
      const wsADoc = results.find(r => r.title === 'WS-A Tagged Recent');
      const wsBDoc = results.find(r => r.title === 'WS-B Tagged Recent');
      
      expect(wsADoc?.projectHash).toBe('workspace_a');
      expect(wsBDoc?.projectHash).toBe('workspace_b');
    });
  });

  describe('Backward Compatibility', () => {
    it('should work with no options (default behavior)', () => {
      const body = '# Simple Doc\n\nSimple content.';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'test',
        path: 'simple/doc.md',
        title: 'Simple Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const results = store.searchFTS('simple');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Simple Doc');
    });
    
    it('should work with only limit option', () => {
      const body = '# Limit Doc\n\nLimit content.';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'test',
        path: 'limit/doc.md',
        title: 'Limit Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const results = store.searchFTS('limit', { limit: 5 });
      expect(results.length).toBe(1);
    });
    
    it('should work with only collection option', () => {
      const body = '# Collection Doc\n\nCollection content.';
      const hash = computeHash(body);
      store.insertContent(hash, body);
      store.insertDocument({
        collection: 'specific',
        path: 'collection/doc.md',
        title: 'Collection Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });
      
      const results = store.searchFTS('collection', { collection: 'specific' });
      expect(results.length).toBe(1);
      expect(results[0].collection).toBe('specific');
    });
  });
});
