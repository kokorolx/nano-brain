export interface SearchResult {
  id: string;
  path: string;
  collection: string;
  title: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
  docid: string;
  agent?: string;
}

export interface Document {
  id: number;
  collection: string;
  path: string;
  title: string;
  hash: string;
  agent?: string;
  createdAt: string;
  modifiedAt: string;
  active: boolean;
  projectHash?: string;
}

export interface MemoryChunk {
  hash: string;
  seq: number;
  pos: number;
  text: string;
  startLine: number;
  endLine: number;
}

export interface BreakPoint {
  pos: number;
  score: number;
  type: string;
  lineNo: number;
}

export interface CodeFenceRegion {
  start: number;
  end: number;
}

export interface Collection {
  name: string;
  path: string;
  pattern: string;
  context?: Record<string, string>;
}

export interface CollectionConfig {
  globalContext?: string
  collections: Record<string, {
    path: string
    pattern?: string
    context?: Record<string, string>
    update?: string
  }>
  storage?: {
    maxSize?: string
    retention?: string
    minFreeDisk?: string
  }
  codebase?: CodebaseConfig
  workspaces?: Record<string, WorkspaceConfig>
  embedding?: EmbeddingConfig
  watcher?: WatcherConfig
}

export interface CodebaseConfig {
  enabled: boolean
  root?: string
  exclude?: string[]
  extensions?: string[]
  maxFileSize?: string
  maxSize?: string
  batchSize?: number
}

export interface WorkspaceConfig {
  codebase?: CodebaseConfig
}

export interface EmbeddingConfig {
  provider?: 'ollama' | 'local' | 'openai'
  url?: string
  model?: string
  apiKey?: string
  maxChars?: number
  rpmLimit?: number
}

export interface WatcherConfig {
  debounceMs?: number
  pollIntervalMs?: number
  sessionPollMs?: number
  embedIntervalMs?: number
}

export interface CodebaseIndexResult {
  filesScanned: number
  filesIndexed: number
  filesSkippedUnchanged: number
  filesSkippedTooLarge: number
  filesSkippedBudget: number
  chunksCreated: number
  storageUsedBytes: number
  maxSizeBytes: number
}

export interface StorageConfig {
  maxSize: number;
  retention: number;
  minFreeDisk: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

export interface RerankResult {
  results: Array<{
    file: string;
    score: number;
    index: number;
  }>;
  model: string;
}

export interface RerankDocument {
  text: string;
  file: string;
  index: number;
}

export interface HarvestedSession {
  sessionId: string;
  slug: string;
  title: string;
  agent: string;
  date: string;
  project: string;
  projectHash: string;
  messages: Array<{
    role: 'user' | 'assistant';
    agent?: string;
    text: string;
  }>;
}

export interface IndexHealth {
  documentCount: number
  embeddedCount: number
  pendingEmbeddings: number
  collections: Array<{
    name: string
    documentCount: number
    path: string
  }>
  databaseSize: number
  modelStatus: {
    embedding: string
    reranker: string
    expander: string
  }
  workspaceStats?: Array<{ projectHash: string; count: number }>
  codebase?: {
    enabled: boolean
    documents: number
    chunks: number
    extensions: string[]
    excludeCount: number
    storageUsed: number
    maxSize: number
  }
}

export interface Store {
  close(): void;
  
  insertDocument(doc: Omit<Document, 'id'>): number;
  findDocument(pathOrDocid: string): Document | null;
  getDocumentBody(hash: string, fromLine?: number, maxLines?: number): string | null;
  deactivateDocument(collection: string, path: string): void;
  bulkDeactivateExcept(collection: string, activePaths: string[]): number;
  
  insertContent(hash: string, body: string): void;
  
  insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string): void;
  ensureVecTable(dimensions: number): void;
  
  searchFTS(query: string, limit?: number, collection?: string, projectHash?: string): SearchResult[];
  searchVec(query: string, embedding: number[], limit?: number, collection?: string, projectHash?: string): SearchResult[];
  
  getCachedResult(hash: string, projectHash?: string): string | null;
  setCachedResult(hash: string, result: string, projectHash?: string, type?: string): void;
  clearCache(projectHash?: string, type?: string): number;
  getCacheStats(): Array<{ type: string; projectHash: string; count: number }>;
  
  getQueryEmbeddingCache(query: string): number[] | null;
  setQueryEmbeddingCache(query: string, embedding: number[]): void;
  clearQueryEmbeddingCache(): void;
  
  getIndexHealth(): IndexHealth;
  getHashesNeedingEmbedding(projectHash?: string): Array<{ hash: string; body: string; path: string }>;
  getNextHashNeedingEmbedding(projectHash?: string): { hash: string; body: string; path: string } | null;
  getWorkspaceStats(): Array<{ projectHash: string; count: number }>;
  
  deleteDocumentsByPath(filePath: string): number;
  clearWorkspace(projectHash: string): { documentsDeleted: number; embeddingsDeleted: number };
  cleanOrphanedEmbeddings(): number;
  getCollectionStorageSize(collection: string): number;
  
  modelStatus: {
    embedding: string;
    reranker: string;
    expander: string;
  };
}
