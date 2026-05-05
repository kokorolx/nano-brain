import { loadCollectionConfig } from '../../collections.js';
import { resolveHostUrl } from '../../host.js';
import * as fs from 'fs';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { DEFAULT_DB_DIR, DEFAULT_OUTPUT_DIR, DEFAULT_MEMORY_DIR, DEFAULT_LOGS_DIR } from '../utils.js';

export async function handleReset(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'reset command invoked');
  const confirm = commandArgs.includes('--confirm');
  const dryRun = commandArgs.includes('--dry-run');
  const flagDatabases = commandArgs.includes('--databases');
  const flagSessions = commandArgs.includes('--sessions');
  const flagMemory = commandArgs.includes('--memory');
  const flagLogs = commandArgs.includes('--logs');
  const flagVectors = commandArgs.includes('--vectors');

  const hasAnyFlag = flagDatabases || flagSessions || flagMemory || flagLogs || flagVectors;
  const deleteDatabases = !hasAnyFlag || flagDatabases;
  const deleteSessions = !hasAnyFlag || flagSessions;
  const deleteMemory = !hasAnyFlag || flagMemory;
  const deleteLogs = !hasAnyFlag || flagLogs;
  const deleteVectors = !hasAnyFlag || flagVectors;

  if (!confirm && !dryRun) {
    cliError('⚠️  This will permanently delete nano-brain data.');
    cliError('   Run with --confirm to proceed, or --dry-run to preview.');
    process.exit(1);
  }

  const dataDir = DEFAULT_DB_DIR;
  const sessionsDir = DEFAULT_OUTPUT_DIR;
  const memoryDir = DEFAULT_MEMORY_DIR;
  const logsDir = DEFAULT_LOGS_DIR;

  let sqliteFiles: string[] = [];
  if (fs.existsSync(dataDir)) {
    sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
  }

  const sessionsExist = fs.existsSync(sessionsDir);
  const memoryExists = fs.existsSync(memoryDir);
  const logsExist = fs.existsSync(logsDir);

  const config = loadCollectionConfig(globalOpts.configPath);
  const vectorConfig = config?.vector;
  const collectionName = vectorConfig?.collection || 'nano-brain';
  const qdrantUrl = resolveHostUrl(vectorConfig?.url || 'http://localhost:6333');
  let qdrantReachable = false;
  let qdrantPointsCount = 0;

  if (deleteVectors) {
    try {
      const healthRes = await fetch(`${qdrantUrl}/healthz`);
      if (healthRes.ok) {
        qdrantReachable = true;
        const collectionRes = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collectionName)}`);
        if (collectionRes.ok) {
          const data = await collectionRes.json();
          const result = data.result || data;
          qdrantPointsCount = result.points_count ?? result.vectors_count ?? 0;
        }
      }
    } catch {
      qdrantReachable = false;
    }
  }

  if (dryRun) {
    cliOutput('Dry run — would delete:');
    cliOutput('');
    if (deleteDatabases) {
      cliOutput(`  SQLite databases:    ${sqliteFiles.length} files in ${dataDir}`);
    }
    if (deleteSessions) {
      cliOutput(`  Harvested sessions:  ${sessionsExist ? sessionsDir : '(not found)'}`);
    }
    if (deleteMemory) {
      cliOutput(`  Memory notes:        ${memoryExists ? memoryDir : '(not found)'}`);
    }
    if (deleteLogs) {
      cliOutput(`  Log files:           ${logsExist ? logsDir : '(not found)'}`);
    }
    if (deleteVectors) {
      if (qdrantReachable) {
        cliOutput(`  Qdrant collection:   nano-brain (${qdrantPointsCount} vectors)`);
      } else {
        cliOutput(`  Qdrant collection:   (not reachable at ${qdrantUrl})`);
      }
    }
    return;
  }

  if (deleteDatabases) {
    for (const file of sqliteFiles) {
      fs.unlinkSync(dataDir + '/' + file);
    }
    if (sqliteFiles.length > 0) {
      cliOutput(`🗑️  Deleted ${sqliteFiles.length} database files from ${dataDir}`);
    } else {
      cliOutput(`ℹ️  No database files found in ${dataDir}`);
    }
  }

  if (deleteSessions) {
    if (sessionsExist) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted harvested sessions from ${sessionsDir}`);
    } else {
      cliOutput(`ℹ️  No harvested sessions directory found`);
    }
  }

  if (deleteMemory) {
    if (memoryExists) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted memory notes from ${memoryDir}`);
    } else {
      cliOutput(`ℹ️  No memory directory found`);
    }
  }

  if (deleteLogs) {
    if (logsExist) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted log files from ${logsDir}`);
    } else {
      cliOutput(`ℹ️  No logs directory found`);
    }
  }

  if (deleteVectors) {
    if (qdrantReachable) {
      try {
        const deleteRes = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(collectionName)}`, { method: 'DELETE' });
        if (deleteRes.ok) {
          cliOutput(`🗑️  Deleted Qdrant collection '${collectionName}' (${qdrantPointsCount} vectors)`);
        } else {
          cliError(`⚠️  Failed to delete Qdrant collection: HTTP ${deleteRes.status}`);
        }
      } catch (err) {
        cliError(`⚠️  Failed to delete Qdrant collection: ${err}`);
      }
    } else {
      cliOutput(`ℹ️  Qdrant not reachable at ${qdrantUrl} — skipping vector cleanup`);
    }
  }

  cliOutput('');
  cliOutput('✅ Reset complete.');
}
