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
  access_count?: number;
  lastAccessedAt?: string | null;
  tags?: string[];
  createdAt?: string;
  charLength?: number;
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
  access_count?: number;
  last_accessed_at?: string | null;
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
  collections?: Record<string, {
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
  reranker?: RerankerConfig
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
  telemetry?: Partial<TelemetryConfig>
  learning?: Partial<LearningConfig>
  consolidation?: Partial<ConsolidationConfig>
  extraction?: Partial<ExtractionConfig>
  importance?: Partial<ImportanceConfig>
  intents?: Partial<IntentConfig>
  proactive?: Partial<ProactiveConfig>
  decay?: Partial<DecayConfig>
  categorization?: Partial<LLMCategorizationConfig>
  preferences?: Partial<PreferenceConfig>
  pruning?: Partial<PruningConfig>
  merge?: Partial<MergeConfig>
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
  dimensions?: number
}

export interface RerankerConfig {
  model?: string
  apiKey?: string
}

export interface WatcherConfig {
  debounceMs?: number
  pollIntervalMs?: number
  sessionPollMs?: number
  embedIntervalMs?: number
  reindexCooldownMs?: number
  embedQuietPeriodMs?: number
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
  extractedFacts?: number
}

export interface StoreSearchOptions {
  limit?: number;
  collection?: string;
  projectHash?: string;
  tags?: string[];
  since?: string;
  until?: string;
  includeGlobal?: boolean;
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
  usage_boost_weight: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  rrf_k: 60,
  top_k: 15,
  blending: {
    top3: { rrf: 0.75, rerank: 0.25 },
    mid: { rrf: 0.60, rerank: 0.40 },
    tail: { rrf: 0.40, rerank: 0.60 },
  },
  expansion: {
    enabled: false,
    weight: 1,
  },
  reranking: {
    enabled: true,
  },
  centrality_weight: 0.1,
  supersede_demotion: 0.05,
  usage_boost_weight: 0.15,
};

// === Self-Learning Types ===

export interface TelemetryConfig {
  enabled: boolean;
  retention_days: number;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  retention_days: 90,
};

export interface LearningConfig {
  enabled: boolean;
  update_interval_ms: number;
  exploration_threshold: number;
  dampening_factor: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: false,
  update_interval_ms: 600000,
  exploration_threshold: 100,
  dampening_factor: 0.1,
};

export interface ConsolidationConfig {
  enabled: boolean;
  interval_ms: number;
  model: string;
  endpoint?: string;
  apiKey?: string;
  provider?: 'openai' | 'ollama';
  max_memories_per_cycle: number;
  min_memories_threshold: number;
  confidence_threshold: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: false,
  interval_ms: 3600000,
  model: 'gitlab/claude-haiku-4-5',
  endpoint: 'https://ai-proxy.thnkandgrow.com',
  max_memories_per_cycle: 20,
  min_memories_threshold: 2,
  confidence_threshold: 0.6,
};

export interface ExtractionConfig {
  enabled: boolean;
  model: string;
  endpoint?: string;
  apiKey?: string;
  maxFactsPerSession: number;
}

export const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  enabled: false,
  model: 'gitlab/claude-haiku-4-5',
  endpoint: 'https://ai-proxy.thnkandgrow.com',
  maxFactsPerSession: 20,
};

export interface ImportanceConfig {
  enabled: boolean;
  weight: number;
  decay_half_life_days: number;
  formula_weights: {
    usage: number;
    entity_density: number;
    recency: number;
    connections: number;
  };
}

export const DEFAULT_IMPORTANCE_CONFIG: ImportanceConfig = {
  enabled: false,
  weight: 0.1,
  decay_half_life_days: 30,
  formula_weights: {
    usage: 0.4,
    entity_density: 0.2,
    recency: 0.2,
    connections: 0.2,
  },
};

export interface IntentConfig {
  enabled: boolean;
  intents: Record<string, {
    keywords: string[];
    config_overrides: Partial<SearchConfig>;
  }>;
}

