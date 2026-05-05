import { z } from 'zod';
import * as crypto from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './types.js';
import { log } from '../../logger.js';
import { resolveWorkspace } from '../../server/utils.js';
import { resolveWorkspaceDbPath, openDatabase } from '../../store.js';
import { indexCodebase, embedPendingCodebase } from '../../codebase.js';

const WARMUP_ERROR = { isError: true, content: [{ type: 'text' as const, text: 'Server warming up, try again in a few seconds' }] };

export function registerIndexingTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, checkReady, store, providers } = ctx;

  server.tool(
    'memory_index_codebase',
    'Index codebase files in the current workspace',
    {
      root: z.string().optional().describe('Workspace root path to index. Defaults to configured root or server cwd.'),
    },
    async ({ root }) => {
      if (checkReady()) return WARMUP_ERROR;
      log('mcp', 'memory_index_codebase root="' + (root || '') + '"');

      const resolved = root ? resolveWorkspace(deps, undefined, root) : null;
      const effectiveRoot = resolved?.workspaceRoot || root || deps.workspaceRoot;
      const effectiveStore = resolved?.store || store;
      const effectiveProjectHash = resolved?.projectHash || crypto.createHash('sha256').update(effectiveRoot).digest('hex').substring(0, 12);

      let effectiveCodebaseConfig = deps.codebaseConfig;
      if (deps.daemon && deps.allWorkspaces && effectiveRoot) {
        const wsConfig = deps.allWorkspaces[effectiveRoot];
        if (wsConfig?.codebase) {
          effectiveCodebaseConfig = wsConfig.codebase;
        }
      }

      if (!effectiveCodebaseConfig?.enabled) {
        if (resolved?.needsClose) resolved.store.close();
        return {
          content: [
            {
              type: 'text',
              text: '❌ Codebase indexing is not enabled. Add `codebase: { enabled: true }` to your collections.yaml',
            },
          ],
          isError: true,
        }
      }

      const needsClose = resolved?.needsClose ?? false;
      const storeToUse = effectiveStore;
      const configToUse = effectiveCodebaseConfig;

      let symbolGraphDb = deps.db;
      let symbolGraphDbNeedsClose = false;
      if (resolved && resolved.projectHash !== deps.currentProjectHash && deps.dataDir && resolved.workspaceRoot) {
        const wsDbPath = resolveWorkspaceDbPath(deps.dataDir, resolved.workspaceRoot);
        symbolGraphDb = openDatabase(wsDbPath);
        symbolGraphDbNeedsClose = true;
      }

      log('codebase-debug', `symbolGraphDb=${symbolGraphDbNeedsClose ? 'workspace-specific' : 'startup'} root=${effectiveRoot} hash=${effectiveProjectHash}`, 'error')
      ;(async () => {
        try {
          const result = await indexCodebase(
            storeToUse,
            effectiveRoot,
            configToUse,
            effectiveProjectHash,
            providers.embedder,
            symbolGraphDb
          )
          log('codebase', `Indexing complete: ${result.filesScanned} scanned, ${result.filesIndexed} indexed, ${result.filesSkippedUnchanged} unchanged`)
          if (providers.embedder) {
            const embedded = await embedPendingCodebase(storeToUse, providers.embedder, 50, effectiveProjectHash)
            log('codebase', `Embedding complete: ${embedded} chunks embedded`)
          }
        } catch (err) {
          log('codebase', `Indexing failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        } finally {
          if (symbolGraphDbNeedsClose && symbolGraphDb) { symbolGraphDb.close() }
          if (needsClose) storeToUse.close();
        }
      })()

      return {
        content: [
          {
            type: 'text',
            text: `🔄 Codebase indexing started in background for ${effectiveRoot}`,
          },
        ],
      }
    }
  )
}
