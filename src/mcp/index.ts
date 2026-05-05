import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResultCache } from '../cache.js';
import type { ServerDeps } from '../server/types.js';
import type { McpToolContext } from './tools/types.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerGraphTools } from './tools/graph.js';
import { registerCodeTools } from './tools/code.js';
import { registerIndexingTools } from './tools/indexing.js';

export function createMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'nano-brain', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const resultCache = new ResultCache();

  const checkReady = () => !!(deps.ready && !deps.ready.value);

  const getCorruptionWarning = (): string | null => {
    if (deps.corruptionWarningPending?.value) {
      deps.corruptionWarningPending.value = false;
      const corruptedPath = deps.corruptionWarningPending.corruptedPath || 'unknown';
      return `[WARNING] Database was corrupted and rebuilt. Some search results may be incomplete until reindexing completes. Corrupt file preserved at: ${corruptedPath}\n\n`;
    }
    return null;
  };

  const prependWarning = (text: string): string => {
    const warning = getCorruptionWarning();
    return warning ? warning + text : text;
  };

  const ctx: McpToolContext = {
    deps,
    resultCache,
    checkReady,
    prependWarning,
    currentProjectHash: deps.currentProjectHash,
    store: deps.store,
    providers: deps.providers,
  };

  registerMemoryTools(server, ctx);
  registerGraphTools(server, ctx);
  registerCodeTools(server, ctx);
  registerIndexingTools(server, ctx);

  return server;
}
