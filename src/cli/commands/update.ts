import { createStore, indexDocument, extractProjectHashFromPath } from '../../store.js';
import { loadCollectionConfig, getCollections, scanCollectionFiles } from '../../collections.js';
import * as fs from 'fs';
import * as path from 'path';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { DEFAULT_OUTPUT_DIR } from '../utils.js';

export async function handleUpdate(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'update start');
  const store = await createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);

  if (!config) {
    cliError('No config file found');
    store.close();
    process.exit(1);
  }

  const collections = getCollections(config);
  let totalIndexed = 0;
  let totalSkipped = 0;

  for (const collection of collections) {
    cliOutput(`Scanning collection: ${collection.name}`);
    const files = await scanCollectionFiles(collection);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const title = path.basename(file, path.extname(file));
      const effectiveProjectHash = collection.name === 'sessions'
        ? extractProjectHashFromPath(file, DEFAULT_OUTPUT_DIR)
        : undefined;
      const result = indexDocument(store, collection.name, file, content, title, effectiveProjectHash);

      if (result.skipped) {
        totalSkipped++;
      } else {
        totalIndexed++;
      }
    }
  }

  cliOutput(`✅ Indexed ${totalIndexed} documents, skipped ${totalSkipped}`);
  store.close();
}