export const DEFAULT_INTENT_CONFIG: IntentConfig = {
  enabled: false,
  intents: {
    lookup: {
      keywords: ['where is', 'find', 'locate', 'show me'],
      config_overrides: { centrality_weight: 0.2 },
    },
    explanation: {
      keywords: ['how does', 'explain', 'why', 'what is'],
      config_overrides: { rrf_k: 45 },
    },
    architecture: {
      keywords: ['design', 'architecture', 'structure', 'flow', 'diagram'],
      config_overrides: { centrality_weight: 0.3 },
    },
    recall: {
      keywords: ['what did we', 'decision', 'agreed', 'discussed'],
      config_overrides: {},
    },
  },
};

export interface ProactiveConfig {
  enabled: boolean;
  chain_timeout_ms: number;
  min_queries_for_prediction: number;
  max_suggestions: number;
  confidence_threshold: number;
  cluster_count: number;
  analysis_interval_ms: number;
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: false,
  chain_timeout_ms: 300000,
  min_queries_for_prediction: 50,
  max_suggestions: 5,
  confidence_threshold: 0.3,
  cluster_count: 50,
  analysis_interval_ms: 1800000,
};

export interface DecayConfig {
  enabled: boolean;
  halfLife: string;
  boostWeight: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  enabled: true,
  halfLife: '30d',
  boostWeight: 0.15,
};

export interface PruningConfig {
  enabled: boolean;
  interval_ms: number;
  contradicted_ttl_days: number;
  orphan_ttl_days: number;
  batch_size: number;
  hard_delete_after_days: number;
}

export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  enabled: true,
  interval_ms: 21600000,
  contradicted_ttl_days: 30,
  orphan_ttl_days: 90,
  batch_size: 100,
  hard_delete_after_days: 30,
};

export function parsePruningConfig(raw?: Partial<PruningConfig>): PruningConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_PRUNING_CONFIG.enabled,
    interval_ms: raw?.interval_ms ?? DEFAULT_PRUNING_CONFIG.interval_ms,
    contradicted_ttl_days: raw?.contradicted_ttl_days ?? DEFAULT_PRUNING_CONFIG.contradicted_ttl_days,
    orphan_ttl_days: raw?.orphan_ttl_days ?? DEFAULT_PRUNING_CONFIG.orphan_ttl_days,
    batch_size: raw?.batch_size ?? DEFAULT_PRUNING_CONFIG.batch_size,
    hard_delete_after_days: raw?.hard_delete_after_days ?? DEFAULT_PRUNING_CONFIG.hard_delete_after_days,
  };
}

export interface MergeConfig {
  enabled: boolean;
  interval_ms: number;
  similarity_threshold: number;
  batch_size: number;
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  enabled: true,
  interval_ms: 86400000,
  similarity_threshold: 0.8,
  batch_size: 50,
};

export function parseMergeConfig(raw?: Partial<MergeConfig>): MergeConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_MERGE_CONFIG.enabled,
    interval_ms: raw?.interval_ms ?? DEFAULT_MERGE_CONFIG.interval_ms,
    similarity_threshold: raw?.similarity_threshold ?? DEFAULT_MERGE_CONFIG.similarity_threshold,
    batch_size: raw?.batch_size ?? DEFAULT_MERGE_CONFIG.batch_size,
  };
}

export interface LLMCategorizationConfig {
  llm_enabled: boolean;
  confidence_threshold: number;
  max_content_length: number;
}

export const DEFAULT_LLM_CATEGORIZATION_CONFIG: LLMCategorizationConfig = {
  llm_enabled: true,
  confidence_threshold: 0.6,
  max_content_length: 2000,
};

export function parseCategorizationConfig(partial?: Partial<LLMCategorizationConfig>): LLMCategorizationConfig {
  if (!partial) return { ...DEFAULT_LLM_CATEGORIZATION_CONFIG };

  const config: LLMCategorizationConfig = { ...DEFAULT_LLM_CATEGORIZATION_CONFIG };

  if (partial.llm_enabled !== undefined) {
    config.llm_enabled = partial.llm_enabled;
  }

  if (partial.confidence_threshold !== undefined) {
    if (partial.confidence_threshold < 0 || partial.confidence_threshold > 1) {
      config.confidence_threshold = DEFAULT_LLM_CATEGORIZATION_CONFIG.confidence_threshold;
    } else {
      config.confidence_threshold = partial.confidence_threshold;
    }
  }

  if (partial.max_content_length !== undefined) {
    if (partial.max_content_length < 100) {
      config.max_content_length = DEFAULT_LLM_CATEGORIZATION_CONFIG.max_content_length;
    } else {
      config.max_content_length = partial.max_content_length;
    }
  }

  return config;
}

