import { watch, type FSWatcher } from 'chokidar';
import type { Store, Collection, StorageConfig, CodebaseConfig } from './types.js'
import { scanCollectionFiles } from './collections.js';
import { indexDocument, computeHash, extractProjectHashFromPath, openWorkspaceStore, resolveWorkspaceDbPath } from './store.js';
import { harvestSessions } from './harvester.js';
import { checkDiskSpace, evictExpiredSessions, evictBySize } from './storage.js';
import { indexCodebase, mergeExcludePatterns, resolveExtensions, embedPendingCodebase } from './codebase.js'
import { log } from './logger.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface WatcherOptions {
  store: Store
  collections: Collection[]
  embedder?: { embed(text: string): Promise<{ embedding: number[] }> } | null
  db?: Database.Database
  onUpdate?: (path: string) => void
  debounceMs?: number
  pollIntervalMs?: number
  sessionPollMs?: number
  embedIntervalMs?: number
  sessionStorageDir?: string
  outputDir?: string
  storageConfig?: StorageConfig
  dbPath?: string
  codebaseConfig?: CodebaseConfig
  workspaceRoot?: string
  projectHash?: string
  allWorkspaces?: Record<string, { codebase?: CodebaseConfig }>
  dataDir?: string
  learningConfig?: import('./types.js').LearningConfig
  sampler?: import('./bandits.js').ThompsonSampler
  consolidationAgent?: import('./consolidation.js').ConsolidationAgent
  consolidationIntervalMs?: number
  importanceScorer?: import('./importance.js').ImportanceScorer
  importanceIntervalMs?: number
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
    embedder,
    db,
    onUpdate,
    debounceMs = 2000,
    pollIntervalMs = 300000,
    sessionPollMs = 120000,
    embedIntervalMs = 60000,
    sessionStorageDir = path.join(os.homedir(), '.local/share/opencode/storage'),
    outputDir = path.join(os.homedir(), '.nano-brain/sessions'),
    storageConfig,
    dbPath,
    codebaseConfig,
    workspaceRoot = process.cwd(),
    projectHash = 'global',
    allWorkspaces,
    dataDir,
    learningConfig,
    sampler,
  } = options

  const codebaseExtensions = codebaseConfig?.enabled
    ? new Set(resolveExtensions(codebaseConfig, workspaceRoot))
    : new Set<string>()

  let dirty = false;
  const pendingPaths = new Set<string>();
  let lastReindexAt: number | null = null;
  let isReindexing = false;
  let stopped = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pollInterval: NodeJS.Timeout | null = null;
  let sessionPollInterval: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let harvestCycleCount = 0;
  const watchedPaths = new Set<string>();
  let embeddingTimeout: NodeJS.Timeout | null = null;
  let isEmbedding = false;
  let consecutiveEmptyCycles = 0;
  let consecutiveFailures = 0;
  let currentEmbedInterval = embedIntervalMs;
  let learningTimeout: NodeJS.Timeout | null = null;
  let lastLearningRun = Date.now();
  let consolidationTimeout: NodeJS.Timeout | null = null;
  let importanceTimeout: NodeJS.Timeout | null = null;

  const handleFileChange = (filePath: string) => {
    if (stopped) return
    
    log('watcher', 'File change detected: ' + filePath)
    dirty = true
    pendingPaths.add(filePath)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      if (onUpdate) {
        for (const p of pendingPaths) {
          onUpdate(p)
        }
      }
    }, debounceMs)
  }

  const isCodebaseFile = (filePath: string): boolean => {
    if (!codebaseConfig?.enabled) return false
    const ext = path.extname(filePath).toLowerCase()
    return codebaseExtensions.has(ext)
  }

  const triggerReindex = async (): Promise<void> => {
    if (isReindexing || stopped) return
    
    isReindexing = true
    log('watcher', 'Starting reindex')
    
    try {
      for (const collection of collections) {
        const files = await scanCollectionFiles(collection)
        const activePaths: string[] = []
        for (const filePath of files) {
          if (!fs.existsSync(filePath)) continue
          
          const content = fs.readFileSync(filePath, 'utf-8')
          const hash = computeHash(content)
          
          const existingDoc = store.findDocument(filePath)
          if (!existingDoc || existingDoc.hash !== hash) {
            const title = extractTitle(content)
            const effectiveProjectHash = collection.name === 'sessions'
              ? extractProjectHashFromPath(filePath, outputDir) ?? projectHash
              : projectHash;
            indexDocument(store, collection.name, filePath, content, title, effectiveProjectHash)
          }
          
          activePaths.push(filePath)
        }
        
        store.bulkDeactivateExcept(collection.name, activePaths)
      }
      
      if (codebaseConfig?.enabled) {
        await indexCodebase(store, workspaceRoot, codebaseConfig, projectHash, embedder, db)
      }
      if (embedder) {
        await embedPendingCodebase(store, embedder, 50, projectHash)
      }
      
      if (allWorkspaces && dataDir) {
        for (const [wsPath, wsConfig] of Object.entries(allWorkspaces)) {
          if (!wsConfig.codebase?.enabled) continue;
          if (wsPath === workspaceRoot) continue;
          try {
            const wsStore = openWorkspaceStore(dataDir, wsPath);
            if (!wsStore) {
              log('watcher', 'Skipping workspace (no DB): ' + wsPath);
              continue;
            }
            const wsDbPath = resolveWorkspaceDbPath(dataDir, wsPath);
            const wsDb = new Database(wsDbPath);
            const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
            try {
              await indexCodebase(wsStore, wsPath, wsConfig.codebase, wsHash, embedder, wsDb);
              log('watcher', `Codebase indexed for workspace: ${path.basename(wsPath)}`);
            } finally {
              wsDb.close();
              wsStore.close();
            }
          } catch (err) {
            log('watcher', `Codebase index failed for workspace ${wsPath}: ${err}`);
          }
        }
      }
      
      dirty = false
      pendingPaths.clear()
      lastReindexAt = Date.now()
      log('watcher', 'Reindex completed: ' + collections.length + ' collections scanned')
    } finally {
      isReindexing = false
    }
  }

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
      log('watcher', 'Integrity check found ' + mismatches + ' mismatches')
      console.log(`Integrity check: ${mismatches} file(s) need re-indexing`);
    }
  };

  const setupWatcher = () => {
    const pathsToWatch: string[] = []
    const ignoredPatterns: (string | RegExp)[] = [/(^|[\/])\../]
    for (const collection of collections) {
      const expandedPath = collection.path.replace(/^~/, os.homedir())
      if (fs.existsSync(expandedPath)) {
        pathsToWatch.push(expandedPath)
        watchedPaths.add(expandedPath)
      }
    }
    if (codebaseConfig?.enabled && fs.existsSync(workspaceRoot)) {
      pathsToWatch.push(workspaceRoot)
      watchedPaths.add(workspaceRoot)
      const excludePatterns = mergeExcludePatterns(codebaseConfig, workspaceRoot)
      for (const pattern of excludePatterns) {
        // Convert glob patterns to regex for chokidar directory-level matching
        // e.g. 'node_modules' -> /[\/]node_modules([\/]|$)/
        // e.g. '*.min.js' -> /\.min\.js$/
        if (pattern.startsWith('*')) {
          const escaped = pattern.slice(1).replace(/\./g, '\\.').replace(/\*/g, '.*')
          ignoredPatterns.push(new RegExp(`${escaped}$`))
        } else {
          const escaped = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')
          ignoredPatterns.push(new RegExp(`[\\/]${escaped}([\\/]|$)`))
        }
      }
    }
    if (pathsToWatch.length === 0) return
    watcher = watch(pathsToWatch, {
      ignored: ignoredPatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    })
    watcher.on('error', (err: unknown) => {
      console.error(`[watcher] Error: ${err instanceof Error ? err.message : String(err)}`)
    })
    watcher.on('add', (filePath) => {
      if (filePath.endsWith('.md') || isCodebaseFile(filePath)) {
        handleFileChange(filePath)
      }
    })
    watcher.on('change', (filePath) => {
      if (filePath.endsWith('.md') || isCodebaseFile(filePath)) {
        handleFileChange(filePath)
      }
    })
    watcher.on('unlink', (filePath) => {
      if (filePath.endsWith('.md') || isCodebaseFile(filePath)) {
        handleFileChange(filePath)
      }
    })
  }

  const setupPolling = () => {
    pollInterval = setInterval(async () => {
      if (dirty && !isReindexing) {
        await triggerReindex();
      }
    }, pollIntervalMs);
    
    sessionPollInterval = setInterval(async () => {
      if (stopped) return;
      if (storageConfig) {
        const diskCheck = checkDiskSpace(outputDir, storageConfig.minFreeDisk);
        if (!diskCheck.ok) {
          console.warn(`[storage] Disk space critically low (<${Math.round(storageConfig.minFreeDisk / 1024 / 1024)}MB free), skipping writes`);
          return;
        }
      }
      
      try {
        const sessions = await harvestSessions({
          sessionDir: sessionStorageDir,
          outputDir,
        });
        
        if (sessions.length > 0) {
          log('watcher', 'Session harvest: ' + sessions.length + ' session(s) harvested')
          await triggerReindex();
        }
        
        if (storageConfig && dbPath) {
          const expiredCount = evictExpiredSessions(outputDir, storageConfig.retention, store);
          if (expiredCount > 0) {
            log('watcher', 'Storage eviction: ' + expiredCount + ' expired session(s)')
            console.log(`[storage] Evicted ${expiredCount} expired session(s)`);
          }
          
          const sizeEvictedCount = evictBySize(outputDir, dbPath, storageConfig.maxSize, store);
          if (sizeEvictedCount > 0) {
            log('watcher', 'Storage eviction: ' + sizeEvictedCount + ' session(s) due to size limit')
            console.log(`[storage] Evicted ${sizeEvictedCount} session(s) due to size limit`);
          }
        }
        
        harvestCycleCount++;
        if (harvestCycleCount % 10 === 0) {
          const orphansDeleted = store.cleanOrphanedEmbeddings();
          if (orphansDeleted > 0) {
            log('watcher', 'Orphan cleanup: ' + orphansDeleted + ' orphaned embedding(s)')
            console.log(`[storage] Cleaned ${orphansDeleted} orphaned embedding(s)`);
          }
        }
        
        try {
          const purged = store.purgeTelemetry(90);
          if (purged > 0) {
            log('watcher', 'Telemetry purge: ' + purged + ' old record(s)');
          }
        } catch (err) {
          console.warn('[watcher] Telemetry purge failed:', err);
        }
      } catch (err) {
        console.warn('Session harvest failed:', err);
      }
    }, sessionPollMs);

    if (embedder) {
      const scheduleNextEmbedCycle = () => {
        if (stopped) return;
        embeddingTimeout = setTimeout(async () => {
          if (stopped || isEmbedding) {
            scheduleNextEmbedCycle();
            return;
          }
          isEmbedding = true;
          try {
            let count = await embedPendingCodebase(store, embedder, 50, projectHash);
            if (count > 0) {
              log('watcher', 'Embedding cycle: ' + count + ' document(s) embedded')
              console.log(`[embed] Embedded ${count} document(s)`);
            }

            if (allWorkspaces && dataDir) {
              for (const [wsPath, wsConfig] of Object.entries(allWorkspaces)) {
                if (!wsConfig.codebase?.enabled) continue;
                if (wsPath === workspaceRoot) continue;
                
                try {
                  const wsStore = openWorkspaceStore(dataDir, wsPath);
                  if (!wsStore) {
                    log('watcher', 'Skipping workspace (no DB): ' + wsPath);
                    continue;
                  }
                  const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
                  try {
                    const wsCount = await embedPendingCodebase(wsStore, embedder, 50, wsHash);
                    if (wsCount > 0) {
                      count += wsCount;
                      log('watcher', `Embedded ${wsCount} doc(s) for workspace: ${path.basename(wsPath)}`);
                      console.log(`[embed] Embedded ${wsCount} doc(s) for ${path.basename(wsPath)}`);
                    }
                  } finally {
                    wsStore.close();
                  }
                } catch (err) {
                  log('watcher', `Embed failed for workspace ${wsPath}: ${err}`);
                }
              }
            }

            if (count > 0) {
              consecutiveEmptyCycles = 0;
              currentEmbedInterval = embedIntervalMs;
            } else {
              consecutiveEmptyCycles++;
              if (consecutiveEmptyCycles >= 3) {
                currentEmbedInterval = Math.min(currentEmbedInterval * 1.5, 300000);
              }
            }
            consecutiveFailures = 0;
          } catch (err) {
            consecutiveFailures++;
            if (consecutiveFailures >= 5) {
              console.warn(`[embed] WARNING: ${consecutiveFailures} consecutive embedding failures. Check embedding provider configuration. Last error:`, err);
            } else {
              console.warn('[embed] Embedding cycle failed:', err);
            }
          } finally {
            isEmbedding = false;
            scheduleNextEmbedCycle();
          }
        }, currentEmbedInterval);
      };
      scheduleNextEmbedCycle();
    }

    if (learningConfig?.enabled && sampler) {
      const learningIntervalMs = learningConfig.update_interval_ms ?? 600000;
      const scheduleLearningCycle = () => {
        if (stopped) return;
        learningTimeout = setTimeout(async () => {
          if (stopped) return;
          
          try {
            const banditState = sampler.getState();
            const flatStats = banditState.flatMap(config =>
              config.variants.map(v => ({
                parameterName: config.parameterName,
                variantValue: v.value,
                successes: v.successes,
                failures: v.failures,
              }))
            );
            store.saveBanditStats(flatStats, projectHash);
            
            const configJson = JSON.stringify(sampler.selectSearchConfig());
            const telemetryCount = store.getTelemetryCount();
            store.saveConfigVersion(configJson, telemetryCount > 0 ? telemetryCount : null);
            
            const latestVersion = store.getLatestConfigVersion();
            if (latestVersion && latestVersion.expand_rate !== null) {
              const prevVersion = store.getConfigVersion(latestVersion.version_id - 1);
              if (prevVersion && prevVersion.expand_rate !== null && prevVersion.expand_rate > 0) {
                const dropPercent = (prevVersion.expand_rate - latestVersion.expand_rate) / prevVersion.expand_rate;
                if (dropPercent > 0.3) {
                  log('watcher', 'Expand rate dropped ' + Math.round(dropPercent * 100) + '%, rolling back to version ' + prevVersion.version_id);
                  console.warn('[learning] Automatic rollback triggered: expand rate dropped ' + Math.round(dropPercent * 100) + '%');
                }
              }
            }
            
            lastLearningRun = Date.now();
            log('watcher', 'Learning cycle complete: saved bandit stats and config version');
          } catch (err) {
            console.warn('[watcher] Learning cycle failed:', err);
          } finally {
            scheduleLearningCycle();
          }
        }, Math.min(learningIntervalMs, 3600000));
      };
      scheduleLearningCycle();
    }

    const consolidationAgent = options.consolidationAgent;
    if (consolidationAgent) {
      const consolidationInterval = options.consolidationIntervalMs ?? 3600000;
      const scheduleConsolidation = () => {
        if (stopped) return;
        consolidationTimeout = setTimeout(async () => {
          if (stopped) return;
          try {
            const results = await consolidationAgent.runConsolidationCycle();
            if (results.length > 0) {
              log('watcher', 'Consolidation: ' + results.length + ' consolidation(s) created');
            }
          } catch (err) {
            console.warn('[watcher] Consolidation cycle failed:', err);
          } finally {
            scheduleConsolidation();
          }
        }, consolidationInterval);
      };
      scheduleConsolidation();
    }

    const importanceScorer = options.importanceScorer;
    if (importanceScorer) {
      const importanceInterval = options.importanceIntervalMs ?? 1800000;
      const scheduleImportanceUpdate = () => {
        if (stopped) return;
        importanceTimeout = setTimeout(async () => {
          if (stopped) return;
          try {
            const updated = await importanceScorer.recalculateAll();
            if (updated > 0) {
              log('watcher', 'Importance: ' + updated + ' score(s) updated');
            }
          } catch (err) {
            console.warn('[watcher] Importance update failed:', err);
          } finally {
            scheduleImportanceUpdate();
          }
        }, importanceInterval);
      };
      scheduleImportanceUpdate();
    }
  };

  setupWatcher();
  setupPolling();
  startupIntegrityCheck().catch(err => {
    console.warn('Startup integrity check failed:', err);
  });

  if (embedder) {
    setTimeout(async () => {
      isEmbedding = true;
      try {
        const count = await embedPendingCodebase(store, embedder, 50, projectHash);
        if (count > 0) {
          console.log(`[embed] Initial embedding: ${count} document(s)`);
        }
      } catch (err) {
        console.warn('[embed] Initial embedding failed:', err);
      } finally {
        isEmbedding = false;
      }
    }, 5000);
  }

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

      if (embeddingTimeout) {
        clearTimeout(embeddingTimeout);
        embeddingTimeout = null;
      }

      if (learningTimeout) {
        clearTimeout(learningTimeout);
        learningTimeout = null;
      }

      if (consolidationTimeout) {
        clearTimeout(consolidationTimeout);
        consolidationTimeout = null;
      }

      if (importanceTimeout) {
        clearTimeout(importanceTimeout);
        importanceTimeout = null;
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
