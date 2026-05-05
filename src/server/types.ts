import type { Store, StorageConfig, CodebaseConfig, EmbeddingConfig, SearchConfig, Collection } from '../types.js';
import type { SearchProviders } from '../search.js';
import type Database from 'better-sqlite3';
import type { ThompsonSampler } from '../bandits.js';

export interface ServerOptions {
  dbPath: string;
  configPath?: string;
  httpPort?: number;
  httpHost?: string;
  daemon?: boolean;
  root?: string;
}

export interface ServerDeps {
  store: Store
  providers: SearchProviders
  collections: Collection[]
  configPath: string
  outputDir: string
  storageConfig?: StorageConfig
  currentProjectHash: string
  codebaseConfig?: CodebaseConfig
  workspaceRoot: string
  embeddingConfig?: EmbeddingConfig
  searchConfig?: SearchConfig
  db?: Database.Database
  allWorkspaces?: Record<string, { codebase?: CodebaseConfig }>
  dataDir?: string
  daemon?: boolean
  ready?: { value: boolean }
  sequenceAnalyzer?: import('../sequence-analyzer.js').SequenceAnalyzer
  corruptionWarningPending?: { value: boolean; corruptedPath?: string }
  sampler?: ThompsonSampler
}

export interface ResolvedWorkspace {
  store: Store
  workspaceRoot: string
  projectHash: string
  needsClose: boolean
}
