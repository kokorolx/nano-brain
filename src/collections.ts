import type { Collection, CollectionConfig, WorkspaceConfig, TelemetryConfig, LearningConfig, ConsolidationConfig, ImportanceConfig, IntentConfig, ProactiveConfig } from './types.js';
import { DEFAULT_TELEMETRY_CONFIG, DEFAULT_LEARNING_CONFIG, DEFAULT_CONSOLIDATION_CONFIG, DEFAULT_IMPORTANCE_CONFIG, DEFAULT_INTENT_CONFIG, DEFAULT_PROACTIVE_CONFIG } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse, stringify } from 'yaml';
import fg from 'fast-glob';
import { log } from './logger.js';
import { BUILTIN_EXCLUDE_PATTERNS, loadGitignorePatterns } from './codebase.js';

export function loadCollectionConfig(configPath: string): CollectionConfig | null {
  if (!fs.existsSync(configPath)) {
    log('collections', 'config not found at ' + configPath);
    return null;
  }
  
  log('collections', 'loading config from ' + configPath);
  const content = fs.readFileSync(configPath, 'utf-8');
  const config = parse(content) as CollectionConfig;
  return config;
}

export function saveCollectionConfig(configPath: string, config: CollectionConfig): void {
  log('collections', 'saving config to ' + configPath);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const yaml = stringify(config);
  fs.writeFileSync(configPath, yaml, 'utf-8');
}

export function getCollections(config: CollectionConfig): Collection[] {
  const collections: Collection[] = [];
  
  if (!config.collections) {
    return collections;
  }
  
  for (const [name, collectionData] of Object.entries(config.collections)) {
    collections.push({
      name,
      path: collectionData.path,
      pattern: collectionData.pattern || '**/*.md',
      context: collectionData.context,
    });
  }
  
  return collections;
}

export function addCollection(
  configPath: string,
  name: string,
  collectionPath: string,
  pattern?: string
): CollectionConfig {
  let config = loadCollectionConfig(configPath);
  
  if (!config) {
    config = {
      collections: {},
    };
  }
  
  if (!config.collections) {
    config.collections = {};
  }
  config.collections[name] = {
    path: collectionPath,
    pattern: pattern || '**/*.md',
    update: 'auto',
  };
  
  saveCollectionConfig(configPath, config);
  return config;
}

export function removeCollection(configPath: string, name: string): CollectionConfig {
  const config = loadCollectionConfig(configPath);
  
  if (!config) {
    throw new Error('Config file not found');
  }
  
  if (config.collections) {
    delete config.collections[name];
  }
  
  saveCollectionConfig(configPath, config);
  return config;
}

export function listCollections(config: CollectionConfig): string[] {
  return Object.keys(config.collections || {});
}

export function renameCollection(
  configPath: string,
  oldName: string,
  newName: string
): CollectionConfig {
  const config = loadCollectionConfig(configPath);
  
  if (!config) {
    throw new Error('Config file not found');
  }
  
  if (!config.collections || !config.collections[oldName]) {
    throw new Error(`Collection "${oldName}" not found`);
  }
  
  config.collections[newName] = config.collections[oldName];
  delete config.collections[oldName];
  
  saveCollectionConfig(configPath, config);
  return config;
}

export function addContext(
  configPath: string,
  collectionName: string,
  pathPrefix: string,
  description: string
): CollectionConfig {
  const config = loadCollectionConfig(configPath);
  
  if (!config) {
    throw new Error('Config file not found');
  }
  
  if (!config.collections || !config.collections[collectionName]) {
    throw new Error(`Collection "${collectionName}" not found`);
  }
  
  if (!config.collections[collectionName].context) {
    config.collections[collectionName].context = {};
  }
  
  config.collections[collectionName].context![pathPrefix] = description;
  
  saveCollectionConfig(configPath, config);
  return config;
}

export function findContextForPath(config: CollectionConfig, filePath: string): string | null {
  let longestMatch: { prefix: string; description: string } | null = null;
  
  for (const collectionData of Object.values(config.collections || {})) {
    if (!collectionData.context) {
      continue;
    }
    
    for (const [prefix, description] of Object.entries(collectionData.context)) {
      if (filePath.includes(prefix)) {
        if (!longestMatch || prefix.length > longestMatch.prefix.length) {
          longestMatch = { prefix, description };
        }
      }
    }
  }
  
  return longestMatch ? longestMatch.description : null;
}

