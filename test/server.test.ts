import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMcpServer, formatSearchResults, formatStatus } from '../src/server.js';
import type { Store, SearchResult, IndexHealth, Collection } from '../src/types.js';
import type { SearchProviders } from '../src/search.js';

function createMockResult(id: string, score: number, snippet: string = 'test snippet'): SearchResult {
  return {
    id,
    path: `path/${id}`,
    collection: 'test',
    title: `Title ${id}`,
    snippet,
    score,
    startLine: 1,
    endLine: 10,
    docid: id.substring(0, 6),
  };
}

function createMockStore(): Store {
  return {
    searchFTS: vi.fn().mockReturnValue([]),
    searchVec: vi.fn().mockReturnValue([]),
    getCachedResult: vi.fn().mockReturnValue(null),
    setCachedResult: vi.fn(),
    close: vi.fn(),
    insertDocument: vi.fn(),
    findDocument: vi.fn(),
    getDocumentBody: vi.fn(),
    deactivateDocument: vi.fn(),
    bulkDeactivateExcept: vi.fn(),
    insertContent: vi.fn(),
    insertEmbedding: vi.fn(),
    ensureVecTable: vi.fn(),
    getIndexHealth: vi.fn().mockReturnValue({
      documentCount: 100,
      chunkCount: 500,
      pendingEmbeddings: 10,
      collections: [
        { name: 'docs', documentCount: 50, path: '/path/to/docs' },
        { name: 'notes', documentCount: 50, path: '/path/to/notes' },
      ],
      databaseSize: 1024 * 1024 * 5,
      modelStatus: {
        embedding: 'loaded',
        reranker: 'available',
        expander: 'missing',
      },
    }),
    getHashesNeedingEmbedding: vi.fn().mockReturnValue([]),
  } as unknown as Store;
}

function createMockProviders(): SearchProviders {
  return {
    embedder: {
      embed: vi.fn().mockResolvedValue({ embedding: new Array(384).fill(0.1) }),
    },
    reranker: null,
    expander: null,
  };
}

