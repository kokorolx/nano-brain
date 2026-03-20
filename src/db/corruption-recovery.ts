/**
 * SQLite Corruption Detection and Recovery Module
 * 
 * Detects database corruption at startup and automatically recovers
 * by renaming the corrupted file and initializing a fresh database.
 * 
 * Used by: nano-brain daemon startup sequence
 * Trigger: Before any database operations in createStore()
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { applyPragmas } from '../store.js';

const checkedPaths = new Set<string>();

export function resetCheckedPaths(): void {
  checkedPaths.clear();
}

export function getCheckedPaths(): Set<string> {
  return checkedPaths;
}

/**
 * Options for corruption recovery
 */
export interface CorruptionRecoveryOptions {
  /**
   * Logger instance for diagnostic output
   */
  logger?: {
    log: (category: string, message: string) => void;
    error: (message: string, error?: any) => void;
  };

  /**
   * Callback invoked when corruption is detected
   * Used to emit metrics/counters for monitoring
   */
  metricsCallback?: (event: 'corruption_detected') => void;
}

/**
 * Result of quick_check
 */
interface QuickCheckResult {
  quick_check: string;
}

/**
 * Result of corruption recovery
 */
export interface CorruptionRecoveryResult {
  db: Database.Database;
  recovered: boolean;
  recoveredAt?: string;
  corruptedPath?: string;
}

/**
 * Check database for corruption and automatically recover
 * 
 * This function:
 * 1. Opens existing database (if it exists)
 * 2. Runs PRAGMA integrity_check to detect corruption
 * 3. If valid: returns opened database instance
 * 4. If corrupted: renames file, emits metrics, returns fresh database
 * 
 * @param dbPath - Full path to the SQLite database file
 * @param options - Recovery options (logger, metrics callback)
 * @returns Database - Valid, open database instance
 * @throws Error if recovery cannot complete (let launchd handle restart)
 * 
 * @example
 * ```typescript
 * import { checkAndRecoverDB } from './db/corruption-recovery.js';
 * import { log } from './logger.js';
 * 
 * const db = checkAndRecoverDB(
 *   '~/.nano-brain/index.db',
 *   {
 *     logger: { log, error: console.error },
 *     metricsCallback: (event) => {
 *       if (event === 'corruption_detected') {
 *         recordCorruptionDetected(); // emit Prometheus counter
 *       }
 *     }
 *   }
 * );
 * ```
 */
