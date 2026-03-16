import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStore, computeHash } from '../src/store.js'
import type { Store } from '../src/types.js'
import type { LLMProvider } from '../src/consolidation.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('categorize-backfill', () => {
  let store: Store
  let dbPath: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-backfill-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('getUncategorizedDocuments', () => {
    it('returns documents without llm: tags', () => {
      const content1 = 'Document without tags'
      const hash1 = computeHash(content1)
      store.insertContent(hash1, content1)
      const docId1 = store.insertDocument({
        collection: 'memory',
        path: '/test/doc1.md',
        title: 'Doc 1',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })

      const content2 = 'Document with llm tag'
      const hash2 = computeHash(content2)
      store.insertContent(hash2, content2)
      const docId2 = store.insertDocument({
        collection: 'memory',
        path: '/test/doc2.md',
        title: 'Doc 2',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })
      store.insertTags(docId2, ['llm:architecture-decision'])

      const uncategorized = store.getUncategorizedDocuments(100)
      expect(uncategorized).toHaveLength(1)
      expect(uncategorized[0].id).toBe(docId1)
      expect(uncategorized[0].path).toBe('/test/doc1.md')
    })

    it('returns empty array when all documents have llm: tags', () => {
      const content = 'Tagged document'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      const docId = store.insertDocument({
        collection: 'memory',
        path: '/test/doc.md',
        title: 'Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })
      store.insertTags(docId, ['llm:debugging-insight'])

      const uncategorized = store.getUncategorizedDocuments(100)
      expect(uncategorized).toHaveLength(0)
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const content = `Document ${i}`
        const hash = computeHash(content)
        store.insertContent(hash, content)
        store.insertDocument({
          collection: 'memory',
          path: `/test/doc${i}.md`,
          title: `Doc ${i}`,
          hash,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          active: true,
          projectHash: 'test123',
        })
      }

      const uncategorized = store.getUncategorizedDocuments(3)
      expect(uncategorized).toHaveLength(3)
    })

    it('filters by projectHash when provided', () => {
      const content1 = 'Project A doc'
      const hash1 = computeHash(content1)
      store.insertContent(hash1, content1)
      store.insertDocument({
        collection: 'memory',
        path: '/test/docA.md',
        title: 'Doc A',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'projectA123',
      })

      const content2 = 'Project B doc'
      const hash2 = computeHash(content2)
      store.insertContent(hash2, content2)
      store.insertDocument({
        collection: 'memory',
        path: '/test/docB.md',
        title: 'Doc B',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'projectB456',
      })

      const uncategorizedA = store.getUncategorizedDocuments(100, 'projectA123')
      expect(uncategorizedA).toHaveLength(1)
      expect(uncategorizedA[0].path).toBe('/test/docA.md')

      const uncategorizedB = store.getUncategorizedDocuments(100, 'projectB456')
      expect(uncategorizedB).toHaveLength(1)
      expect(uncategorizedB[0].path).toBe('/test/docB.md')
    })

    it('includes global documents when filtering by projectHash', () => {
      const content1 = 'Global doc'
      const hash1 = computeHash(content1)
      store.insertContent(hash1, content1)
      store.insertDocument({
        collection: 'memory',
        path: '/test/global.md',
        title: 'Global',
        hash: hash1,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'global',
      })

      const content2 = 'Project doc'
      const hash2 = computeHash(content2)
      store.insertContent(hash2, content2)
      store.insertDocument({
        collection: 'memory',
        path: '/test/project.md',
        title: 'Project',
        hash: hash2,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'project123',
      })

      const uncategorized = store.getUncategorizedDocuments(100, 'project123')
      expect(uncategorized).toHaveLength(2)
    })

    it('excludes inactive documents', () => {
      const content = 'Inactive doc'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      store.insertDocument({
        collection: 'memory',
        path: '/test/inactive.md',
        title: 'Inactive',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: false,
        projectHash: 'test123',
      })

      const uncategorized = store.getUncategorizedDocuments(100)
      expect(uncategorized).toHaveLength(0)
    })

    it('includes document body in results', () => {
      const content = 'This is the document body content'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      store.insertDocument({
        collection: 'memory',
        path: '/test/doc.md',
        title: 'Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })

      const uncategorized = store.getUncategorizedDocuments(100)
      expect(uncategorized).toHaveLength(1)
      expect(uncategorized[0].body).toBe(content)
    })

    it('ignores non-llm tags when determining uncategorized status', () => {
      const content = 'Doc with regular tag'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      const docId = store.insertDocument({
        collection: 'memory',
        path: '/test/doc.md',
        title: 'Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })
      store.insertTags(docId, ['decision', 'auth', 'important'])

      const uncategorized = store.getUncategorizedDocuments(100)
      expect(uncategorized).toHaveLength(1)
    })
  })

  describe('insertTags for backfill', () => {
    it('inserts llm: prefixed tags correctly', () => {
      const content = 'Test document'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      const docId = store.insertDocument({
        collection: 'memory',
        path: '/test/doc.md',
        title: 'Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })

      store.insertTags(docId, ['llm:architecture-decision', 'llm:pattern'])

      const tags = store.getDocumentTags(docId)
      expect(tags).toContain('llm:architecture-decision')
      expect(tags).toContain('llm:pattern')
    })

    it('handles duplicate tag insertion gracefully', () => {
      const content = 'Test document'
      const hash = computeHash(content)
      store.insertContent(hash, content)
      const docId = store.insertDocument({
        collection: 'memory',
        path: '/test/doc.md',
        title: 'Doc',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'test123',
      })

      store.insertTags(docId, ['llm:pattern'])
      store.insertTags(docId, ['llm:pattern'])

      const tags = store.getDocumentTags(docId)
      expect(tags.filter(t => t === 'llm:pattern')).toHaveLength(1)
    })
  })
})
