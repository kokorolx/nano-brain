import { createStore, openDatabase, resolveWorkspaceDbPath, resolveProjectLabel } from '../../store.js';
import { loadCollectionConfig, removeCollection, removeWorkspaceConfig } from '../../collections.js';
import type { CollectionConfig, Store } from '../../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export function resolveWorkspaceIdentifier(
  identifier: string,
  config: CollectionConfig | null,
  store: Store
): { projectHash: string; workspacePath: string | null } {
  const hexPrefixRegex = /^[a-f0-9]{4,12}$/;

  if (path.isAbsolute(identifier)) {
    const projectHash = crypto.createHash('sha256').update(identifier).digest('hex').substring(0, 12);
    return { projectHash, workspacePath: identifier };
  }

  if (hexPrefixRegex.test(identifier)) {
    const stats = store.getWorkspaceStats();
    const matches = stats.filter(s => s.projectHash.startsWith(identifier));

    if (matches.length === 1) {
      let workspacePath: string | null = null;
      if (config?.workspaces) {
        for (const [wsPath] of Object.entries(config.workspaces)) {
          const hash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
          if (hash === matches[0].projectHash) {
            workspacePath = wsPath;
            break;
          }
        }
      }
      return { projectHash: matches[0].projectHash, workspacePath };
    }

    if (matches.length > 1) {
      const details = matches.map(m => `  ${m.projectHash} (${m.count} docs)`).join('\n');
      throw new Error(`Ambiguous hash prefix "${identifier}" matches ${matches.length} workspaces:\n${details}\nUse a longer prefix or the full workspace path.`);
    }
  }

  if (config?.workspaces) {
    const nameMatches: Array<{ wsPath: string; projectHash: string }> = [];
    for (const wsPath of Object.keys(config.workspaces)) {
      if (path.basename(wsPath) === identifier) {
        const projectHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
        nameMatches.push({ wsPath, projectHash });
      }
    }

    if (nameMatches.length === 1) {
      return { projectHash: nameMatches[0].projectHash, workspacePath: nameMatches[0].wsPath };
    }

    if (nameMatches.length > 1) {
      const details = nameMatches.map(m => `  ${m.wsPath} (${m.projectHash})`).join('\n');
      throw new Error(`Ambiguous name "${identifier}" matches ${nameMatches.length} workspaces:\n${details}\nUse the full path or hash prefix instead.`);
    }
  }

  throw new Error(`No workspace found matching "${identifier}". Run "nano-brain rm --list" to see available workspaces.`);
}

