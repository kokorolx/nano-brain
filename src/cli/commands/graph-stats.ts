import { createStore } from '../../store.js';
import { findCycles } from '../../graph.js';
import * as crypto from 'crypto';
import { log, cliOutput } from '../../logger.js';
import type { GlobalOptions } from '../types.js';

export async function handleGraphStats(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'graph-stats invoked');
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const stats = store.getGraphStats(projectHash)
  const edges = store.getFileEdges(projectHash)
  const cycles = findCycles(edges.map(e => ({ source: e.source_path, target: e.target_path })), 5)

  cliOutput('Graph Statistics')
  cliOutput('═══════════════════════════════════════════════════')
  cliOutput('')
  cliOutput(`Nodes: ${stats.nodeCount}`)
  cliOutput(`Edges: ${stats.edgeCount}`)
  cliOutput(`Clusters: ${stats.clusterCount}`)
  cliOutput('')

  if (stats.topCentrality.length > 0) {
    cliOutput('Top 10 by Centrality:')
    for (const { path: filePath, centrality } of stats.topCentrality) {
      cliOutput(`  ${centrality.toFixed(4)} - ${filePath}`)
    }
    cliOutput('')
  }

  if (cycles.length > 0) {
    cliOutput(`Cycles (length ≤ 5): ${cycles.length}`)
    for (const cycle of cycles.slice(0, 5)) {
      cliOutput(`  ${cycle.join(' → ')} → ${cycle[0]}`)
    }
    if (cycles.length > 5) {
      cliOutput(`  ... and ${cycles.length - 5} more`)
    }
  } else {
    cliOutput('Cycles: None detected')
  }

  store.close()
}
