import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startWatcher } from '../src/watcher.js';
import type { Store, Collection } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Watcher', () => {
  let tmpDir: string;
  let collectionPath: string;
  let mockStore: Store;
  let collections: Collection[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    collectionPath = path.join(tmpDir, 'docs');
    fs.mkdirSync(collectionPath, { recursive: true });

    mockStore = {
      findDocument: vi.fn().mockReturnValue(null),
      insertContent: vi.fn(),
      insertDocument: vi.fn().mockReturnValue(1),
      deactivateDocument: vi.fn(),
      bulkDeactivateExcept: vi.fn().mockReturnValue(0),
      getIndexHealth: vi.fn().mockReturnValue({
        documentCount: 0,
        embeddedCount: 0,
        pendingEmbeddings: 0,
        collections: [],
        databaseSize: 0,
        modelStatus: {
          embedding: 'missing',
          reranker: 'missing',
          expander: 'missing',
        },
      }),
      close: vi.fn(),
      getDocumentBody: vi.fn(),
      insertEmbedding: vi.fn(),
      ensureVecTable: vi.fn(),
      searchFTS: vi.fn().mockReturnValue([]),
      searchVec: vi.fn().mockReturnValue([]),
      getCachedResult: vi.fn().mockReturnValue(null),
      setCachedResult: vi.fn(),
      getQueryEmbeddingCache: vi.fn().mockReturnValue(null),
      setQueryEmbeddingCache: vi.fn(),
      clearQueryEmbeddingCache: vi.fn(),
      clearCache: vi.fn().mockReturnValue(0),
      getCacheStats: vi.fn().mockReturnValue([]),
      getHashesNeedingEmbedding: vi.fn().mockReturnValue([]),
      getNextHashNeedingEmbedding: vi.fn().mockReturnValue(null),
      getWorkspaceStats: vi.fn().mockReturnValue([]),
      deleteDocumentsByPath: vi.fn().mockReturnValue(0),
      clearWorkspace: vi.fn().mockReturnValue({ documentsDeleted: 0, embeddingsDeleted: 0 }),
      cleanOrphanedEmbeddings: vi.fn().mockReturnValue(0),
      getCollectionStorageSize: vi.fn().mockReturnValue(0),
      modelStatus: { embedding: 'missing', reranker: 'missing', expander: 'missing' },
    } as unknown as Store;

    collections = [
      {
        name: 'test-collection',
        path: collectionPath,
        pattern: '**/*.md',
      },
    ];
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create watcher with default options', () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      expect(watcher).toBeDefined();
      expect(watcher.stop).toBeDefined();
      expect(watcher.isDirty).toBeDefined();
      expect(watcher.triggerReindex).toBeDefined();
      expect(watcher.getStats).toBeDefined();

      watcher.stop();
    });

    it('should start with clean state', () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      expect(watcher.isDirty()).toBe(false);

      const stats = watcher.getStats();
      expect(stats.pendingChanges).toBe(0);
      expect(stats.isReindexing).toBe(false);
      expect(stats.lastReindexAt).toBeNull();

      watcher.stop();
    });
  });

  describe('dirty flag', () => {
    it('should set dirty flag on file change', async () => {
      const testFile = path.join(collectionPath, 'test.md');
      fs.writeFileSync(testFile, '# Initial\n\nContent');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(watcher.isDirty()).toBe(false);

      fs.writeFileSync(testFile, '# Modified\n\nContent');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });

    it('should clear dirty flag after reindex', async () => {
      const testFile = path.join(collectionPath, 'test.md');
      fs.writeFileSync(testFile, '# Test\n\nContent');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.writeFileSync(testFile, '# Modified\n\nContent');

      await new Promise(resolve => setTimeout(resolve, 400));
      expect(watcher.isDirty()).toBe(true);

      await watcher.triggerReindex();

      expect(watcher.isDirty()).toBe(false);

      watcher.stop();
    });
  });

  describe('debounce', () => {
    it('should debounce multiple rapid changes', async () => {
      const onUpdate = vi.fn();
      const watcher = startWatcher({
        store: mockStore,
        collections,
        onUpdate,
        debounceMs: 200,
      });

      const testFile = path.join(collectionPath, 'test.md');

      fs.writeFileSync(testFile, '# Test 1');
      await new Promise(resolve => setTimeout(resolve, 50));

      fs.writeFileSync(testFile, '# Test 2');
      await new Promise(resolve => setTimeout(resolve, 50));

      fs.writeFileSync(testFile, '# Test 3');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });
  });

  describe('file operations', () => {
    it('should detect new .md file', async () => {
      const existingFile = path.join(collectionPath, 'existing.md');
      fs.writeFileSync(existingFile, '# Existing');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      const testFile = path.join(collectionPath, 'new-file.md');
      fs.writeFileSync(testFile, '# New File\n\nContent');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(true);
      const stats = watcher.getStats();
      expect(stats.pendingChanges).toBeGreaterThan(0);

      watcher.stop();
    });

    it('should detect modified .md file', async () => {
      const testFile = path.join(collectionPath, 'existing.md');
      fs.writeFileSync(testFile, '# Original');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.writeFileSync(testFile, '# Modified');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });

    it('should detect deleted .md file', async () => {
      const testFile = path.join(collectionPath, 'to-delete.md');
      fs.writeFileSync(testFile, '# To Delete');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.unlinkSync(testFile);

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });

    it('should ignore non-.md files', async () => {
      const mdFile = path.join(collectionPath, 'existing.md');
      fs.writeFileSync(mdFile, '# Existing');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      const testFile = path.join(collectionPath, 'test.txt');
      fs.writeFileSync(testFile, 'Not markdown');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(false);

      watcher.stop();
    });
  });

  describe('triggerReindex', () => {
    it('should process pending changes', async () => {
      const testFile = path.join(collectionPath, 'test.md');
      fs.writeFileSync(testFile, '# Test Document\n\nContent here');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await watcher.triggerReindex();

      expect(mockStore.insertContent).toHaveBeenCalled();
      expect(mockStore.insertDocument).toHaveBeenCalled();
      expect(mockStore.bulkDeactivateExcept).toHaveBeenCalled();

      watcher.stop();
    });

    it('should update lastReindexAt timestamp', async () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      const statsBefore = watcher.getStats();
      expect(statsBefore.lastReindexAt).toBeNull();

      await watcher.triggerReindex();

      const statsAfter = watcher.getStats();
      expect(statsAfter.lastReindexAt).not.toBeNull();
      expect(statsAfter.lastReindexAt).toBeGreaterThan(0);

      watcher.stop();
    });

    it('should not reindex if already reindexing', async () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      const reindex1 = watcher.triggerReindex();
      const reindex2 = watcher.triggerReindex();

      await Promise.all([reindex1, reindex2]);

      watcher.stop();
    });

    it('should handle missing files gracefully', async () => {
      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'test-collection',
        path: path.join(collectionPath, 'missing.md'),
        title: 'Missing',
        hash: 'abc123',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      await expect(watcher.triggerReindex()).resolves.not.toThrow();

      watcher.stop();
    });
  });

  describe('stop', () => {
    it('should clean up watcher and intervals', async () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
        pollIntervalMs: 500,
        sessionPollMs: 500,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      watcher.stop();

      const testFile = path.join(collectionPath, 'after-stop.md');
      fs.writeFileSync(testFile, '# After Stop');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(watcher.isDirty()).toBe(false);
    });

    it('should prevent reindex after stop', async () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      watcher.stop();

      await watcher.triggerReindex();

      expect(mockStore.insertContent).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      const stats = watcher.getStats();

      expect(stats).toHaveProperty('filesWatched');
      expect(stats).toHaveProperty('lastReindexAt');
      expect(stats).toHaveProperty('pendingChanges');
      expect(stats).toHaveProperty('isReindexing');

      expect(typeof stats.filesWatched).toBe('number');
      expect(stats.pendingChanges).toBe(0);
      expect(stats.isReindexing).toBe(false);

      watcher.stop();
    });

    it('should track pending changes count', async () => {
      const testFile1 = path.join(collectionPath, 'test1.md');
      const testFile2 = path.join(collectionPath, 'test2.md');

      fs.writeFileSync(testFile1, '# Test 1');
      fs.writeFileSync(testFile2, '# Test 2');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.writeFileSync(testFile1, '# Test 1 Modified');
      fs.writeFileSync(testFile2, '# Test 2 Modified');

      await new Promise(resolve => setTimeout(resolve, 400));

      const stats = watcher.getStats();
      expect(stats.pendingChanges).toBeGreaterThan(0);

      watcher.stop();
    });
  });

  describe('onUpdate callback', () => {
    it('should call onUpdate for changed files', async () => {
      const testFile = path.join(collectionPath, 'callback-test.md');
      fs.writeFileSync(testFile, '# Callback Test');

      const onUpdate = vi.fn();
      const watcher = startWatcher({
        store: mockStore,
        collections,
        onUpdate,
        debounceMs: 100,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.writeFileSync(testFile, '# Callback Test Modified');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(onUpdate).toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('integrity check', () => {
    it('should detect hash mismatches on startup', async () => {
      const testFile = path.join(collectionPath, 'existing.md');
      fs.writeFileSync(testFile, '# Modified Content');

      vi.mocked(mockStore.getIndexHealth).mockReturnValue({
        documentCount: 1,
        chunkCount: 1,
        pendingEmbeddings: 0,
        collections: [
          {
            name: 'test-collection',
            documentCount: 1,
            path: collectionPath,
          },
        ],
        databaseSize: 1024,
        modelStatus: {
          embedding: 'missing',
          reranker: 'missing',
          expander: 'missing',
        },
      });

      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'test-collection',
        path: testFile,
        title: 'Existing',
        hash: 'old-hash-that-does-not-match',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });
  });

  describe('multiple collections', () => {
    it('should watch multiple collection paths', async () => {
      const collection2Path = path.join(tmpDir, 'docs2');
      fs.mkdirSync(collection2Path, { recursive: true });

      const testFile1 = path.join(collectionPath, 'test1.md');
      const testFile2 = path.join(collection2Path, 'test2.md');

      fs.writeFileSync(testFile1, '# Test 1');
      fs.writeFileSync(testFile2, '# Test 2');

      const multiCollections: Collection[] = [
        {
          name: 'collection1',
          path: collectionPath,
          pattern: '**/*.md',
        },
        {
          name: 'collection2',
          path: collection2Path,
          pattern: '**/*.md',
        },
      ];

      const watcher = startWatcher({
        store: mockStore,
        collections: multiCollections,
        debounceMs: 100,
      });

      const stats = watcher.getStats();
      expect(stats.filesWatched).toBe(2);

      await new Promise(resolve => setTimeout(resolve, 200));

      fs.writeFileSync(testFile1, '# Test 1 Modified');
      fs.writeFileSync(testFile2, '# Test 2 Modified');

      await new Promise(resolve => setTimeout(resolve, 400));

      expect(watcher.isDirty()).toBe(true);

      watcher.stop();
    });
  });

  describe('edge cases', () => {
    it('should handle empty collections array', () => {
      const watcher = startWatcher({
        store: mockStore,
        collections: [],
      });

      expect(watcher.isDirty()).toBe(false);

      watcher.stop();
    });

    it('should handle non-existent collection path', () => {
      const nonExistentCollections: Collection[] = [
        {
          name: 'non-existent',
          path: '/path/that/does/not/exist',
          pattern: '**/*.md',
        },
      ];

      const watcher = startWatcher({
        store: mockStore,
        collections: nonExistentCollections,
      });

      expect(watcher.getStats().filesWatched).toBe(0);

      watcher.stop();
    });

    it('should handle files without markdown headers', async () => {
      const testFile = path.join(collectionPath, 'no-header.md');
      fs.writeFileSync(testFile, 'Just plain text without headers');

      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      await watcher.triggerReindex();

      expect(mockStore.insertDocument).toHaveBeenCalled();

      watcher.stop();
    });
  });
  
  describe('auto-embed', () => {
    it('should embed new chunks when embedder is provided', async () => {
      const testFile = path.join(collectionPath, 'embed-test.md');
      fs.writeFileSync(testFile, '# Embed Test\n\nContent to embed');

      const mockEmbedder = {
        embed: vi.fn().mockResolvedValue({ embedding: new Array(768).fill(0.1), model: 'test-model' }),
      };

      // embedPendingCodebase calls getNextHashNeedingEmbedding in a loop
      vi.mocked(mockStore.getNextHashNeedingEmbedding)
        .mockReturnValueOnce({ hash: 'abc123', body: 'Content to embed', path: testFile })
        .mockReturnValue(null);

      const watcher = startWatcher({
        store: mockStore,
        collections,
        embedder: mockEmbedder,
      });

      await watcher.triggerReindex();

      expect(mockEmbedder.embed).toHaveBeenCalled();
      expect(mockStore.insertEmbedding).toHaveBeenCalled();

      watcher.stop();
    });

    it('should skip embedding when no embedder provided', async () => {
      const testFile = path.join(collectionPath, 'no-embed.md');
      fs.writeFileSync(testFile, '# No Embed\n\nContent');

      const watcher = startWatcher({
        store: mockStore,
        collections,
      });

      await watcher.triggerReindex();

      expect(mockStore.insertEmbedding).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should handle embedding errors gracefully', async () => {
      const testFile = path.join(collectionPath, 'error-embed.md');
      fs.writeFileSync(testFile, '# Error Embed\n\nContent');

      const mockEmbedder = {
        embed: vi.fn().mockRejectedValue(new Error('Model unavailable')),
      };

      vi.mocked(mockStore.getNextHashNeedingEmbedding)
        .mockReturnValueOnce({ hash: 'abc123', body: 'Content', path: testFile })
        .mockReturnValue(null);

      const watcher = startWatcher({
        store: mockStore,
        collections,
        embedder: mockEmbedder,
      });

      await expect(watcher.triggerReindex()).resolves.not.toThrow();

      watcher.stop();
    });
  });
  describe('session projectHash extraction', () => {
    it('should extract projectHash from session file paths during reindex', async () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const hash1Dir = path.join(sessionsDir, 'aaa111bbb222');
      const hash2Dir = path.join(sessionsDir, 'ccc333ddd444');
      fs.mkdirSync(hash1Dir, { recursive: true });
      fs.mkdirSync(hash2Dir, { recursive: true });

      const sessionA = path.join(hash1Dir, '2026-02-16-session-a.md');
      const sessionB = path.join(hash2Dir, '2026-02-16-session-b.md');
      fs.writeFileSync(sessionA, '# Session A\n\nContent A');
      fs.writeFileSync(sessionB, '# Session B\n\nContent B');

      const sessionsCollection: Collection[] = [{
        name: 'sessions',
        path: sessionsDir,
        pattern: '**/*.md',
      }];

      const watcher = startWatcher({
        store: mockStore,
        collections: sessionsCollection,
        outputDir: sessionsDir,
        projectHash: 'zzz999yyy888',
      });

      await watcher.triggerReindex();

      const calls = vi.mocked(mockStore.insertDocument).mock.calls;
      const sessionACall = calls.find(call => (call[0] as { path: string }).path.includes('session-a.md'));
      const sessionBCall = calls.find(call => (call[0] as { path: string }).path.includes('session-b.md'));

      expect(sessionACall).toBeDefined();
      expect(sessionBCall).toBeDefined();
      expect((sessionACall![0] as { projectHash?: string }).projectHash).toBe('aaa111bbb222');
      expect((sessionBCall![0] as { projectHash?: string }).projectHash).toBe('ccc333ddd444');

      watcher.stop();
    });

    it('should fall back to watcher projectHash for non-session collections', async () => {
      const testFile = path.join(collectionPath, 'test.md');
      fs.writeFileSync(testFile, '# Test\n\nContent');

      const watcher = startWatcher({
        store: mockStore,
        collections,
        projectHash: 'mywkspace123',
      });

      await watcher.triggerReindex();

      const calls = vi.mocked(mockStore.insertDocument).mock.calls;
      const testCall = calls.find(call => (call[0] as { path: string }).path.includes('test.md'));

      expect(testCall).toBeDefined();
      expect((testCall![0] as { projectHash?: string }).projectHash).toBe('mywkspace123');

      watcher.stop();
    });
  });
});
