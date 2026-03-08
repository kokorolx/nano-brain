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
  projectHash?: string;
  centrality?: number;
  clusterId?: number;
  supersededBy?: number | null;
  symbols?: string[];
  clusterLabel?: string;
  flowCount?: number;
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
  logging?: { enabled?: boolean }
  embedding?: EmbeddingConfig
  watcher?: WatcherConfig
  search?: Partial<SearchConfig>
  vector?: {
    provider: 'sqlite-vec' | 'qdrant'
    url?: string
    apiKey?: string
    collection?: string
    dimensions?: number
  }
  intervals?: {
    embed?: number
    sessionPoll?: number
    reindexPoll?: number
  }
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

export interface StoreSearchOptions {
  limit?: number;
  collection?: string;
  projectHash?: string;
  tags?: string[];
  since?: string;
  until?: string;
}

export interface SearchConfig {
  rrf_k: number;
  top_k: number;
  blending: {
    top3: { rrf: number; rerank: number };
    mid: { rrf: number; rerank: number };
    tail: { rrf: number; rerank: number };
  };
  expansion: {
    enabled: boolean;
    weight: number;
  };
  reranking: {
    enabled: boolean;
  };
  centrality_weight: number;
  supersede_demotion: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  rrf_k: 60,
  top_k: 30,
  blending: {
    top3: { rrf: 0.75, rerank: 0.25 },
    mid: { rrf: 0.60, rerank: 0.40 },
    tail: { rrf: 0.40, rerank: 0.60 },
  },
  expansion: {
    enabled: true,
    weight: 1,
  },
  reranking: {
    enabled: true,
  },
  centrality_weight: 0.1,
  supersede_demotion: 0.3,
};

export interface RemoveWorkspaceResult {
  documentsDeleted: number;
  embeddingsDeleted: number;
  contentDeleted: number;
  cacheDeleted: number;
  fileEdgesDeleted: number;
  symbolsDeleted: number;
  codeSymbolsDeleted: number;
  symbolEdgesDeleted: number;
  executionFlowsDeleted: number;
}

export interface Store {
  close(): void;
  
  insertDocument(doc: Omit<Document, 'id'>): number;
  findDocument(pathOrDocid: string): Document | null;
  getDocumentBody(hash: string, fromLine?: number, maxLines?: number): string | null;
  deactivateDocument(collection: string, path: string): void;
  bulkDeactivateExcept(collection: string, activePaths: string[]): number;
  
  insertContent(hash: string, body: string): void;
  
  insertEmbeddingLocal(hash: string, seq: number, pos: number, model: string, filePath?: string): void;
  insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string, vectorStore?: import('./vector-store.js').VectorStore): void;
  ensureVecTable(dimensions: number): void;
  
  searchFTS(query: string, options?: StoreSearchOptions): SearchResult[];
  searchVec(query: string, embedding: number[], options?: StoreSearchOptions): SearchResult[];
  searchVecAsync(query: string, embedding: number[], options?: StoreSearchOptions): Promise<SearchResult[]>;
  setVectorStore(vs: import('./vector-store.js').VectorStore): void;
  getVectorStore(): import('./vector-store.js').VectorStore | null;
  
  getCachedResult(hash: string, projectHash?: string): string | null;
  setCachedResult(hash: string, result: string, projectHash?: string, type?: string): void;
  clearCache(projectHash?: string, type?: string): number;
  getCacheStats(): Array<{ type: string; projectHash: string; count: number }>;
  
  getQueryEmbeddingCache(query: string): number[] | null;
  setQueryEmbeddingCache(query: string, embedding: number[]): void;
  clearQueryEmbeddingCache(): void;
  
  getIndexHealth(): IndexHealth;
  getHashesNeedingEmbedding(projectHash?: string, limit?: number): Array<{ hash: string; body: string; path: string }>;
  getNextHashNeedingEmbedding(projectHash?: string): { hash: string; body: string; path: string } | null;
  getWorkspaceStats(): Array<{ projectHash: string; count: number }>;
  
  deleteDocumentsByPath(filePath: string): number;
  clearWorkspace(projectHash: string): { documentsDeleted: number; embeddingsDeleted: number };
  removeWorkspace(projectHash: string): RemoveWorkspaceResult;
  cleanOrphanedEmbeddings(): number;
  getCollectionStorageSize(collection: string): number;
  
  modelStatus: {
    embedding: string;
    reranker: string;
    expander: string;
  };

  insertFileEdge(sourcePath: string, targetPath: string, projectHash: string, edgeType?: string): void;
  deleteFileEdges(sourcePath: string, projectHash: string): void;
  getFileEdges(projectHash: string): Array<{ source_path: string; target_path: string }>;

  updateCentralityScores(projectHash: string, scores: Map<string, number>): void;
  updateClusterIds(projectHash: string, clusters: Map<string, number>): void;
  getEdgeSetHash(projectHash: string): string | null;
  setEdgeSetHash(projectHash: string, hash: string): void;

  supersedeDocument(targetId: number, newId: number): void;

  insertTags(documentId: number, tags: string[]): void;
  getDocumentTags(documentId: number): string[];
  listAllTags(): Array<{ tag: string; count: number }>;

  getFileDependencies(filePath: string, projectHash: string): string[];
  getFileDependents(filePath: string, projectHash: string): string[];
  getDocumentCentrality(filePath: string): { centrality: number; clusterId: number | null } | null;
  getClusterMembers(clusterId: number, projectHash: string): string[];
  getGraphStats(projectHash: string): {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
    topCentrality: Array<{ path: string; centrality: number }>;
  };

  insertSymbol(symbol: {
    type: string;
    pattern: string;
    operation: string;
    repo: string;
    filePath: string;
    lineNumber: number;
    rawExpression: string;
    projectHash: string;
  }): void;
  deleteSymbols(filePath: string, projectHash: string): void;
  querySymbols(options: {
    type?: string;
    pattern?: string;
    repo?: string;
    operation?: string;
    projectHash?: string;
  }): Array<{
    type: string;
    pattern: string;
    operation: string;
    repo: string;
    filePath: string;
    lineNumber: number;
    rawExpression: string;
  }>;
  getSymbolImpact(type: string, pattern: string, projectHash?: string): Array<{
    pattern: string;
    operation: string;
    repo: string;
    filePath: string;
    lineNumber: number;
  }>;

  cleanupVectorsForHash(hash: string): void;

  recordTokenUsage(model: string, tokens: number): void;
  getTokenUsage(): Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>;
  getSqliteVecCount(): number;
}