export interface PreferenceConfig {
  enabled: boolean;
  min_queries: number;
  weight_min: number;
  weight_max: number;
  baseline_expand_rate: number;
}

export const DEFAULT_PREFERENCE_CONFIG: PreferenceConfig = {
  enabled: true,
  min_queries: 20,
  weight_min: 0.5,
  weight_max: 2.0,
  baseline_expand_rate: 0.1,
};

export function parsePreferencesConfig(partial?: Partial<PreferenceConfig>): PreferenceConfig {
  if (!partial) return { ...DEFAULT_PREFERENCE_CONFIG };

  const config: PreferenceConfig = { ...DEFAULT_PREFERENCE_CONFIG };

  if (partial.enabled !== undefined) {
    config.enabled = partial.enabled;
  }

  if (partial.min_queries !== undefined) {
    if (partial.min_queries < 1) {
      config.min_queries = DEFAULT_PREFERENCE_CONFIG.min_queries;
    } else {
      config.min_queries = partial.min_queries;
    }
  }

  if (partial.weight_min !== undefined) {
    if (partial.weight_min < 0 || partial.weight_min > 1) {
      config.weight_min = DEFAULT_PREFERENCE_CONFIG.weight_min;
    } else {
      config.weight_min = partial.weight_min;
    }
  }

  if (partial.weight_max !== undefined) {
    if (partial.weight_max < 1 || partial.weight_max > 10) {
      config.weight_max = DEFAULT_PREFERENCE_CONFIG.weight_max;
    } else {
      config.weight_max = partial.weight_max;
    }
  }

  if (partial.baseline_expand_rate !== undefined) {
    if (partial.baseline_expand_rate <= 0 || partial.baseline_expand_rate > 1) {
      config.baseline_expand_rate = DEFAULT_PREFERENCE_CONFIG.baseline_expand_rate;
    } else {
      config.baseline_expand_rate = partial.baseline_expand_rate;
    }
  }

  return config;
}

export interface MemoryEntity {
  id: number;
  name: string;
  type: 'tool' | 'service' | 'person' | 'concept' | 'decision' | 'file' | 'library';
  description?: string;
  projectHash: string;
  firstLearnedAt: string;
  lastConfirmedAt: string;
  contradictedAt?: string | null;
  contradictedByMemoryId?: number | null;
  prunedAt?: string | null;
}

export interface MemoryEdge {
  id: number;
  sourceId: number;
  targetId: number;
  edgeType: 'uses' | 'depends_on' | 'decided_by' | 'related_to' | 'replaces' | 'configured_with';
  projectHash: string;
  createdAt: string;
}

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

export type MemoryConnectionRelationshipType = 'supports' | 'contradicts' | 'extends' | 'supersedes' | 'related' | 'caused_by' | 'refines' | 'implements';

export type MemoryConnectionCreatedBy = 'consolidation' | 'user' | 'extraction';

export const VALID_RELATIONSHIP_TYPES: MemoryConnectionRelationshipType[] = [
  'supports', 'contradicts', 'extends', 'supersedes', 'related', 'caused_by', 'refines', 'implements'
];

export interface MemoryConnection {
  id: number;
  fromDocId: number;
  toDocId: number;
  relationshipType: MemoryConnectionRelationshipType;
  description: string | null;
  strength: number;
  createdBy: MemoryConnectionCreatedBy;
  createdAt: string;
  projectHash: string;
}

export interface Store {
  getDb(): import('better-sqlite3').Database;
  close(): void;

  registerWorkspacePrefix(projectHash: string, workspaceRoot: string): void;
  getWorkspaceRoot(): string | null;
  toRelative(absolutePath: string): string;
  resolvePath(relativePath: string, projectHash: string): string;

  insertDocument(doc: Omit<Document, 'id'>): number;
  findDocument(pathOrDocid: string): Document | null;
  getDocumentBody(hash: string, fromLine?: number, maxLines?: number): string | null;
  deactivateDocument(collection: string, path: string): void;
  bulkDeactivateExcept(collection: string, activePaths: string[]): number;

  insertContent(hash: string, body: string): void;

