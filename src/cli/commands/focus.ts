import { createStore } from '../../store.js';
import * as path from 'path';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleFocus(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const filePath = commandArgs[0]

  if (!filePath) {
    cliError('Usage: focus <filepath>')
    process.exit(1)
  }

  log('cli', 'focus file=' + filePath);
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const dependencies = store.getFileDependencies(absolutePath, projectHash)
  const dependents = store.getFileDependents(absolutePath, projectHash)
  const centralityInfo = store.getDocumentCentrality(absolutePath)

  cliOutput(`File: ${absolutePath}`)
  cliOutput('')

  if (centralityInfo) {
    cliOutput(`Centrality: ${centralityInfo.centrality.toFixed(4)}`)
    if (centralityInfo.clusterId !== null) {
      const clusterMembers = store.getClusterMembers(centralityInfo.clusterId, projectHash)
      cliOutput(`Cluster ID: ${centralityInfo.clusterId} (${clusterMembers.length} members)`)
      if (clusterMembers.length > 0) {
        cliOutput('Cluster Members:')
        for (const member of clusterMembers.slice(0, 10)) {
          cliOutput(`  - ${member}`)
        }
        if (clusterMembers.length > 10) {
          cliOutput(`  ... and ${clusterMembers.length - 10} more`)
        }
      }
    }
  } else {
    cliOutput('Centrality: Not indexed')
  }
  cliOutput('')

  cliOutput(`Dependencies (imports): ${dependencies.length}`)
  for (const dep of dependencies) {
    cliOutput(`  → ${dep}`)
  }
  cliOutput('')

  cliOutput(`Dependents (imported by): ${dependents.length}`)
  for (const dep of dependents) {
    cliOutput(`  ← ${dep}`)
  }

  store.close()
}