export async function handleRm(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'rm command invoked');
  const config = loadCollectionConfig(globalOpts.configPath);
  let dryRun = false;
  let listMode = false;
  let identifier: string | null = null;

  for (const arg of commandArgs) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--list') {
      listMode = true;
    } else if (!arg.startsWith('-')) {
      identifier = arg;
    }
  }

  if (listMode) {
    const dataDir = path.dirname(globalOpts.dbPath);
    let dbFiles: string[] = [];
    try {
      dbFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite')).map(f => path.join(dataDir, f));
    } catch {
      cliError(`Cannot read data directory: ${dataDir}`);
      process.exit(1);
    }

    if (dbFiles.length === 0) {
      cliOutput('No workspaces found.');
      return;
    }

    cliOutput('Known workspaces:');
    cliOutput('');
    cliOutput('  Name                 Hash          Path                                           Docs');
    cliOutput('  ───────────────────  ────────────  ─────────────────────────────────────────────  ────');

    for (const dbFile of dbFiles) {
      const wsName = path.basename(dbFile, '.sqlite').split('-').slice(0, -1).join('-') || path.basename(dbFile, '.sqlite');
      let docs = 0;
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          docs = (readDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
        } catch { /* ignore */ }
        readDb.close();
      } catch { /* ignore */ }

      let wsPath = '';
      const fileHash = path.basename(dbFile, '.sqlite').split('-').pop() || '';
      if (config?.workspaces) {
        for (const [p] of Object.entries(config.workspaces)) {
          const h = crypto.createHash('sha256').update(p).digest('hex').substring(0, 12);
          if (h === fileHash) {
            wsPath = p;
            break;
          }
        }
      }

      cliOutput(`  ${wsName.padEnd(21)}  ${fileHash.padEnd(12)}  ${(wsPath || '(unknown)').padEnd(45)}  ${docs}`);
    }
    return;
  }

  if (!identifier) {
    cliError('Usage: nano-brain rm <workspace> [--dry-run]');
    cliError('       nano-brain rm --list');
    cliError('');
    cliError('<workspace> can be: absolute path, hash prefix, or workspace name');
    process.exit(1);
  }

  const store = await createStore(globalOpts.dbPath);
  try {
    const resolved = resolveWorkspaceIdentifier(identifier, config, store);
    const { projectHash, workspacePath } = resolved;

    if (dryRun) {
      const db = openDatabase(globalOpts.dbPath, { readonly: true });
      const count = (table: string, col: string = 'project_hash') => {
        try {
          return (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} = ?`).get(projectHash) as { cnt: number }).cnt;
        } catch { return 0; }
      };

      cliOutput(`Dry run — would remove workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}:`);
      cliOutput('');
      cliOutput(`  documents:        ${count('documents')}`);
      cliOutput(`  file_edges:       ${count('file_edges')}`);
      cliOutput(`  symbols:          ${count('symbols')}`);
      cliOutput(`  code_symbols:     ${count('code_symbols')}`);
      cliOutput(`  symbol_edges:     ${count('symbol_edges')}`);
      cliOutput(`  execution_flows:  ${count('execution_flows')}`);
      cliOutput(`  llm_cache:        ${count('llm_cache')}`);
      if (workspacePath && config?.workspaces?.[workspacePath]) {
        cliOutput(`  config entry:     ${workspacePath}`);
      }
      if (workspacePath && config?.collections) {
        const normalizedWs = workspacePath.replace(/\/$/, '');
        const affectedCollections = Object.entries(config.collections)
          .filter(([, coll]) => {
            const collPath = coll.path.startsWith('~') ? coll.path.replace('~', os.homedir()) : coll.path;
            return collPath.startsWith(normalizedWs + '/') || collPath === normalizedWs;
          })
          .map(([name]) => name);
        if (affectedCollections.length > 0) {
          cliOutput(`  collections:      ${affectedCollections.join(', ')}`);
        }
      }
      if (workspacePath) {
        const dataDir = path.dirname(globalOpts.dbPath);
        const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
        if (fs.existsSync(wsDbPath)) {
          cliOutput(`  database file:    ${path.basename(wsDbPath)}`);
        }
      }
      cliOutput('');
      cliOutput('Run without --dry-run to execute.');
      db.close();
      return;
    }

    cliOutput(`Removing workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}...`);
    const result = store.removeWorkspace(projectHash);

    let configRemoved = false;
    if (workspacePath) {
      configRemoved = removeWorkspaceConfig(globalOpts.configPath, workspacePath);
    }

    let collectionsRemoved = 0;
    if (workspacePath && config?.collections) {
      const normalizedWs = workspacePath.replace(/\/$/, '');
      const toRemove: string[] = [];
      for (const [name, coll] of Object.entries(config.collections)) {
        const collPath = coll.path.startsWith('~') ? coll.path.replace('~', os.homedir()) : coll.path;
        if (collPath.startsWith(normalizedWs + '/') || collPath === normalizedWs) {
          toRemove.push(name);
        }
      }
      for (const name of toRemove) {
        removeCollection(globalOpts.configPath, name);
        collectionsRemoved++;
      }
    }

    const totalDeleted = result.documentsDeleted + result.embeddingsDeleted + result.contentDeleted
      + result.cacheDeleted + result.fileEdgesDeleted + result.symbolsDeleted
      + result.codeSymbolsDeleted + result.symbolEdgesDeleted + result.executionFlowsDeleted;

    cliOutput('');
    cliOutput('Removed:');
    cliOutput(`  documents:        ${result.documentsDeleted}`);
    cliOutput(`  embeddings:       ${result.embeddingsDeleted}`);
    cliOutput(`  content:          ${result.contentDeleted}`);
    cliOutput(`  cache:            ${result.cacheDeleted}`);
    cliOutput(`  file_edges:       ${result.fileEdgesDeleted}`);
    cliOutput(`  symbols:          ${result.symbolsDeleted}`);
    cliOutput(`  code_symbols:     ${result.codeSymbolsDeleted}`);
    cliOutput(`  symbol_edges:     ${result.symbolEdgesDeleted}`);
    cliOutput(`  execution_flows:  ${result.executionFlowsDeleted}`);
    if (configRemoved) {
      cliOutput(`  config entry:     ${workspacePath}`);
    }
    if (collectionsRemoved > 0) {
      cliOutput(`  collections:      ${collectionsRemoved} removed`);
    }
    cliOutput(`  total rows:       ${totalDeleted}`);

    const db = openDatabase(globalOpts.dbPath, { readonly: true });
    const tables = ['documents', 'file_edges', 'symbols', 'code_symbols', 'symbol_edges', 'execution_flows', 'llm_cache'];
    let remaining = 0;
    for (const table of tables) {
      try {
        remaining += (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project_hash = ?`).get(projectHash) as { cnt: number }).cnt;
      } catch { /* table may not exist */ }
    }
    db.close();

    cliOutput('');
    if (remaining === 0) {
      cliOutput('✅ Verified: zero rows remain for this workspace.');
    } else {
      cliOutput(`⚠️  Warning: ${remaining} rows still found for ${resolveProjectLabel(projectHash)}. Partial removal.`);
    }

    if (workspacePath) {
      const dataDir = path.dirname(globalOpts.dbPath);
      const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
      if (fs.existsSync(wsDbPath) && wsDbPath !== globalOpts.dbPath) {
        try {
          const wsDb = openDatabase(wsDbPath, { readonly: true });
          let wsRemaining = 0;
          try {
            wsRemaining = (wsDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
          } catch { /* ignore */ }
          wsDb.close();
          if (wsRemaining === 0) {
            fs.unlinkSync(wsDbPath);
            try { fs.unlinkSync(wsDbPath + '-wal'); } catch { /* ignore */ }
            try { fs.unlinkSync(wsDbPath + '-shm'); } catch { /* ignore */ }
            cliOutput(`  database file:    ${path.basename(wsDbPath)} deleted`);
          }
        } catch {
          cliError(`  ⚠️  Could not clean up database file: ${path.basename(wsDbPath)}`);
        }
      }
    }
  } catch (err) {
    cliError((err as Error).message);
    process.exit(1);
  } finally {
    store.close();
  }
}
