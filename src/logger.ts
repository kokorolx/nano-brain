import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let enabled = process.env.NANO_BRAIN_LOG === '1';
let logDir: string | null = null;
let currentDate: string | null = null;
let currentPath: string | null = null;
let logLevel: LogLevel = 'info';
let lastRotateCheck = 0;
const ROTATE_CHECK_INTERVAL = 60_000;
const MAX_LOG_SIZE = 50 * 1024 * 1024;
const MAX_LOG_AGE_DAYS = 2;

/**
 * Enable logging from config. Called after config is loaded.
 * Either config `logging.enabled: true` OR env `NANO_BRAIN_LOG=1` turns logging on.
 */
export function initLogger(config?: { logging?: { enabled?: boolean; level?: string } }): void {
  if (config?.logging?.enabled) {
    enabled = true;
  }
  if (config?.logging?.level) {
    const level = config.logging.level.toLowerCase() as LogLevel;
    if (level in LEVEL_PRIORITY) {
      logLevel = level;
    }
  }
}

function ensureLogDir(): string {
  if (!logDir) {
    logDir = join(homedir(), '.nano-brain', 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }
  return logDir;
}

function getLogPath(): string {
  const today = new Date().toISOString().split('T')[0];
  if (today !== currentDate) {
    currentDate = today;
    currentPath = join(ensureLogDir(), `nano-brain-${today}.log`);
  }
  return currentPath!;
}

function rotateLogs(): void {
  const now = Date.now();
  if (now - lastRotateCheck < ROTATE_CHECK_INTERVAL) return;
  lastRotateCheck = now;

  const dir = ensureLogDir();
  const logPath = getLogPath();

  try {
    if (existsSync(logPath)) {
      const stats = statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const rotatedPath = logPath + '.1';
        renameSync(logPath, rotatedPath);
      }
    }
  } catch {
  }

  try {
    const files = readdirSync(dir);
    const cutoff = now - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.startsWith('nano-brain-') || !file.endsWith('.log')) continue;
      const filePath = join(dir, file);
      try {
        const stats = statSync(filePath);
        if (stats.mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {
      }
    }
  } catch {
  }
}

export function log(tag: string, message: string, level: LogLevel = 'info'): void {
  if (!enabled) return;
  if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[logLevel]) return;
  const line = `[${new Date().toISOString()}] [${level}] [${tag}] ${message}\n`;
  appendFileSync(getLogPath(), line);
  rotateLogs();
}

export function isLoggingEnabled(): boolean {
  return enabled;
}

export function cliOutput(...args: unknown[]): void {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  process.stdout.write(message + '\n');
  if (enabled) {
    appendFileSync(getLogPath(), `[${new Date().toISOString()}] [info] [cli] ${message}\n`);
  }
}

export function cliError(...args: unknown[]): void {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  process.stderr.write(message + '\n');
  if (enabled) {
    appendFileSync(getLogPath(), `[${new Date().toISOString()}] [error] [cli] ${message}\n`);
  }
}
