import { createStore } from '../../store.js';
import { cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleGet(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const id = commandArgs[0];

  if (!id) {
    cliError('Missing document id or path');
    process.exit(1);
  }

  let full = false;
  let fromLine: number | undefined;
  let maxLines: number | undefined;

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i];

    if (arg === '--full') {
      full = true;
    } else if (arg.startsWith('--from=')) {
      fromLine = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--lines=')) {
      maxLines = parseInt(arg.substring(8), 10);
    }
  }

  const store = await createStore(globalOpts.dbPath);
  const doc = store.findDocument(id);

  if (!doc) {
    cliError(`Document not found: ${id}`);
    store.close();
    process.exit(1);
  }

  cliOutput(`Document: ${doc.collection}/${doc.path}`);
  cliOutput(`Title: ${doc.title}`);
  cliOutput(`Docid: ${doc.hash.substring(0, 6)}`);
  cliOutput('');

  const body = store.getDocumentBody(doc.hash, fromLine, maxLines);
  if (body) {
    cliOutput(body);
  }

  store.close();
}
