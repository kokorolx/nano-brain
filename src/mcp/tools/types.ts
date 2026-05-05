import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResultCache } from '../../cache.js';
import type { ServerDeps } from '../../server/types.js';
import type { SearchProviders } from '../../search.js';
import type { Store } from '../../types.js';

export interface McpToolContext {
  deps: ServerDeps;
  resultCache: ResultCache;
  checkReady: () => boolean;
  prependWarning: (text: string) => string;
  currentProjectHash: string;
  store: Store;
  providers: SearchProviders;
}

export type { McpServer };
