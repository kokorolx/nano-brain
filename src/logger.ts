import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let enabled = process.env.NANO_BRAIN_LOG === '1';
let logDir: string | null = null;
let currentDate: string | null = null;
let currentPath: string | null = null;

/**
 * Enable logging from config. Called after config is loaded.
 * Either config `logging.enabled: true` OR env `NANO_BRAIN_LOG=1` turns logging on.
 */
export function initLogger(config?: { logging?: { enabled?: boolean } }): void {
  if (config?.logging?.enabled) {
    enabled = true;
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

export function log(tag: string, message: string): void {
  if (!enabled) return;
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
  appendFileSync(getLogPath(), line);
}

export function isLoggingEnabled(): boolean {
  return enabled;
}
