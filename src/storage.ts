import * as fs from 'fs';
import * as path from 'path';
import type { Store, StorageConfig } from './types.js';
import { log } from './logger.js';

const DEFAULT_MAX_SIZE = 2147483648;
const DEFAULT_RETENTION = 7776000000;
const DEFAULT_MIN_FREE_DISK = 104857600;

export function parseSize(value: string): number {
  if (!value || typeof value !== 'string') {
    return -1;
  }
  
  const match = value.trim().toUpperCase().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/);
  if (!match) {
    return -1;
  }
  
  const num = parseFloat(match[1]);
  const unit = match[2] || 'B';
  
  const multipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024,
  };
  
  return Math.floor(num * multipliers[unit]);
}

export function parseDuration(value: string): number {
  if (!value || typeof value !== 'string') {
    return -1;
  }
  
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(d|w|m|y)$/);
  if (!match) {
    return -1;
  }
  
  const num = parseFloat(match[1]);
  const unit = match[2];
  
  const msPerDay = 24 * 60 * 60 * 1000;
  const multipliers: Record<string, number> = {
    'd': msPerDay,
    'w': 7 * msPerDay,
    'm': 30 * msPerDay,
    'y': 365 * msPerDay,
  };
  
  return Math.floor(num * multipliers[unit]);
}

export function parseStorageConfig(raw?: { maxSize?: string; retention?: string; minFreeDisk?: string }): StorageConfig {
  let maxSize = DEFAULT_MAX_SIZE;
  let retention = DEFAULT_RETENTION;
  let minFreeDisk = DEFAULT_MIN_FREE_DISK;
  
  if (raw?.maxSize) {
    const parsed = parseSize(raw.maxSize);
    if (parsed > 0) {
      maxSize = parsed;
    } else {
      console.warn(`[storage] Invalid maxSize "${raw.maxSize}", using default 2GB`);
    }
  }
  
  if (raw?.retention) {
    const parsed = parseDuration(raw.retention);
    if (parsed > 0) {
      retention = parsed;
    } else {
      console.warn(`[storage] Invalid retention "${raw.retention}", using default 90d`);
    }
  }
  
  if (raw?.minFreeDisk) {
    const parsed = parseSize(raw.minFreeDisk);
    if (parsed > 0) {
      minFreeDisk = parsed;
    } else {
      console.warn(`[storage] Invalid minFreeDisk "${raw.minFreeDisk}", using default 100MB`);
    }
  }
  
  log('storage', 'parsed config maxSize=' + maxSize + ' retention=' + retention + ' minFreeDisk=' + minFreeDisk);
  return { maxSize, retention, minFreeDisk };
}

export function checkDiskSpace(dir: string, minFreeDisk: number): { ok: boolean; freeBytes: number } {
  try {
    const stats = fs.statfsSync(dir);
    const freeBytes = stats.bfree * stats.bsize;
    const ok = freeBytes >= minFreeDisk;
    log('storage', 'disk space check freeBytes=' + freeBytes + ' ok=' + ok);
    return {
      ok,
      freeBytes,
    };
  } catch {
    log('storage', 'disk space check unavailable');
    console.warn('[storage] statfs unavailable, disk safety check disabled');
    return { ok: true, freeBytes: -1 };
  }
}

function getDirectorySize(dirPath: string): number {
  let totalSize = 0;
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          totalSize += fs.statSync(fullPath).size;
        } catch {
        }
      }
    }
  } catch {
  }
  
  return totalSize;
}

interface SessionFile {
  path: string;
  mtime: number;
  size: number;
}

function collectSessionFiles(sessionsDir: string): SessionFile[] {
  const files: SessionFile[] = [];
  
  try {
    const hashDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const hashDir of hashDirs) {
      if (!hashDir.isDirectory()) continue;
      
      const hashDirPath = path.join(sessionsDir, hashDir.name);
      try {
        const mdFiles = fs.readdirSync(hashDirPath, { withFileTypes: true });
        for (const mdFile of mdFiles) {
          if (!mdFile.isFile() || !mdFile.name.endsWith('.md')) continue;
          
          const filePath = path.join(hashDirPath, mdFile.name);
          try {
            const stats = fs.statSync(filePath);
            files.push({
              path: filePath,
              mtime: stats.mtimeMs,
              size: stats.size,
            });
          } catch {
          }
        }
      } catch {
      }
    }
  } catch {
  }
  
  return files;
}

export function evictExpiredSessions(sessionsDir: string, retention: number, store: Store): number {
  const now = Date.now();
  const files = collectSessionFiles(sessionsDir);
  let evictedCount = 0;
  
  for (const file of files) {
    if (now - file.mtime > retention) {
      try {
        fs.unlinkSync(file.path);
        store.deleteDocumentsByPath(file.path);
        evictedCount++;
      } catch {
      }
    }
  }
  
  log('storage', 'evictExpiredSessions checked=' + files.length + ' evicted=' + evictedCount);
  return evictedCount;
}

export function evictBySize(sessionsDir: string, dbPath: string, maxSize: number, store: Store): number {
  let dbSize = 0;
  try {
    dbSize = fs.statSync(dbPath).size;
  } catch {
  }
  
  let sessionsSize = getDirectorySize(sessionsDir);
  let totalSize = dbSize + sessionsSize;
  
  log('storage', 'evictBySize totalSize=' + totalSize + ' maxSize=' + maxSize);
  
  if (totalSize <= maxSize) {
    return 0;
  }
  
  const files = collectSessionFiles(sessionsDir);
  files.sort((a, b) => a.mtime - b.mtime);
  
  let evictedCount = 0;
  
  for (const file of files) {
    if (totalSize <= maxSize) {
      break;
    }
    
    try {
      fs.unlinkSync(file.path);
      store.deleteDocumentsByPath(file.path);
      totalSize -= file.size;
      evictedCount++;
    } catch {
    }
  }
  
  log('storage', 'evictBySize evicted=' + evictedCount);
  return evictedCount;
}
