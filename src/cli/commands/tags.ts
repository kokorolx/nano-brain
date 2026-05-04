import { createStore } from '../../store.js';
import { cliOutput } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleTags(globalOpts: GlobalOptions): Promise<void> {
  const store = await createStore(globalOpts.dbPath)
  const tags = store.listAllTags()

  if (tags.length === 0) {
    cliOutput('No tags found.')
    store.close()
    return
  }

  cliOutput('Tags:')
  for (const { tag, count } of tags) {
    cliOutput(`  ${tag}: ${count} document${count === 1 ? '' : 's'}`)
  }
  store.close()
}
