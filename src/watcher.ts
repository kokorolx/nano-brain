import { watch, type FSWatcher } from 'chokidar';
import type { Store, Collection, StorageConfig, CodebaseConfig, PruningConfig, MergeConfig } from './types.js'
import { scanCollectionFiles } from './collections.js';
import { indexDocument, computeHash, extractProjectHashFromPath, openWorkspaceStore, resolveWorkspaceDbPath } from './store.js';
import { harvestSessions } from './harvester.js';
import { checkDiskSpace, evictExpiredSessions, evictBySize } from './storage.js';
import { indexCodebase, mergeExcludePatterns, resolveExtensions, embedPendingCodebase, BUILTIN_EXCLUDE_PATTERNS } from './codebase.js'
import { runPruningCycle, hardDeletePrunedEntities } from './pruning.js';
import { runMergeCycle } from './entity-merger.js';
import { log } from './logger.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

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
  reindexCooldownMs?: number
  embedQuietPeriodMs?: number
  learningConfig?: import('./types.js').LearningConfig
  sampler?: import('./bandits.js').ThompsonSampler
  consolidationAgent?: import('./consolidation.js').ConsolidationAgent
  consolidationIntervalMs?: number
  importanceScorer?: import('./importance.js').ImportanceScorer
  importanceIntervalMs?: number
  workspaceProfile?: import('./workspace-profile.js').WorkspaceProfile
  sequenceAnalyzer?: import('./sequence-analyzer.js').SequenceAnalyzer
  proactiveConfig?: import('./types.js').ProactiveConfig
  preferencesConfig?: import('./types.js').PreferenceConfig
  pruningConfig?: PruningConfig
  mergeConfig?: MergeConfig
}

export interface Watcher {
  stop(): void;
  isDirty(): boolean;
  triggerReindex(force?: boolean): Promise<void>;
  getStats(): WatcherStats;
}

export interface WatcherStats {
  filesWatched: number;
  lastReindexAt: number | null;
  lastFileChangeAt: number;
  pendingChanges: number;
  isReindexing: boolean;
}

/**
 * Convert a glob exclude pattern (e.g. from BUILTIN_EXCLUDE_PATTERNS) into a
 * chokidar v5-compatible matcher.  Chokidar v5 only does exact-string equality
 * for string matchers, so we must return a RegExp or function instead.
 *
 * Supported pattern shapes:
 *   ** /dir/ **        → directory name anywhere          → /[/\\]dir([/\\]|$)/
 *   ** /a/b/ **        → nested path segment              → /[/\\]a[/\\]b([/\\]|$)/
 *   ** /*.ext          → file extension anywhere          → /\.ext$/
 *   ** /exact-file     → filename anywhere                → /[/\\]exact-file$/
 *   /absolute/ **      → absolute prefix                  → starts-with check
 *   plain-name         → bare directory name              → /[/\\]plain-name([/\\]|$)/
 */
