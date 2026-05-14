import { createStore } from '../../store.js';
import { cliOutput, cliError, log } from '../../logger.js';
import { isInsideContainer } from '../../host.js';
import {
  DEFAULT_HTTP_PORT,
  assertContainerServer,
  proxyGet,
} from '../utils.js';
import type { GlobalOptions } from '../types.js';

export async function handleTags(globalOpts: GlobalOptions): Promise<void> {
  const inContainer = isInsideContainer();
  const serverRunning = await assertContainerServer();

  if (serverRunning) {
    try {
      const result = await proxyGet(DEFAULT_HTTP_PORT, '/api/v1/tags') as { tags: Array<{ tag: string; count: number }> };
      const tags = result.tags ?? [];
      if (tags.length === 0) {
        cliOutput('No tags found.');
        return;
      }
      cliOutput('Tags:');
      for (const { tag, count } of tags) {
        cliOutput(`  ${tag}: ${count} document${count === 1 ? '' : 's'}`);
      }
      return;
    } catch (err) {
      if (inContainer) {
        cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log('cli', 'HTTP proxy failed for tags, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const store = await createStore(globalOpts.dbPath);
  const tags = store.listAllTags();

  if (tags.length === 0) {
    cliOutput('No tags found.');
    store.close();
    return;
  }

  cliOutput('Tags:');
  for (const { tag, count } of tags) {
    cliOutput(`  ${tag}: ${count} document${count === 1 ? '' : 's'}`);
  }
  store.close();
}
