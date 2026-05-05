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

export async function handleCodeImpact(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let target: string | undefined;
  let direction: 'upstream' | 'downstream' = 'upstream';
  let maxDepth = 5;
  let minConfidence = 0;
  let filePath: string | undefined;
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--direction=')) {
      const val = arg.substring(12);
      if (val === 'upstream' || val === 'downstream') direction = val;
    } else if (arg.startsWith('--max-depth=')) {
      maxDepth = parseInt(arg.substring(12), 10);
    } else if (arg.startsWith('--min-confidence=')) {
      minConfidence = parseFloat(arg.substring(17));
    } else if (arg.startsWith('--file=')) {
      filePath = arg.substring(7);
    } else if (arg === '--json') {
      format = 'json';
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  if (!target) {
    cliError('Usage: code-impact <symbol-name> [--direction=upstream|downstream] [--max-depth=N] [--min-confidence=N] [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'code-impact target=' + target + ' direction=' + direction + ' depth=' + maxDepth);
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleImpact({ target, direction, maxDepth, minConfidence, filePath, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      cliOutput(`Multiple symbols named "${target}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        cliOutput(`  ${s.kind} ${s.name} — ${s.filePath}`);
      }
    } else {
      cliOutput(`Symbol "${target}" not found.`);
    }
    db.close();
    return;
  }

  const t = result.target!;
  cliOutput(`Impact Analysis: ${t.kind} ${t.name} (${t.filePath})`);
  cliOutput(`  Direction: ${direction}`);
  cliOutput(`  Risk: ${result.risk}`);
  cliOutput(`  Direct deps: ${result.summary.directDeps}, Total affected: ${result.summary.totalAffected}, Flows: ${result.summary.flowsAffected}`);
  cliOutput('');

  for (const [depth, symbols] of Object.entries(result.byDepth)) {
    if (symbols.length > 0) {
      cliOutput(`Depth ${depth} (${symbols.length}):`);
      for (const s of symbols) {
        cliOutput(`  ${s.kind} ${s.name} (${s.filePath}) [${s.edgeType}, confidence=${s.confidence}]`);
      }
    }
  }

  if (result.affectedFlows.length > 0) {
    cliOutput('');
    cliOutput(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      cliOutput(`  ${f.flowType}: ${f.label}`);
    }
  }

  db.close();
}