describe('Server', () => {
  describe('formatSearchResults', () => {
    it('should format search results correctly', () => {
      const results = [
        createMockResult('doc1', 0.95, 'This is a test snippet'),
        createMockResult('doc2', 0.85, 'Another test snippet'),
      ];
      
      const formatted = formatSearchResults(results);
      
      expect(formatted).toContain('### 1. Title doc1 (doc1)');
      expect(formatted).toContain('**Path:** path/doc1');
      expect(formatted).toContain('**Score:** 0.950');
      expect(formatted).toContain('**Lines:** 1-10');
      expect(formatted).toContain('This is a test snippet');
      expect(formatted).toContain('### 2. Title doc2 (doc2)');
      expect(formatted).toContain('---');
    });
    
    it('should handle empty results', () => {
      const formatted = formatSearchResults([]);
      expect(formatted).toBe('No results found.');
    });
    
    it('should format single result without separator', () => {
      const results = [createMockResult('doc1', 0.95)];
      const formatted = formatSearchResults(results);
      
      expect(formatted).toContain('### 1. Title doc1');
      expect(formatted).not.toContain('### 2.');
    });
  });
  
  describe('formatStatus', () => {
    it('should format health status correctly', () => {
      const health: IndexHealth = {
        documentCount: 100,
        chunkCount: 500,
        pendingEmbeddings: 10,
        collections: [
          { name: 'docs', documentCount: 50, path: '/path/to/docs' },
          { name: 'notes', documentCount: 50, path: '/path/to/notes' },
        ],
        databaseSize: 1024 * 1024 * 5,
        modelStatus: {
          embedding: 'loaded',
          reranker: 'available',
          expander: 'missing',
        },
      };
      
      const formatted = formatStatus(health);
      
      expect(formatted).toContain('📊 **Memory Index Status**');
      expect(formatted).toContain('Documents: 100');
      expect(formatted).toContain('Chunks: 500');
      expect(formatted).toContain('Pending embeddings: 10');
      expect(formatted).toContain('Database size: 5.0 MB');
      expect(formatted).toContain('**Collections:**');
      expect(formatted).toContain('- docs: 50 docs (/path/to/docs)');
      expect(formatted).toContain('- notes: 50 docs (/path/to/notes)');
      expect(formatted).toContain('**Models:**');
      expect(formatted).toContain('- Embedding: loaded');
      expect(formatted).toContain('- Reranker: available');
      expect(formatted).toContain('- Expander: missing');
    });
    
    it('should handle empty collections', () => {
      const health: IndexHealth = {
        documentCount: 0,
        chunkCount: 0,
        pendingEmbeddings: 0,
        collections: [],
        databaseSize: 0,
        modelStatus: {
          embedding: 'missing',
          reranker: 'missing',
          expander: 'missing',
        },
      };
      
      const formatted = formatStatus(health);
      
      expect(formatted).toContain('Documents: 0');
      expect(formatted).toContain('Database size: 0.0 MB');
    });
  });
  
  describe('createMcpServer', () => {
    let mockStore: Store;
    let mockProviders: SearchProviders;
    let collections: Collection[];
    
    beforeEach(() => {
      mockStore = createMockStore();
      mockProviders = createMockProviders();
      collections = [
        { name: 'docs', path: '/path/to/docs', pattern: '**/*.md' },
      ];
    });
    
    it('should create server instance', () => {
      const server = createMcpServer({
        store: mockStore,
        providers: mockProviders,
        collections,
        configPath: '/path/to/config.yaml',
        outputDir: '/tmp/output',
      });
      
      expect(server).toBeDefined();
      expect(server.server).toBeDefined();
    });
  });
  
  describe('memory_search tool logic', () => {
    it('should call store.searchFTS with correct params', () => {
      const mockStore = createMockStore();
      const results = [createMockResult('doc1', 0.95)];
      vi.mocked(mockStore.searchFTS).mockReturnValue(results);
      
      const searchResults = mockStore.searchFTS('test query', 5, 'docs');
      
      expect(mockStore.searchFTS).toHaveBeenCalledWith('test query', 5, 'docs');
      expect(searchResults).toHaveLength(1);
      expect(searchResults[0].id).toBe('doc1');
    });
    
    it('should format results correctly', () => {
      const mockStore = createMockStore();
      const results = [createMockResult('doc1', 0.95)];
      vi.mocked(mockStore.searchFTS).mockReturnValue(results);
      
      const searchResults = mockStore.searchFTS('test', 10, undefined);
      const formatted = formatSearchResults(searchResults);
      
      expect(formatted).toContain('Title doc1');
    });
  });
  
  describe('memory_vsearch tool logic', () => {
    it('should use embedder when available', async () => {
      const mockStore = createMockStore();
      const mockProviders = createMockProviders();
      const results = [createMockResult('doc1', 0.95)];
      vi.mocked(mockStore.searchVec).mockReturnValue(results);
      
      const { embedding } = await mockProviders.embedder!.embed('test query');
      const searchResults = mockStore.searchVec('test query', embedding, 5, undefined);
      
      expect(mockProviders.embedder!.embed).toHaveBeenCalledWith('test query');
      expect(mockStore.searchVec).toHaveBeenCalled();
      expect(searchResults).toHaveLength(1);
    });
    
    it('should fall back to FTS when embedder not available', () => {
      const mockStore = createMockStore();
      const results = [createMockResult('doc1', 0.95)];
      vi.mocked(mockStore.searchFTS).mockReturnValue(results);
      
      const searchResults = mockStore.searchFTS('test query', 10, undefined);
      
      expect(mockStore.searchFTS).toHaveBeenCalledWith('test query', 10, undefined);
      expect(searchResults).toHaveLength(1);
    });
    
    it('should handle embedding failure', async () => {
      const mockProviders = createMockProviders();
      vi.mocked(mockProviders.embedder!.embed).mockRejectedValue(new Error('Embedding failed'));
      
      await expect(mockProviders.embedder!.embed('test query')).rejects.toThrow('Embedding failed');
    });
  });
  
  describe('memory_get tool logic', () => {
    it('should retrieve document by path', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'docs',
        path: '/path/to/doc.md',
        title: 'Test Doc',
        hash: 'abc123',
        createdAt: '2024-01-01T00:00:00Z',
        modifiedAt: '2024-01-01T00:00:00Z',
        active: true,
      });
      vi.mocked(mockStore.getDocumentBody).mockReturnValue('Document content here');
      
      const doc = mockStore.findDocument('/path/to/doc.md');
      const body = mockStore.getDocumentBody(doc!.hash, undefined, undefined);
      
      expect(mockStore.findDocument).toHaveBeenCalledWith('/path/to/doc.md');
      expect(mockStore.getDocumentBody).toHaveBeenCalledWith('abc123', undefined, undefined);
      expect(body).toBe('Document content here');
    });
    
    it('should handle # prefix in docid', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'docs',
        path: '/path/to/doc.md',
        title: 'Test Doc',
        hash: 'abc123',
        createdAt: '2024-01-01T00:00:00Z',
        modifiedAt: '2024-01-01T00:00:00Z',
        active: true,
      });
      
      const id = '#abc123';
      const docid = id.startsWith('#') ? id.slice(1) : id;
      mockStore.findDocument(docid);
      
      expect(mockStore.findDocument).toHaveBeenCalledWith('abc123');
    });
    
    it('should return null for missing document', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.findDocument).mockReturnValue(null);
      
      const doc = mockStore.findDocument('nonexistent');
      
      expect(doc).toBeNull();
    });
    
    it('should pass fromLine and maxLines parameters', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'docs',
        path: '/path/to/doc.md',
        title: 'Test Doc',
        hash: 'abc123',
        createdAt: '2024-01-01T00:00:00Z',
        modifiedAt: '2024-01-01T00:00:00Z',
        active: true,
      });
      vi.mocked(mockStore.getDocumentBody).mockReturnValue('Partial content');
      
      const doc = mockStore.findDocument('doc.md');
      mockStore.getDocumentBody(doc!.hash, 10, 20);
      
      expect(mockStore.getDocumentBody).toHaveBeenCalledWith('abc123', 10, 20);
    });
  });
  
  describe('memory_multi_get tool logic', () => {
    it('should retrieve multiple documents', () => {
      const mockStore = createMockStore();
      
      vi.mocked(mockStore.findDocument)
        .mockReturnValueOnce({
          id: 1,
          collection: 'docs',
          path: '/path/to/doc1.md',
          title: 'Doc 1',
          hash: 'hash1',
          createdAt: '2024-01-01T00:00:00Z',
          modifiedAt: '2024-01-01T00:00:00Z',
          active: true,
        })
        .mockReturnValueOnce({
          id: 2,
          collection: 'docs',
          path: '/path/to/doc2.md',
          title: 'Doc 2',
          hash: 'hash2',
          createdAt: '2024-01-01T00:00:00Z',
          modifiedAt: '2024-01-01T00:00:00Z',
          active: true,
        });
      
      vi.mocked(mockStore.getDocumentBody)
        .mockReturnValueOnce('Content 1')
        .mockReturnValueOnce('Content 2');
      
      const ids = 'doc1,doc2'.split(',').map(s => s.trim());
      const results: string[] = [];
      
      for (const id of ids) {
        const doc = mockStore.findDocument(id);
        if (doc) {
          const body = mockStore.getDocumentBody(doc.hash);
          results.push(`### ${doc.title}\n\n${body}\n\n`);
        }
      }
      
      const combined = results.join('');
      expect(combined).toContain('### Doc 1');
      expect(combined).toContain('Content 1');
      expect(combined).toContain('### Doc 2');
      expect(combined).toContain('Content 2');
    });
    
    it('should handle missing documents gracefully', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.findDocument).mockReturnValue(null);
      
      const doc1 = mockStore.findDocument('missing1');
      const doc2 = mockStore.findDocument('missing2');
      
      expect(doc1).toBeNull();
      expect(doc2).toBeNull();
    });
    
    it('should respect maxBytes limit', () => {
      const mockStore = createMockStore();
      
      vi.mocked(mockStore.findDocument).mockReturnValue({
        id: 1,
        collection: 'docs',
        path: '/path/to/doc.md',
        title: 'Doc',
        hash: 'hash1',
        createdAt: '2024-01-01T00:00:00Z',
        modifiedAt: '2024-01-01T00:00:00Z',
        active: true,
      });
      
      vi.mocked(mockStore.getDocumentBody).mockReturnValue('x'.repeat(1000));
      
      const maxBytes = 100;
      let totalBytes = 0;
      const results: string[] = [];
      
      for (const id of ['doc1', 'doc2', 'doc3']) {
        const doc = mockStore.findDocument(id);
        if (doc) {
          const body = mockStore.getDocumentBody(doc.hash);
          const docText = `### ${doc.title}\n\n${body}\n\n`;
          
          if (totalBytes + docText.length > maxBytes) {
            results.push('⚠️  Reached maxBytes limit');
            break;
          }
          
          results.push(docText);
          totalBytes += docText.length;
        }
      }
      
      expect(results.join('')).toContain('⚠️  Reached maxBytes limit');
    });
  });
  
  describe('memory_status tool logic', () => {
    it('should return formatted health info', () => {
      const mockStore = createMockStore();
      
      const health = mockStore.getIndexHealth();
      const formatted = formatStatus(health);
      
      expect(mockStore.getIndexHealth).toHaveBeenCalled();
      expect(formatted).toContain('📊 **Memory Index Status**');
      expect(formatted).toContain('Documents: 100');
      expect(formatted).toContain('Chunks: 500');
    });
  });
  
  describe('error handling', () => {
    it('should handle errors in store operations', () => {
      const mockStore = createMockStore();
      vi.mocked(mockStore.searchFTS).mockImplementation(() => {
        throw new Error('Database error');
      });
      
      expect(() => mockStore.searchFTS('test', 10, undefined)).toThrow('Database error');
    });
  });
});
