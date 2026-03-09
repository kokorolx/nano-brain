import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStore, sanitizeFTS5Query } from '../src/store.js';
import { formatSnippet } from '../src/search.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

describe('Unicode and Vietnamese Handling', () => {
  let store: Store;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-unicode-'));
    dbPath = path.join(tempDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Vietnamese diacritics', () => {
    it('should store document with Vietnamese title', () => {
      const content = 'Nội dung tài liệu tiếng Việt với các dấu thanh';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      const id = store.insertDocument({
        collection: 'vietnamese',
        path: '/vn/test.md',
        title: 'Kiểm tra tiếng Việt',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const doc = store.findDocument('/vn/test.md');
      expect(doc?.title).toBe('Kiểm tra tiếng Việt');
    });

    it('should search for Vietnamese text with diacritics', () => {
      const content = 'Đây là nội dung tiếng Việt để kiểm tra tìm kiếm';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'vietnamese',
        path: '/vn/search.md',
        title: 'Tìm kiếm tiếng Việt',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const results = store.searchFTS('tiếng Việt', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle long Vietnamese text (1000+ chars)', () => {
      const longText = 'Đây là một đoạn văn bản tiếng Việt rất dài. '.repeat(50);
      expect(longText.length).toBeGreaterThan(1000);

      const hash = crypto.createHash('sha256').update(longText).digest('hex');
      store.insertContent(hash, longText);
      const id = store.insertDocument({
        collection: 'vietnamese',
        path: '/vn/long.md',
        title: 'Văn bản dài',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const body = store.getDocumentBody(hash);
      expect(body).toBe(longText);
    });

    it('should handle Vietnamese special characters', () => {
      const specialChars = 'ă â đ ê ô ơ ư Ă Â Đ Ê Ô Ơ Ư';
      const hash = crypto.createHash('sha256').update(specialChars).digest('hex');
      store.insertContent(hash, specialChars);
      store.insertDocument({
        collection: 'vietnamese',
        path: '/vn/special.md',
        title: 'Ký tự đặc biệt',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const body = store.getDocumentBody(hash);
      expect(body).toBe(specialChars);
    });
  });

  describe('emoji handling', () => {
    it('should store and retrieve emoji content', () => {
      const content = '🧠 nano-brain test 🚀 with emojis 💡';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      const id = store.insertDocument({
        collection: 'emoji-test',
        path: '/emoji/test.md',
        title: '🧠 Emoji Title',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const doc = store.findDocument('/emoji/test.md');
      expect(doc?.title).toBe('🧠 Emoji Title');
      const body = store.getDocumentBody(hash);
      expect(body).toBe(content);
    });

    it('should handle complex emoji sequences', () => {
      const complexEmoji = '👨‍👩‍👧‍👦 Family 🏳️‍🌈 Flag 👩🏽‍💻 Skin tone';
      const hash = crypto.createHash('sha256').update(complexEmoji).digest('hex');
      store.insertContent(hash, complexEmoji);
      store.insertDocument({
        collection: 'emoji-test',
        path: '/emoji/complex.md',
        title: 'Complex Emoji',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const body = store.getDocumentBody(hash);
      expect(body).toBe(complexEmoji);
    });
  });

  describe('collection and tag names', () => {
    it('should handle collection names with unicode', () => {
      const content = 'Test content for unicode collection';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      const id = store.insertDocument({
        collection: 'bộ-sưu-tập-việt',
        path: '/unicode-col/test.md',
        title: 'Unicode Collection Test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const doc = store.findDocument('/unicode-col/test.md');
      expect(doc?.collection).toBe('bộ-sưu-tập-việt');
    });

    it('should search within unicode collection', () => {
      const content = 'Searchable content in unicode collection';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'tiếng-việt',
        path: '/vn-col/search.md',
        title: 'Search Test',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const results = store.searchFTS('Searchable', { collection: 'tiếng-việt', limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].collection).toBe('tiếng-việt');
    });
  });

  describe('FTS5 query sanitization', () => {
    it('should sanitize Vietnamese input', () => {
      const query = 'tìm kiếm tiếng Việt';
      const sanitized = sanitizeFTS5Query(query);
      expect(sanitized).toBe('"tìm" OR "kiếm" OR "tiếng" OR "Việt"');
    });

    it('should handle Vietnamese with special FTS characters', () => {
      const query = 'AND tiếng Việt OR';
      const sanitized = sanitizeFTS5Query(query);
      expect(sanitized).toBe('"AND" OR "tiếng" OR "Việt" OR "OR"');
    });

    it('should handle emoji in query', () => {
      const query = '🧠 brain test';
      const sanitized = sanitizeFTS5Query(query);
      expect(sanitized).toBe('"🧠" OR "brain" OR "test"');
    });

    it('should handle mixed Vietnamese and English', () => {
      const query = 'Hello xin chào thế giới';
      const sanitized = sanitizeFTS5Query(query);
      expect(sanitized).toBe('"Hello" OR "xin" OR "chào" OR "thế" OR "giới"');
    });
  });

  describe('snippet formatting', () => {
    it('should not break Vietnamese text mid-character', () => {
      const longVietnamese = 'Đây là một đoạn văn bản tiếng Việt rất dài cần được cắt ngắn';
      const snippet = formatSnippet(longVietnamese, 30);
      expect(snippet.length).toBeLessThanOrEqual(33);
      expect(snippet).not.toMatch(/[\uD800-\uDBFF]$/);
    });

    it('should handle emoji in snippets', () => {
      const emojiText = '🧠 This is a test with emoji 🚀 and more text';
      const snippet = formatSnippet(emojiText, 20);
      expect(snippet.length).toBeLessThanOrEqual(23);
    });

    it('should preserve Vietnamese diacritics in snippets', () => {
      const vietnamese = 'Kiểm tra tiếng Việt';
      const snippet = formatSnippet(vietnamese, 100);
      expect(snippet).toContain('Kiểm');
      expect(snippet).toContain('tiếng');
      expect(snippet).toContain('Việt');
    });
  });

  describe('mixed scripts', () => {
    it('should handle CJK + Vietnamese + Latin text', () => {
      const mixedContent = '中文 tiếng Việt English 日本語 한국어';
      const hash = crypto.createHash('sha256').update(mixedContent).digest('hex');
      store.insertContent(hash, mixedContent);
      const id = store.insertDocument({
        collection: 'mixed-scripts',
        path: '/mixed/cjk-vn-en.md',
        title: 'Mixed Scripts',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const body = store.getDocumentBody(hash);
      expect(body).toBe(mixedContent);
    });

    it('should search mixed script content', () => {
      const content = 'Tài liệu với 中文 characters and English';
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'mixed-scripts',
        path: '/mixed/search.md',
        title: 'Mixed Search',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      const results = store.searchFTS('Tài liệu', { limit: 10 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle RTL text with Vietnamese', () => {
      const rtlContent = 'مرحبا tiếng Việt שלום';
      const hash = crypto.createHash('sha256').update(rtlContent).digest('hex');
      store.insertContent(hash, rtlContent);
      const id = store.insertDocument({
        collection: 'rtl-test',
        path: '/rtl/mixed.md',
        title: 'RTL Mixed',
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
      });

      expect(id).toBeGreaterThan(0);
      const body = store.getDocumentBody(hash);
      expect(body).toBe(rtlContent);
    });
  });
});
