import { createStore } from '../../store.js';
import * as crypto from 'crypto';
import { log, cliOutput } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleSymbols(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let type: string | undefined
  let pattern: string | undefined
  let repo: string | undefined
  let operation: string | undefined
  let format: 'text' | 'json' = 'text'

  for (const arg of commandArgs) {
    if (arg.startsWith('--type=')) {
      type = arg.substring(7)
    } else if (arg.startsWith('--pattern=')) {
      pattern = arg.substring(10)
    } else if (arg.startsWith('--repo=')) {
      repo = arg.substring(7)
    } else if (arg.startsWith('--operation=')) {
      operation = arg.substring(12)
    } else if (arg === '--json') {
      format = 'json'
    }
  }

  log('cli', 'symbols type=' + (type || '') + ' pattern=' + (pattern || '') + ' repo=' + (repo || '') + ' operation=' + (operation || ''));
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.querySymbols({
    type,
    pattern,
    repo,
    operation,
    projectHash,
  })

  if (format === 'json') {
    cliOutput(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    cliOutput('No symbols found matching the criteria.')
    store.close()
    return
  }

  const grouped = new Map<string, Array<{ operation: string; repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    const key = `${r.type}:${r.pattern}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push({ operation: r.operation, repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  cliOutput(`Found ${results.length} symbol(s) across ${grouped.size} pattern(s)`)
  cliOutput('')

  for (const [key, items] of grouped) {
    const [symbolType, symbolPattern] = key.split(':')
    cliOutput(`${symbolType}: ${symbolPattern}`)
    for (const item of items) {
      cliOutput(`  [${item.operation}] ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    cliOutput('')
  }

  store.close()
}