  insertEmbeddingLocal(hash: string, seq: number, pos: number, model: string, filePath?: string): void;
  insertEmbeddingLocalBatch(items: Array<{ hash: string; seq: number; pos: number; model: string }>): Promise<void>;
  insertEmbedding(hash: string, seq: number, pos: number, embedding: number[], model: string, vectorStore?: import('./vector-store.js').VectorStore): void;
  ensureVecTable(dimensions: number): void;

  searchFTS(query: string, options?: StoreSearchOptions): SearchResult[];
  searchVec(query: string, embedding: number[], options?: StoreSearchOptions): SearchResult[];
  searchVecAsync(query: string, embedding: number[], options?: StoreSearchOptions): Promise<SearchResult[]>;
  setVectorStore(vs: import('./vector-store.js').VectorStore | null): void;
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

  logSearchQuery(queryId: string, queryText: string, tier: string, configVariant: string | null, resultDocids: string[], executionMs: number, sessionId: string | null, cacheKey: string | null, workspaceHash: string): void;
  logSearchExpand(cacheKey: string, expandedIndices: number[]): void;
  getRecentQueries(sessionId: string): Array<{ id: number; query_text: string; timestamp: string }>;
  getConfigVariantByCacheKey(cacheKey: string): string | null;
  getConfigVariantById(telemetryId: number): string | null;
  markReformulation(telemetryId: number): void;
  purgeTelemetry(retentionDays: number): number;
  getTelemetryCount(): number;

  saveBanditStats(stats: Array<{ parameterName: string; variantValue: number; successes: number; failures: number }>, workspaceHash: string): void;
  loadBanditStats(workspaceHash: string): Array<{ parameter_name: string; variant_value: number; successes: number; failures: number }>;
  saveConfigVersion(configJson: string, expandRate: number | null): number;
  getLatestConfigVersion(): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;
  getConfigVersion(versionId: number): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;

  getWorkspaceProfile(workspaceHash: string): { workspace_hash: string; profile_data: string; updated_at: string } | null;
  saveWorkspaceProfile(workspaceHash: string, profileData: string): void;
  saveGlobalLearning(parameterName: string, value: number, confidence: number): void;
  getGlobalLearning(): Array<{ parameter_name: string; value: number; confidence: number }>;

  getTelemetryStats(workspaceHash: string): { queryCount: number; expandCount: number };
  getTelemetryTopKeywords(workspaceHash: string, limit: number): Array<{ keyword: string; count: number }>;
  insertChainMembership(chainId: string, queryId: string, position: number, workspaceHash: string): void;
  getChainsByWorkspace(workspaceHash: string, limit: number): Array<{ chain_id: string; query_id: string; position: number }>;

  getRecentTelemetryQueries(workspaceHash: string, limit: number): Array<{ id: number; query_id: string; query_text: string; timestamp: string; session_id: string }>;
  upsertQueryCluster(clusterId: number, centroidEmbedding: string, representativeQuery: string, queryCount: number, workspaceHash: string): void;
  getQueryClusters(workspaceHash: string): Array<{ cluster_id: number; centroid_embedding: string; representative_query: string; query_count: number }>;
  clearQueryClusters(workspaceHash: string): void;
  upsertClusterTransition(fromId: number, toId: number, frequency: number, probability: number, workspaceHash: string): void;
  getClusterTransitions(workspaceHash: string): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
  getTransitionsFrom(fromClusterId: number, workspaceHash: string, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }>;
  clearClusterTransitions(workspaceHash: string): void;

  upsertGlobalTransition(fromId: number, toId: number, frequency: number, probability: number): void;
  getGlobalTransitions(): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
  getGlobalTransitionsFrom(fromClusterId: number, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }>;
  clearGlobalTransitions(): void;

  recordSuggestionFeedback(suggestedQuery: string, actualQuery: string, matchType: string, workspaceHash: string): void;
  getSuggestionAccuracy(workspaceHash: string): { total: number; exact: number; partial: number; none: number };

  enqueueConsolidation(documentId: number): number;
  getNextPendingJob(): { id: number; document_id: number } | null;
  updateJobStatus(jobId: number, status: 'processing' | 'completed' | 'failed', result?: string, error?: string): void;
  getQueueStats(): { pending: number; processing: number; completed: number; failed: number };
  addConsolidationLog(entry: { documentId: number; action: string; reason: string; targetDocId?: number; model: string; tokensUsed: number }): void;
  getRecentConsolidationLogs(limit?: number): Array<{ id: number; document_id: number; action: string; reason: string | null; target_doc_id: number | null; model: string | null; tokens_used: number; created_at: string }>;

