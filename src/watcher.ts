import { watch, type FSWatcher } from 'chokidar';
import type { Store, Collection } from './types.js';
import { scanCollectionFiles } from './collections.js';
import { indexDocument, computeHash } from './store.js';
import { harvestSessions } from './harvester.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WatcherOptions {
  store: Store;
  collections: Collection[];
  onUpdate?: (path: string) => void;
  debounceMs?: number;
  pollIntervalMs?: number;
  sessionPollMs?: number;
  sessionStorageDir?: string;
  outputDir?: string;
}

export interface Watcher {
  stop(): void;
  isDirty(): boolean;
  triggerReindex(): Promise<void>;
  getStats(): WatcherStats;
}

export interface WatcherStats {
  filesWatched: number;
  lastReindexAt: number | null;
  pendingChanges: number;
  isReindexing: boolean;
}

export function startWatcher(options: WatcherOptions): Watcher {
  const {
    store,
    collections,
    onUpdate,
    debounceMs = 2000,
    pollIntervalMs = 300000,
    sessionPollMs = 120000,
    sessionStorageDir = path.join(os.homedir(), '.local/share/opencode/storage'),
    outputDir = path.join(os.homedir(), '.opencode-memory/sessions'),
  } = options;

  let dirty = false;
  const pendingPaths = new Set<string>();
  let lastReindexAt: number | null = null;
  let isReindexing = false;
  let stopped = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pollInterval: NodeJS.Timeout | null = null;
  let sessionPollInterval: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const watchedPaths = new Set<string>();

  const handleFileChange = (filePath: string) => {
    if (stopped) return;
    
    dirty = true;
    pendingPaths.add(filePath);
    
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(() => {
      if (onUpdate) {
        for (const p of pendingPaths) {
          onUpdate(p);
        }
      }
    }, debounceMs);
  };

  const triggerReindex = async (): Promise<void> => {
    if (isReindexing || stopped) return;
    
    isReindexing = true;
    
    try {
      for (const collection of collections) {
        const files = await scanCollectionFiles(collection);
        const activePaths: string[] = [];
        
        for (const filePath of files) {
          if (!fs.existsSync(filePath)) continue;
          
          const content = fs.readFileSync(filePath, 'utf-8');
          const hash = computeHash(content);
          
          const existingDoc = store.findDocument(filePath);
          
          if (!existingDoc || existingDoc.hash !== hash) {
            const title = extractTitle(content);
            indexDocument(store, collection.name, filePath, content, title);
          }
          
          activePaths.push(filePath);
        }
        
        store.bulkDeactivateExcept(collection.name, activePaths);
      }
      
      dirty = false;
      pendingPaths.clear();
      lastReindexAt = Date.now();
    } finally {
      isReindexing = false;
    }
  };

  const startupIntegrityCheck = async () => {
    const health = store.getIndexHealth();
    let mismatches = 0;
    
    for (const collectionInfo of health.collections) {
      const collection = collections.find(c => c.name === collectionInfo.name);
      if (!collection) continue;
      
      const files = await scanCollectionFiles(collection);
      
      for (const filePath of files) {
        if (!fs.existsSync(filePath)) continue;
        
        const existingDoc = store.findDocument(filePath);
        if (!existingDoc) continue;
        
        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = computeHash(content);
        
        if (existingDoc.hash !== hash) {
          mismatches++;
          dirty = true;
          pendingPaths.add(filePath);
        }
      }
    }
    
    if (mismatches > 0) {
      console.log(`Integrity check: ${mismatches} file(s) need re-indexing`);
    }
  };

  const setupWatcher = () => {
    const pathsToWatch: string[] = [];
    
    for (const collection of collections) {
      const expandedPath = collection.path.replace(/^~/, os.homedir());
      if (fs.existsSync(expandedPath)) {
        pathsToWatch.push(expandedPath);
        watchedPaths.add(expandedPath);
      }
    }
    
    if (pathsToWatch.length === 0) return;
    
    watcher = watch(pathsToWatch, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    });
    
    watcher.on('add', (filePath) => {
      if (filePath.endsWith('.md')) {
        handleFileChange(filePath);
      }
    });
    
    watcher.on('change', (filePath) => {
      if (filePath.endsWith('.md')) {
        handleFileChange(filePath);
      }
    });
    
    watcher.on('unlink', (filePath) => {
      if (filePath.endsWith('.md')) {
        handleFileChange(filePath);
      }
    });
  };

  const setupPolling = () => {
    pollInterval = setInterval(async () => {
      if (dirty && !isReindexing) {
        await triggerReindex();
      }
    }, pollIntervalMs);
    
    sessionPollInterval = setInterval(async () => {
      if (stopped) return;
      
      try {
        await harvestSessions({
          sessionDir: sessionStorageDir,
          outputDir,
        });
      } catch (err) {
        console.warn('Session harvest failed:', err);
      }
    }, sessionPollMs);
  };

  setupWatcher();
  setupPolling();
  startupIntegrityCheck().catch(err => {
    console.warn('Startup integrity check failed:', err);
  });

  return {
    stop() {
      stopped = true;
      
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      
      if (sessionPollInterval) {
        clearInterval(sessionPollInterval);
        sessionPollInterval = null;
      }
      
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
    
    isDirty() {
      return dirty;
    },
    
    async triggerReindex() {
      await triggerReindex();
    },
    
    getStats(): WatcherStats {
      return {
        filesWatched: watchedPaths.size,
        lastReindexAt,
        pendingChanges: pendingPaths.size,
        isReindexing,
      };
    },
  };
}

function extractTitle(content: string): string {
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.substring(2).trim();
    }
  }
  
  return 'Untitled';
}
