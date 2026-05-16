import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadCollectionConfig } from '../../collections.js';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { DEFAULT_DB_DIR } from '../utils.js';

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1000) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function computeExpectedDbPath(dataDir: string, workspacePath: string): string {
  const dirName = path.basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
  return path.join(dataDir, `${dirName}-${hash}.sqlite`);
}

export interface DbCleanResult {
  orphanedDbs: Array<{ file: string; size: number }>;
  corruptedBackups: Array<{ file: string; size: number; ageDays: number }>;
  orphanedWalShm: Array<{ file: string; size: number }>;
  configuredWorkspaces: string[];
  dataDir: string;
}

export function scanForOrphanedDbs(dataDir: string, configuredWorkspaces: string[]): DbCleanResult {
  const expectedDbPaths = new Set<string>(
    configuredWorkspaces.map(ws => computeExpectedDbPath(dataDir, ws))
  );

  const allFiles = fs.readdirSync(dataDir);

  const orphanedDbs: Array<{ file: string; size: number }> = [];
  const corruptedBackups: Array<{ file: string; size: number; ageDays: number }> = [];
  const orphanedWalShm: Array<{ file: string; size: number }> = [];

  for (const file of allFiles) {
    const fullPath = path.join(dataDir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (file.endsWith('.sqlite')) {
      if (!expectedDbPaths.has(fullPath)) {
        orphanedDbs.push({ file: fullPath, size: stat.size });
      }
    } else if (file.includes('.sqlite.corrupted.')) {
      const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
      corruptedBackups.push({ file: fullPath, size: stat.size, ageDays });
    } else if (file.endsWith('.sqlite-wal') || file.endsWith('.sqlite-shm')) {
      // Orphaned WAL/SHM: main .sqlite doesn't exist
      const mainDb = fullPath.replace(/-wal$/, '').replace(/-shm$/, '');
      if (!fs.existsSync(mainDb)) {
        orphanedWalShm.push({ file: fullPath, size: stat.size });
      }
    }
  }

  return { orphanedDbs, corruptedBackups, orphanedWalShm, configuredWorkspaces, dataDir };
}

export async function handleDbClean(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'db:clean command invoked');

  const dryRun = commandArgs.includes('--dry-run');
  const confirm = commandArgs.includes('--confirm');

  if (!dryRun && !confirm) {
    cliError('⚠️  Run with --dry-run to preview, or --confirm to delete orphaned databases.');
    process.exit(1);
  }

  const dataDir = DEFAULT_DB_DIR;
  if (!fs.existsSync(dataDir)) {
    cliOutput(`ℹ️  Data directory not found: ${dataDir}`);
    return;
  }

  const config = loadCollectionConfig(globalOpts.configPath);
  const configuredWorkspaces = Object.keys(config?.workspaces ?? {});

  const { orphanedDbs, corruptedBackups, orphanedWalShm } = scanForOrphanedDbs(dataDir, configuredWorkspaces);

  if (orphanedDbs.length === 0 && corruptedBackups.length === 0 && orphanedWalShm.length === 0) {
    cliOutput(`✅ No orphaned databases found. (${configuredWorkspaces.length} configured workspace(s))`);
    return;
  }

  const totalSize = [...orphanedDbs, ...corruptedBackups, ...orphanedWalShm].reduce((sum, f) => sum + f.size, 0);

  cliOutput('');
  cliOutput(`Configured workspaces: ${configuredWorkspaces.length}`);
  for (const ws of configuredWorkspaces) {
    cliOutput(`  ✅ ${ws}`);
  }
  cliOutput('');

  if (orphanedDbs.length > 0) {
    cliOutput(`Orphaned databases (${orphanedDbs.length}):`);
    for (const { file, size } of orphanedDbs) {
      cliOutput(`  ❌ ${path.basename(file)}  ${formatBytes(size)}`);
    }
    cliOutput('');
  }

  if (corruptedBackups.length > 0) {
    cliOutput(`Corrupted backups (${corruptedBackups.length}):`);
    for (const { file, size, ageDays } of corruptedBackups) {
      cliOutput(`  🟡 ${path.basename(file)}  ${formatBytes(size)}  (${Math.floor(ageDays)}d old)`);
    }
    cliOutput('');
  }

  if (orphanedWalShm.length > 0) {
    cliOutput(`Orphaned WAL/SHM files (${orphanedWalShm.length}):`);
    for (const { file, size } of orphanedWalShm) {
      cliOutput(`  🟡 ${path.basename(file)}  ${formatBytes(size)}`);
    }
    cliOutput('');
  }

  cliOutput(`Total reclaimable: ${formatBytes(totalSize)}`);
  cliOutput('');

  if (dryRun) {
    cliOutput('Dry run — nothing deleted. Run with --confirm to delete.');
    return;
  }

  let deletedCount = 0;
  let deletedSize = 0;

  const filesToDelete = [...orphanedDbs, ...corruptedBackups, ...orphanedWalShm];
  for (const { file, size } of filesToDelete) {
    try {
      fs.unlinkSync(file);
      deletedCount++;
      deletedSize += size;
      // Also delete corresponding WAL/SHM for main DB files
      if (file.endsWith('.sqlite')) {
        for (const ext of ['-wal', '-shm']) {
          const aux = file + ext;
          if (fs.existsSync(aux)) {
            try {
              const auxStat = fs.statSync(aux);
              fs.unlinkSync(aux);
              deletedCount++;
              deletedSize += auxStat.size;
            } catch { /* best effort */ }
          }
        }
      }
    } catch (err) {
      cliError(`Failed to delete ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cliOutput(`🗑️  Deleted ${deletedCount} file(s) — ${formatBytes(deletedSize)} freed.`);
}