  trackAccess(docIds: number[]): void;

  insertOrUpdateEntity(entity: Omit<MemoryEntity, 'id'>): number;
  insertEdge(edge: Omit<MemoryEdge, 'id' | 'createdAt'>): number;
  getEntityByName(name: string, type?: string, projectHash?: string): MemoryEntity | null;
  getEntityById(id: number): MemoryEntity | null;
  getEntityEdges(entityId: number, direction?: 'incoming' | 'outgoing' | 'both'): Array<MemoryEdge & { sourceName: string; targetName: string }>;
  markEntityContradicted(entityId: number, contradictedByMemoryId: number): void;
  confirmEntity(entityId: number): void;
  getMemoryEntities(projectHash: string, limit?: number): MemoryEntity[];
  getMemoryEntityCount(projectHash: string): number;

  getContradictedEntitiesForPruning(ttlDays: number, batchSize: number, projectHash?: string): number[];
  getOrphanEntitiesForPruning(ttlDays: number, batchSize: number, projectHash?: string): number[];
  getPrunedEntitiesForHardDelete(retentionDays: number, batchSize: number, projectHash?: string): number[];
  softDeleteEntities(ids: number[]): void;
  hardDeleteEntities(ids: number[]): void;

  getActiveEntitiesByTypeAndProject(projectHash?: string): MemoryEntity[];
  getEntityEdgeCount(entityId: number): number;
  redirectEntityEdges(fromId: number, toId: number): void;
  deleteEntity(id: number): void;
  deduplicateEdges(entityId: number): void;

  getUncategorizedDocuments(limit: number, projectHash?: string): Array<{ id: number; path: string; body: string }>;

  insertConnection(conn: Omit<MemoryConnection, 'id' | 'createdAt'>): number;
  getConnectionsForDocument(docId: number, options?: { direction?: 'incoming' | 'outgoing' | 'both'; relationshipType?: string; projectHash?: string }): MemoryConnection[];
  deleteConnection(id: number): void;
  getConnectionCount(docId: number): number;

  getActiveDocumentsWithAccess(): Array<{ id: number; path: string; hash: string; access_count: number; last_accessed_at: string | null }>;
  getTagCountForDocument(docId: number): number;

  getSymbolsForProject(projectHash: string): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
    clusterId: number | null;
  }>;
  getSymbolEdgesForProject(projectHash: string): Array<{
    id: number;
    sourceId: number;
    targetId: number;
    edgeType: string;
    confidence: number;
  }>;
  getSymbolClusters(projectHash: string): Array<{
    clusterId: number;
    memberCount: number;
  }>;
  getFlowsWithSteps(projectHash: string): Array<{
    id: number;
    label: string;
    flowType: string;
    stepCount: number;
    entryName: string;
    entryFile: string;
    terminalName: string;
    terminalFile: string;
  }>;
  getFlowSteps(flowId: number): Array<{
    stepIndex: number;
    symbolId: number;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
  }>;
  getAllConnections(projectHash: string): Array<MemoryConnection & {
    fromTitle: string;
    fromPath: string;
    toTitle: string;
    toPath: string;
  }>;
  getInfrastructureSymbols(projectHash: string): Array<{
    type: string;
    pattern: string;
    operation: string;
    repo: string;
    filePath: string;
    lineNumber: number;
  }>;
  getDocFlows(projectHash: string): Array<{
    id: number;
    label: string;
    flowType: string;
    description: string | null;
    services: string | null;
    sourceFile: string | null;
    lastUpdated: string | null;
  }>;
  upsertDocFlow(flow: {
    label: string;
    flowType: string;
    description?: string | null;
    services?: string | null;
    sourceFile?: string | null;
    lastUpdated?: string | null;
    projectHash: string;
  }): number;
  deleteDocFlowsByProject(projectHash: string): number;

  getTopAccessedDocuments(limit: number, projectHash?: string): Array<{
    id: number; path: string; collection: string; title: string; hash: string;
    access_count: number; last_accessed_at: string;
  }>;

  getRecentDocumentsByTags(tags: string[], limit: number, projectHash?: string): Array<{
    id: number; path: string; collection: string; title: string; hash: string;
    modified_at: string;
  }>;
}