export function listAllContexts(
  config: CollectionConfig
): Array<{ collection: string; prefix: string; description: string }> {
  const contexts: Array<{ collection: string; prefix: string; description: string }> = [];
  
  for (const [collectionName, collectionData] of Object.entries(config.collections || {})) {
    if (!collectionData.context) {
      continue;
    }
    
    for (const [prefix, description] of Object.entries(collectionData.context)) {
      contexts.push({
        collection: collectionName,
        prefix,
        description,
      });
    }
  }
  
  return contexts;
}

export async function scanCollectionFiles(collection: Collection): Promise<string[]> {
  const expandedPath = collection.path.replace(/^~/, os.homedir());
  
  if (!fs.existsSync(expandedPath)) {
    log('collections', 'scan collection=' + collection.name + ' path=' + expandedPath + ' not found');
    return [];
  }
  
  const gitignorePatterns = loadGitignorePatterns(expandedPath);
  const ignore = [...BUILTIN_EXCLUDE_PATTERNS, ...gitignorePatterns];
  
  const files = await fg(collection.pattern, {
    cwd: expandedPath,
    absolute: true,
    onlyFiles: true,
    ignore,
  });
  
  log('collections', 'scan collection=' + collection.name + ' path=' + expandedPath + ' files=' + files.length);
  return files;
}

export function resolveCollectionPath(collection: Collection, basePath: string): string {
  return collection.path;
}

export function getWorkspaceConfig(config: CollectionConfig | null, workspaceRoot: string): WorkspaceConfig {
  // 1. Check workspaces map for exact match
  if (config?.workspaces?.[workspaceRoot]) {
    log('collections', 'workspace config source=workspaces map for ' + workspaceRoot);
    return config.workspaces[workspaceRoot]
  }
  // 2. Fall back to top-level codebase (backward compat)
  if (config?.codebase) {
    log('collections', 'workspace config source=top-level codebase');
    return { codebase: config.codebase }
  }
  // 3. Default: codebase enabled, auto-detect everything
  log('collections', 'workspace config source=default');
  return { codebase: { enabled: true } }
}

export function removeWorkspaceConfig(configPath: string, workspaceRoot: string): boolean {
  const config = loadCollectionConfig(configPath);
  if (!config?.workspaces?.[workspaceRoot]) {
    return false;
  }
  delete config.workspaces[workspaceRoot];
  saveCollectionConfig(configPath, config);
  return true;
}

export function setWorkspaceConfig(configPath: string, workspaceRoot: string, wsConfig: WorkspaceConfig): void {
  let config = loadCollectionConfig(configPath)
  if (!config) {
    config = { collections: {} }
  }
  if (!config.workspaces) {
    config.workspaces = {}
  }
  config.workspaces[workspaceRoot] = wsConfig
  saveCollectionConfig(configPath, config)
}

export function parseTelemetryConfig(partial?: Partial<TelemetryConfig>): TelemetryConfig {
  return { ...DEFAULT_TELEMETRY_CONFIG, ...partial };
}

export function parseLearningConfig(partial?: Partial<LearningConfig>): LearningConfig {
  return { ...DEFAULT_LEARNING_CONFIG, ...partial };
}

export function parseConsolidationConfig(partial?: Partial<ConsolidationConfig>): ConsolidationConfig {
  return { ...DEFAULT_CONSOLIDATION_CONFIG, ...partial };
}

export function parseImportanceConfig(partial?: Partial<ImportanceConfig>): ImportanceConfig {
  return { ...DEFAULT_IMPORTANCE_CONFIG, ...partial };
}

export function parseIntentConfig(partial?: Partial<IntentConfig>): IntentConfig {
  if (!partial) return { ...DEFAULT_INTENT_CONFIG };
  return {
    enabled: partial.enabled ?? DEFAULT_INTENT_CONFIG.enabled,
    intents: partial.intents ?? DEFAULT_INTENT_CONFIG.intents,
  };
}

export function parseProactiveConfig(partial?: Partial<ProactiveConfig>): ProactiveConfig {
  return { ...DEFAULT_PROACTIVE_CONFIG, ...partial };
}