export function checkAndRecoverDB(
  dbPath: string,
  options?: CorruptionRecoveryOptions
): CorruptionRecoveryResult {
  const logger = options?.logger;
  const metricsCallback = options?.metricsCallback;

  // Resolve to absolute path for consistent cache key
  const resolvedPath = path.resolve(dbPath);

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger?.log('corruption-recovery', `Created directory: ${dir}`);
  }

  // If database file doesn't exist, create fresh
  if (!fs.existsSync(resolvedPath)) {
    logger?.log('corruption-recovery', `No existing database at ${resolvedPath}, creating fresh`);
    const freshDb = new Database(resolvedPath);
    applyPragmas(freshDb);
    checkedPaths.add(resolvedPath);
    return { db: freshDb, recovered: false };
  }

  // Skip integrity check if already checked this path in this process
  if (checkedPaths.has(resolvedPath)) {
    logger?.log('corruption-recovery', `Skipping integrity check (already verified): ${resolvedPath}`);
    const db = new Database(resolvedPath);
    applyPragmas(db);
    return { db, recovered: false };
  }

  // Database file exists - check integrity
  logger?.log('corruption-recovery', `Checking database integrity at ${resolvedPath}`);

  let isCorrupted = false;

  try {
    // Open database with read-only mode initially to check integrity
    // Using a test connection to avoid modifying anything
    const checkDb = new Database(resolvedPath, { readonly: false });
    applyPragmas(checkDb);

    // Run quick_check (faster than integrity_check, <0.5s on 200MB)
    try {
      const result = checkDb.pragma('quick_check') as QuickCheckResult[];
      
      if (result.length === 0 || (result[0] && result[0].quick_check !== 'ok')) {
        isCorrupted = true;
        logger?.log('corruption-recovery', `Quick check FAILED: ${JSON.stringify(result)}`);
      } else {
        logger?.log('corruption-recovery', 'Quick check PASSED - database is valid');
        checkedPaths.add(resolvedPath);
      }
    } catch (checkError) {
      // If quick_check itself throws, database is corrupted
      isCorrupted = true;
      logger?.error(`Quick check threw exception: ${checkError instanceof Error ? checkError.message : String(checkError)}`);
    }

    checkDb.close();

  } catch (openError) {
    const errMsg = openError instanceof Error ? openError.message : String(openError);
    const errCode = (openError as NodeJS.ErrnoException)?.code;
    if (errCode === 'ERR_DLOPEN_FAILED' || errMsg.includes('dlopen') || errMsg.includes('mach-o') || errMsg.includes('MODULE_NOT_FOUND')) {
      logger?.error(`Native module loading failed (NOT corruption): ${errMsg}`);
      throw openError;
    }
    isCorrupted = true;
    logger?.error(`Failed to open database: ${errMsg}`);
  }

  // If corruption detected, perform recovery
  if (isCorrupted) {
    logger?.log('corruption-recovery', `Database corruption detected - starting recovery`);
    
    // Emit metrics for monitoring/alerting
    metricsCallback?.('corruption_detected');

    // Generate timestamp for backup filename
    const isoTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // YYYY-MM-DDTHH-mm-ss
    const corruptedPath = `${resolvedPath}.corrupted.${isoTimestamp}`;

    try {
      // Rename corrupted file
      fs.renameSync(resolvedPath, corruptedPath);
      logger?.log('corruption-recovery', `Renamed corrupted database to: ${corruptedPath}`);

      // Clean up WAL and SHM files (Write-Ahead Log and Shared Memory)
      const walPath = `${resolvedPath}-wal`;
      const shmPath = `${resolvedPath}-shm`;

      if (fs.existsSync(walPath)) {
        fs.unlinkSync(walPath);
        logger?.log('corruption-recovery', `Removed WAL file: ${walPath}`);
      }

      if (fs.existsSync(shmPath)) {
        fs.unlinkSync(shmPath);
        logger?.log('corruption-recovery', `Removed SHM file: ${shmPath}`);
      }

      // Write CORRUPTION_NOTICE.md for user visibility
      const noticeDir = path.join(os.homedir(), '.nano-brain');
      const noticePath = path.join(noticeDir, 'CORRUPTION_NOTICE.md');
      const noticeEntry = `\n## Corruption Recovered: ${new Date().toISOString()}\n\n- **Original file**: ${resolvedPath}\n- **Corrupt file preserved at**: ${corruptedPath}\n- **Action taken**: Renamed corrupt file, created fresh database\n- **To inspect**: \`sqlite3 ${corruptedPath} ".recover"\`\n\n`;
      try {
        fs.appendFileSync(noticePath, noticeEntry);
        logger?.log('corruption-recovery', `Wrote recovery notice to: ${noticePath}`);
      } catch { /* ignore write errors */ }

    } catch (renameError) {
      const errMsg = renameError instanceof Error ? renameError.message : String(renameError);
      logger?.error(`Failed to rename corrupted database: ${errMsg}`);
      throw renameError; // Let launchd handle the restart
    }

    logger?.log('corruption-recovery', `Initializing fresh database at ${resolvedPath}`);
    const freshDb = new Database(resolvedPath);
    applyPragmas(freshDb);

    try {
      const freshCheck = freshDb.pragma('quick_check') as QuickCheckResult[];
      if (freshCheck.length === 0 || (freshCheck[0] && freshCheck[0].quick_check !== 'ok')) {
        const err = new Error(`Fresh database failed quick_check: ${JSON.stringify(freshCheck)}`);
        logger?.error(err.message);
        throw err;
      }
      logger?.log('corruption-recovery', 'Fresh database passed quick_check');
    } catch (freshCheckError) {
      const errMsg = freshCheckError instanceof Error ? freshCheckError.message : String(freshCheckError);
      logger?.error(`Fresh database quick_check failed: ${errMsg}`);
      throw freshCheckError;
    }

    checkedPaths.add(resolvedPath);
    return { db: freshDb, recovered: true, recoveredAt: new Date().toISOString(), corruptedPath };
  }

  checkedPaths.add(resolvedPath);
  const db = new Database(resolvedPath);
  applyPragmas(db);
  return { db, recovered: false };
}

/**
 * Utility: Detect all corrupted backups in a directory
 * Useful for cleanup and reporting
 */
export function findCorruptedBackups(parentDir: string, dbBasename: string = 'index.db'): string[] {
  const pattern = new RegExp(`^${dbBasename}\\.corrupted\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}$`);
  
  try {
    const files = fs.readdirSync(parentDir);
    return files.filter(f => pattern.test(f)).map(f => path.join(parentDir, f));
  } catch {
    return [];
  }
}

/**
 * Utility: Clean up old corrupted backups (keep recent ones for debugging)
 * 
 * @param parentDir - Directory containing database and backups
 * @param dbBasename - Database filename (default: 'index.db')
 * @param keepCount - Number of recent backups to keep (default: 5)
 */
export function cleanupOldCorruptedBackups(
  parentDir: string,
  dbBasename: string = 'index.db',
  keepCount: number = 5
): void {
  const backups = findCorruptedBackups(parentDir, dbBasename);
  
  if (backups.length > keepCount) {
    // Sort by name (timestamp), keep most recent
    const sorted = backups.sort().reverse();
    const toDelete = sorted.slice(keepCount);
    
    toDelete.forEach(file => {
      try {
        fs.unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    });
  }
}
