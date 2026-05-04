import { createStore } from '../../store.js';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleImpact(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let type: string | undefined
  let pattern: string | undefined
  let format: 'text' | 'json' = 'text'

  for (const arg of commandArgs) {
    if (arg.startsWith('--type=')) {
      type = arg.substring(7)
    } else if (arg.startsWith('--pattern=')) {
      pattern = arg.substring(10)
    } else if (arg === '--json') {
      format = 'json'
    }
  }

  log('cli', 'impact type=' + (type || '') + ' pattern=' + (pattern || ''));
  if (!type || !pattern) {
    cliError('Usage: impact --type=<type> --pattern=<pattern> [--json]')
    cliError('Types: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue')
    process.exit(1)
  }

  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.getSymbolImpact(type, pattern, projectHash)

  if (format === 'json') {
    cliOutput(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    cliOutput(`No symbols found for ${type}: ${pattern}`)
    store.close()
    return
  }

  const byOperation = new Map<string, Array<{ repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    if (!byOperation.has(r.operation)) byOperation.set(r.operation, [])
    byOperation.get(r.operation)!.push({ repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  cliOutput(`Impact Analysis: ${type} "${pattern}"`)
  cliOutput('')

  const operationLabels: Record<string, string> = {
    read: 'Readers',
    write: 'Writers',
    publish: 'Publishers',
    subscribe: 'Subscribers',
    define: 'Definitions',
    call: 'Callers',
    produce: 'Producers',
    consume: 'Consumers',
  }

  for (const [op, items] of byOperation) {
    const label = operationLabels[op] || op
    cliOutput(`${label} (${items.length}):`)
    for (const item of items) {
      cliOutput(`  ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    cliOutput('')
  }

  store.close()
}
