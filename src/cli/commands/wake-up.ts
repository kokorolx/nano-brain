import { createStore } from '../../store.js';
import { generateBriefing } from '../../wake-up.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { isInsideContainer } from '../../host.js';
import {
  DEFAULT_HTTP_PORT,
  detectRunningServer,
  proxyPost,
  getHttpHost,
  getHttpPort,
  resolveDbPath,
} from '../utils.js';

export async function handleWakeUp(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'wake-up command invoked');
  let format: 'text' | 'json' = 'text';
  let workspaceRoot = process.cwd();

  for (const arg of commandArgs) {
    if (arg === '--json') {
      format = 'json';
    } else if (arg.startsWith('--workspace=')) {
      workspaceRoot = arg.substring(12);
    }
  }

  const inContainer = isInsideContainer();
  const serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);

  if (inContainer && !serverRunning) {
    cliError(`Error: nano-brain server not reachable at ${getHttpHost()}:${getHttpPort()}. Ensure the Docker container is running:`);
    cliError('  docker start nano-brain');
    process.exit(1);
  }

  if (serverRunning) {
    try {
      const body: Record<string, any> = {};
      if (format === 'json') body.json = true;
      body.workspace = workspaceRoot;
      const data = await proxyPost(DEFAULT_HTTP_PORT, '/api/wake-up', body);
      if (format === 'json') {
        cliOutput(JSON.stringify(data, null, 2));
      } else {
        cliOutput(data.formatted || data.briefing || JSON.stringify(data));
      }
      return;
    } catch (err) {
      if (inContainer) {
        cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log('cli', 'HTTP proxy failed for wake-up, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const store = await createStore(resolvedDbPath);

  const result = generateBriefing(store, globalOpts.configPath, projectHash, {
    json: format === 'json',
  });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
  } else {
    cliOutput(result.formatted);
  }

  store.close();
}
