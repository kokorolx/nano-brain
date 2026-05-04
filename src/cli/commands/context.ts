import { openDatabase } from '../../store.js';
import { SymbolGraph } from '../../symbol-graph.js';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { resolveDbPath } from '../utils.js';

function warnIfEmptySymbolGraph(db: Database.Database, projectHash: string): boolean {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number };
  if (count.cnt === 0) {
    cliError('⚠️  Symbol graph is empty. Run `npx nano-brain reindex` first.');
    return true;
  }
  return false;
}

export async function handleContext(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let name: string | undefined;
  let filePath: string | undefined;
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--file=')) {
      filePath = arg.substring(7);
    } else if (arg === '--json') {
      format = 'json';
    } else if (!arg.startsWith('-')) {
      name = arg;
    }
  }

  if (!name) {
    cliError('Usage: context <symbol-name> [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'context name=' + name + ' file=' + (filePath || ''));
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleContext({ name, filePath, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      cliOutput(`Multiple symbols named "${name}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        cliOutput(`  ${s.kind} ${s.name} — ${s.filePath}:${s.startLine}`);
      }
    } else {
      cliOutput(`Symbol "${name}" not found.`);
    }
    db.close();
    return;
  }

  const sym = result.symbol!;
  cliOutput(`${sym.kind} ${sym.name}`);
  cliOutput(`  File: ${sym.filePath}:${sym.startLine}-${sym.endLine}`);
  cliOutput(`  Exported: ${sym.exported ? 'yes' : 'no'}`);
  if (result.clusterLabel) {
    cliOutput(`  Cluster: ${result.clusterLabel}`);
  }
  cliOutput('');

  if (result.incoming && result.incoming.length > 0) {
    cliOutput(`Callers (${result.incoming.length}):`);
    for (const e of result.incoming) {
      cliOutput(`  ← ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    cliOutput('');
  }

  if (result.outgoing && result.outgoing.length > 0) {
    cliOutput(`Callees (${result.outgoing.length}):`);
    for (const e of result.outgoing) {
      cliOutput(`  → ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    cliOutput('');
  }

  if (result.flows && result.flows.length > 0) {
    cliOutput(`Flows (${result.flows.length}):`);
    for (const f of result.flows) {
      cliOutput(`  ${f.flowType}: ${f.label} (step ${f.stepIndex})`);
    }
    cliOutput('');
  }

  if (result.infrastructureSymbols && result.infrastructureSymbols.length > 0) {
    cliOutput(`Infrastructure:`);
    for (const s of result.infrastructureSymbols) {
      cliOutput(`  [${s.operation}] ${s.type}: ${s.pattern}`);
    }
  }

  db.close();
}
