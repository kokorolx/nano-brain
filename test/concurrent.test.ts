import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

describe('Concurrent Operations', () => {
  let store: Store;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-concurrent-'));
    dbPath = path.join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('parallel insertDocument', () => {
    it('should handle 10 concurrent document inserts', async () => {
      const insertPromises = Array.from({ length: 10 }, (_, i) => {
        return new Promise<number>((resolve) => {
          const content = `Document ${i} content for concurrent test`;
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          store.insertContent(hash, content);
          const id = store.insertDocument({
            collection: 'concurrent-test',
            path: `/test/doc${i}.md`,
            title: `Document ${i}`,
            hash,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            active: true,
          });
          resolve(id);
        });
      });

      const ids = await Promise.all(insertPromises);
      expect(ids.length).toBe(10);
      expect(new Set(ids).size).toBe(10);
      const health = store.getIndexHealth();
      expect(health.documentCount).toBe(10);
    });

    it('should handle rapid sequential inserts without corruption', async () => {
      const results: number[] = [];
      for (let i = 0; i < 20; i++) {
        const content = `Rapid insert ${i}`;
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        store.insertContent(hash, content);
        const id = store.insertDocument({
          collection: 'rapid-test',
          path: `/rapid/doc${i}.md`,
          title: `Rapid ${i}`,
          hash,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        results.push(id);
      }
      expect(results.length).toBe(20);
      expect(new Set(results).size).toBe(20);
    });
  });

  describe('parallel searchFTS', () => {
    it('should handle 5 concurrent searches', async () => {
      const content = 'Searchable content for parallel FTS testing';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'search-test',
        path: '/search/doc.md',
        title: 'Searchable Document',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const searchPromises = Array.from({ length: 5 }, () => {
        return new Promise<number>((resolve) => {
          const results = store.searchFTS('Searchable', { limit: 10 });
          resolve(results.length);
        });
      });

      const counts = await Promise.all(searchPromises);
      counts.forEach((count) => {
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    it('should search while inserting documents', async () => {
      const baseContent = 'Base document for concurrent search-insert test';
      const baseHash = crypto.createHash('sha256').update(baseContent).digest('hex');
      store.insertContent(baseHash, baseContent);
      store.insertDocument({
        collection: 'concurrent-search',
        path: '/concurrent/base.md',
        title: 'Base Document',
        hash: baseHash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const operations = [
        ...Array.from({ length: 3 }, (_, i) => {
          return new Promise<void>((resolve) => {
            const content = `New document ${i} for concurrent test`;
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            store.insertContent(hash, content);
            store.insertDocument({
              collection: 'concurrent-search',
              path: `/concurrent/new${i}.md`,
              title: `New Document ${i}`,
              hash,
              createdAt: new Date().toISOString(),
              modifiedAt: new Date().toISOString(),
              active: true,
            });
            resolve();
          });
        }),
        ...Array.from({ length: 3 }, () => {
          return new Promise<void>((resolve) => {
            store.searchFTS('document', { limit: 10 });
            resolve();
          });
        }),
      ];

      await Promise.allSettled(operations);
      const health = store.getIndexHealth();
      expect(health.documentCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('parallel insertEmbedding', () => {
    it('should handle concurrent embedding inserts', async () => {
      store.ensureVecTable(384);

      const docs = Array.from({ length: 5 }, (_, i) => {
        const content = `Embedding document ${i}`;
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        store.insertContent(hash, content);
        store.insertDocument({
          collection: 'embedding-test',
          path: `/embed/doc${i}.md`,
          title: `Embed Doc ${i}`,
          hash,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
        });
        return { hash, content };
      });

      const embeddingPromises = docs.map((doc) => {
        return new Promise<void>((resolve) => {
          const embedding = new Array(384).fill(0).map(() => Math.random());
          store.insertEmbedding(doc.hash, 0, 0, embedding, 'test-model');
          resolve();
        });
      });

      await Promise.all(embeddingPromises);
      const health = store.getIndexHealth();
      expect(health.embeddedCount).toBe(5);
    });
  });

  describe('race conditions', () => {
    it('should handle insert and deactivate on same document', async () => {
      const content = 'Race condition test document';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'race-test',
        path: '/race/doc.md',
        title: 'Race Document',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const operations = [
        new Promise<void>((resolve) => {
          store.deactivateDocument('race-test', '/race/doc.md');
          resolve();
        }),
        new Promise<void>((resolve) => {
          const newContent = 'Updated race condition content';
          const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
          store.insertContent(newHash, newContent);
          store.insertDocument({
            collection: 'race-test',
            path: '/race/doc.md',
            title: 'Race Document Updated',
            hash: newHash,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            active: true,
          });
          resolve();
        }),
      ];

      await Promise.allSettled(operations);
      const doc = store.findDocument('/race/doc.md');
      expect(doc).not.toBeNull();
    });

    it('should handle concurrent cache operations', async () => {
      const cacheOps = Array.from({ length: 10 }, (_, i) => {
        return new Promise<void>((resolve) => {
          const hash = crypto.createHash('sha256').update(`cache-${i}`).digest('hex');
          store.setCachedResult(hash, JSON.stringify({ result: i }));
          const cached = store.getCachedResult(hash);
          expect(cached).not.toBeNull();
          resolve();
        });
      });

      await Promise.all(cacheOps);
    });
  });

  describe('data integrity', () => {
    it('should maintain data integrity after concurrent writes', async () => {
      const docCount = 15;
      const insertOps = Array.from({ length: docCount }, (_, i) => {
        return new Promise<string>((resolve) => {
          const content = `Integrity test document ${i} with unique content`;
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          store.insertContent(hash, content);
          store.insertDocument({
            collection: 'integrity-test',
            path: `/integrity/doc${i}.md`,
            title: `Integrity Doc ${i}`,
            hash,
            createdAt: new Date().toISOString(),
            modifiedAt: new Date().toISOString(),
            active: true,
          });
          resolve(hash);
        });
      });

      const hashes = await Promise.all(insertOps);
      expect(hashes.length).toBe(docCount);

      for (let i = 0; i < docCount; i++) {
        const doc = store.findDocument(`/integrity/doc${i}.md`);
        expect(doc).not.toBeNull();
        expect(doc?.title).toBe(`Integrity Doc ${i}`);
        const body = store.getDocumentBody(hashes[i]);
        expect(body).toContain(`Integrity test document ${i}`);
      }
    });

    it('should not lose documents during concurrent operations', async () => {
      const operations: Promise<void>[] = [];

      for (let i = 0; i < 10; i++) {
        operations.push(
          new Promise<void>((resolve) => {
            const content = `Loss test ${i}`;
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            store.insertContent(hash, content);
            store.insertDocument({
              collection: 'loss-test',
              path: `/loss/doc${i}.md`,
              title: `Loss Doc ${i}`,
              hash,
              createdAt: new Date().toISOString(),
              modifiedAt: new Date().toISOString(),
              active: true,
            });
            resolve();
          })
        );
      }

      for (let i = 0; i < 5; i++) {
        operations.push(
          new Promise<void>((resolve) => {
            store.searchFTS('Loss', { limit: 20 });
            resolve();
          })
        );
      }

      await Promise.allSettled(operations);
      const health = store.getIndexHealth();
      expect(health.documentCount).toBe(10);
    });
  });
});
