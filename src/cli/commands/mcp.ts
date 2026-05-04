import { startServer } from '../../server.js';
import { log } from '../../logger.js';
import { cliOutput, setStdioMode } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleMcp(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let useHttp = false;
  let port = 8282;
  let host = '127.0.0.1';
  let daemon = false;
  let root: string | undefined;

  for (const arg of commandArgs) {
    if (arg === '--http') {
      useHttp = true;
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--host=')) {
      host = arg.substring(7);
    } else if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--daemon') {
      daemon = true;
    } else if (arg === 'stop') {
      cliOutput('Daemon stop not implemented yet');
      return;
    }
  }

  if (!useHttp) {
    setStdioMode(true);
  }

  log('cli', 'mcp server start transport=' + (useHttp ? `http:${host}:${port}` : 'stdio'));
  await startServer({
    dbPath: globalOpts.dbPath,
    configPath: globalOpts.configPath,
    httpPort: useHttp ? port : undefined,
    httpHost: useHttp ? host : undefined,
    daemon,
    root,
  });
}