function globToChokidarMatcher(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/')

  // Absolute prefix: /tmp/** → match paths starting with /tmp/
  if (p.startsWith('/') && !p.startsWith('*')) {
    const prefix = p.replace(/\/\*\*\/?$/, '')
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escaped}([/\\\\]|$)`)
  }

  // Strip leading **/ and trailing /**
  let core = p
  if (core.startsWith('**/')) core = core.slice(3)
  if (core.endsWith('/**')) core = core.slice(0, -3)

  if (core.startsWith('*')) {
    const ext = core.slice(1)
    const escaped = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // *.egg-info etc. can be directories — match as path segment, not just suffix
    return new RegExp(`${escaped}([/\\\\]|$)`)
  }

  // Contains wildcard in filename: e.g. "assets/index-*.js" or "i18n/locales/*.json"
  if (core.includes('*')) {
    const escaped = core
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/\\\\]*')
    return new RegExp(`[/\\\\]${escaped}$`)
  }

  // Directory or filename: "node_modules", "public/vs", "package-lock.json"
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[/\\\\]')
  return new RegExp(`[/\\\\]${escaped}([/\\\\]|$)`)
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
    reindexCooldownMs = 600000,
    embedQuietPeriodMs = 60000,
    learningConfig,
    sampler,
  } = options

  const codebaseExtensions = codebaseConfig?.enabled
    ? new Set(resolveExtensions(codebaseConfig, workspaceRoot))
    : new Set<string>()

  let dirty = false;
  const pendingPaths = new Set<string>();
  let lastReindexAt: number | null = null;
  let lastFileChangeAt: number = 0;
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
  let sequenceTimeout: NodeJS.Timeout | null = null;
  let pruningSoftDeleteTimeout: NodeJS.Timeout | null = null;
  let pruningHardDeleteTimeout: NodeJS.Timeout | null = null;
  let mergeTimeout: NodeJS.Timeout | null = null;

  const handleFileChange = (filePath: string) => {
    if (stopped) return
    
    log('watcher', 'File change detected: ' + filePath)
    dirty = true
    lastFileChangeAt = Date.now()
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

  const triggerReindex = async (force?: boolean): Promise<void> => {
    if (isReindexing || stopped) return
    
    if (!force && lastReindexAt && Date.now() - lastReindexAt < reindexCooldownMs) {
      const remainingMs = reindexCooldownMs - (Date.now() - lastReindexAt)
      const remainingMin = Math.ceil(remainingMs / 60000)
      log('watcher', `Reindex skipped: cooldown active (${remainingMin}m remaining)`)
      return
    }
    
    isReindexing = true
    log('watcher', 'Starting reindex')
    
    try {
      for (const collection of collections) {
        try {
          const files = await scanCollectionFiles(collection)
          const activePaths: string[] = []
          for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
            const filePath = files[fileIdx];
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
            
            if (fileIdx % 20 === 0) await yieldToEventLoop();
          }
          
          await yieldToEventLoop();
          store.bulkDeactivateExcept(collection.name, activePaths)
          await yieldToEventLoop();
        } catch (err) {
          log('watcher', `Collection scan failed for ${collection.name}: ${err}`)
        }
      }
      
      await yieldToEventLoop();
      if (codebaseConfig?.enabled) {
        try {
          await indexCodebase(store, workspaceRoot, codebaseConfig, projectHash, embedder, db)
        } catch (err) {
          log('watcher', `Codebase index failed for primary workspace: ${err}`)
        }
      }
      if (embedder) {
        try {
          await embedPendingCodebase(store, embedder, 50, projectHash)
        } catch (err) {
          log('watcher', `Embedding failed for primary workspace: ${err}`)
        }
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
            const wsDb = wsStore.getDb();
            const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
            try {
              await indexCodebase(wsStore, wsPath, wsConfig.codebase, wsHash, embedder, wsDb);
              log('watcher', `Codebase indexed for workspace: ${path.basename(wsPath)}`);
            } finally {
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
      
      for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
        const filePath = files[fileIdx];
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
        
        if (fileIdx % 20 === 0) await yieldToEventLoop();
      }
    }
    
    if (mismatches > 0) {
      log('watcher', 'Integrity check found ' + mismatches + ' mismatches')
      log('watcher', `Integrity check: ${mismatches} file(s) need re-indexing`);
    }
  };

  const setupWatcher = () => {
    const pathsToWatch: string[] = []
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.tox', 'target', 'vendor', '.bundle'])
    const ignoredPatterns: (string | RegExp | ((path: string) => boolean))[] = [
      (p: string) => {
        const base = path.basename(p)
        if (SKIP_DIRS.has(base)) return true
        if (base.startsWith('.') && base !== '.nano-brain') return true
        return false
      },
      // Apply the same exclude patterns used by codebase indexing & collection scanning
      ...BUILTIN_EXCLUDE_PATTERNS.map(globToChokidarMatcher),
    ]
    for (const collection of collections) {
      const expandedPath = collection.path.replace(/^~/, os.homedir())
      if (fs.existsSync(expandedPath)) {
        pathsToWatch.push(expandedPath)
        watchedPaths.add(expandedPath)
      }
    }
    if (codebaseConfig?.enabled) {
      log('watcher', 'Codebase watching uses poll-based reindex (not fs.watch) to avoid EMFILE on large workspaces')
    }
    const deduped: string[] = []
    for (const p of pathsToWatch) {
      const isSubpath = pathsToWatch.some(other =>
        other !== p && p.startsWith(other.endsWith('/') ? other : other + '/')
      )
      if (!isSubpath) {
        deduped.push(p)
      }
    }
    if (deduped.length === 0) return
    watcher = watch(deduped, {
      ignored: ignoredPatterns,
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 5000,
      binaryInterval: 10000,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    })
    log('watcher', `Watching ${deduped.length} collection paths (polling mode)`)
    watcher.on('error', (err: unknown) => {
      log('watcher', `Error: ${err instanceof Error ? err.message : String(err)}`, 'error')
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
          log('storage', `Disk space critically low (<${Math.round(storageConfig.minFreeDisk / 1024 / 1024)}MB free), skipping writes`, 'warn');
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
            log('storage', `Evicted ${expiredCount} expired session(s)`);
          }
          
          const sizeEvictedCount = evictBySize(outputDir, dbPath, storageConfig.maxSize, store);
          if (sizeEvictedCount > 0) {
            log('watcher', 'Storage eviction: ' + sizeEvictedCount + ' session(s) due to size limit')
            log('storage', `Evicted ${sizeEvictedCount} session(s) due to size limit`);
          }
        }
        
        harvestCycleCount++;
        if (harvestCycleCount % 10 === 0) {
          const orphansDeleted = store.cleanOrphanedEmbeddings();
          if (orphansDeleted > 0) {
            log('watcher', 'Orphan cleanup: ' + orphansDeleted + ' orphaned embedding(s)')
            log('storage', `Cleaned ${orphansDeleted} orphaned embedding(s)`);
          }
        }
        
        try {
          const purged = store.purgeTelemetry(90);
          if (purged > 0) {
            log('watcher', 'Telemetry purge: ' + purged + ' old record(s)');
          }
        } catch (err) {
          log('watcher', `Telemetry purge failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        }
      } catch (err) {
        log('watcher', `Session harvest failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
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
            if (lastFileChangeAt > 0 && Date.now() - lastFileChangeAt < embedQuietPeriodMs) {
              const sinceSec = Math.round((Date.now() - lastFileChangeAt) / 1000)
              log('watcher', `Embedding skipped: quiet period active (${sinceSec}s since last change, need ${Math.round(embedQuietPeriodMs / 1000)}s)`)
              isEmbedding = false;
              scheduleNextEmbedCycle();
              return;
            }
            let count = await embedPendingCodebase(store, embedder, 50, projectHash);
            if (count > 0) {
              log('watcher', 'Embedding cycle: ' + count + ' document(s) embedded')
              log('embed', `Embedded ${count} document(s)`);
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
                      log('embed', `Embedded ${wsCount} doc(s) for ${path.basename(wsPath)}`);
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
            // Detect SQLITE_CORRUPT and trigger recovery instead of endless retry
            if (err && typeof err === 'object' && 'code' in err && (err as any).code === 'SQLITE_CORRUPT') {
              log('embed', 'SQLITE_CORRUPT detected — database is corrupted. Restart the daemon to trigger recovery.', 'error');
              log('watcher', `SQLITE_CORRUPT in embedding cycle: ${err}. Daemon restart needed for recovery.`);
              // Stop retrying — the DB is corrupt, retrying will just spam errors
              return;
            }
            if (consecutiveFailures >= 5) {
              log('embed', `WARNING: ${consecutiveFailures} consecutive embedding failures. Check embedding provider configuration. Last error: ${err instanceof Error ? err.message : String(err)}`, 'warn');
            } else {
              log('embed', `Embedding cycle failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
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
                  log('learning', 'Automatic rollback triggered: expand rate dropped ' + Math.round(dropPercent * 100) + '%', 'warn');
                }
              }
            }
            
            lastLearningRun = Date.now();
            log('watcher', 'Learning cycle complete: saved bandit stats and config version');

            try {
              if (options.workspaceProfile) {
                options.workspaceProfile.updateFromTelemetry(projectHash);
              }
            } catch (profileErr) {
              log('watcher', `Profile population failed: ${profileErr instanceof Error ? profileErr.message : String(profileErr)}`, 'warn');
            }

            if (options.preferencesConfig?.enabled) {
              try {
                const { updatePreferenceWeights } = await import('./preference-model.js');
                updatePreferenceWeights(store, projectHash, options.preferencesConfig);
              } catch (prefErr) {
                log('watcher', `Preference update failed: ${prefErr instanceof Error ? prefErr.message : String(prefErr)}`, 'warn');
              }
            }
          } catch (err) {
            log('watcher', `Learning cycle failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
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
            log('watcher', `Consolidation cycle failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
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
            log('watcher', `Importance update failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          } finally {
            scheduleImportanceUpdate();
          }
        }, importanceInterval);
      };
      scheduleImportanceUpdate();
    }

    if (options.sequenceAnalyzer && options.proactiveConfig?.enabled) {
      const sequenceInterval = options.proactiveConfig.analysis_interval_ms ?? 1800000;
      const scheduleSequenceAnalysis = () => {
        if (stopped) return;
        sequenceTimeout = setTimeout(async () => {
          if (stopped) return;
          try {
            await options.sequenceAnalyzer!.runAnalysisCycle(projectHash);
            log('watcher', 'Sequence analysis cycle complete');
          } catch (err) {
            log('watcher', `Sequence analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          } finally {
            scheduleSequenceAnalysis();
          }
        }, sequenceInterval);
      };
      scheduleSequenceAnalysis();
    }

    const pruningConfig = options.pruningConfig;
    if (pruningConfig?.enabled) {
      const softDeleteInterval = pruningConfig.interval_ms;
      const hardDeleteInterval = 7 * 24 * 60 * 60 * 1000;

      const scheduleSoftDeleteCycle = () => {
        if (stopped) return;
        pruningSoftDeleteTimeout = setTimeout(() => {
          if (stopped) return;
          try {
            const result = runPruningCycle(store, pruningConfig, projectHash);
            const total = result.contradictedPruned + result.orphansPruned;
            if (total > 0) {
              log('watcher', `Pruning soft-delete: ${result.contradictedPruned} contradicted, ${result.orphansPruned} orphans`);
            }
          } catch (err) {
            log('watcher', `Pruning soft-delete failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          } finally {
            scheduleSoftDeleteCycle();
          }
        }, softDeleteInterval);
      };
      scheduleSoftDeleteCycle();

      const scheduleHardDeleteCycle = () => {
        if (stopped) return;
        pruningHardDeleteTimeout = setTimeout(() => {
          if (stopped) return;
          try {
            const deleted = hardDeletePrunedEntities(store, pruningConfig, projectHash);
            if (deleted > 0) {
              log('watcher', `Pruning hard-delete: ${deleted} entities permanently removed`);
            }
          } catch (err) {
            log('watcher', `Pruning hard-delete failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          } finally {
            scheduleHardDeleteCycle();
          }
        }, hardDeleteInterval);
      };
      scheduleHardDeleteCycle();
    }

    const mergeConfig = options.mergeConfig;
    if (mergeConfig?.enabled) {
      const scheduleMergeCycle = () => {
        if (stopped) return;
        mergeTimeout = setTimeout(() => {
          if (stopped) return;
          try {
            const result = runMergeCycle(store, mergeConfig, projectHash);
            if (result.merged > 0) {
              log('watcher', `Entity merge: ${result.groups} groups, ${result.merged} entities merged`);
            }
          } catch (err) {
            log('watcher', `Entity merge failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          } finally {
            scheduleMergeCycle();
          }
        }, mergeConfig.interval_ms);
      };
      scheduleMergeCycle();
    }
  };

  setupWatcher();
  setupPolling();
  startupIntegrityCheck().catch(err => {
    log('watcher', `Startup integrity check failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
  });

  if (embedder) {
    setTimeout(async () => {
      isEmbedding = true;
      try {
        const count = await embedPendingCodebase(store, embedder, 50, projectHash);
        if (count > 0) {
          log('embed', `Initial embedding: ${count} document(s)`);
        }
      } catch (err) {
        log('embed', `Initial embedding failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
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

      if (sequenceTimeout) {
        clearTimeout(sequenceTimeout);
        sequenceTimeout = null;
      }

      if (pruningSoftDeleteTimeout) {
        clearTimeout(pruningSoftDeleteTimeout);
        pruningSoftDeleteTimeout = null;
      }

      if (pruningHardDeleteTimeout) {
        clearTimeout(pruningHardDeleteTimeout);
        pruningHardDeleteTimeout = null;
      }

      if (mergeTimeout) {
        clearTimeout(mergeTimeout);
        mergeTimeout = null;
      }
      
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
    
    isDirty() {
      return dirty;
    },
    
    async triggerReindex(force?: boolean) {
      await triggerReindex(force);
    },
    
    getStats(): WatcherStats {
      return {
        filesWatched: watchedPaths.size,
        lastReindexAt,
        lastFileChangeAt,
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
