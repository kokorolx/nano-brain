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

export async function handleDetectChanges(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let scope: 'unstaged' | 'staged' | 'all' = 'all';
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--scope=')) {
      const val = arg.substring(8);
      if (val === 'unstaged' || val === 'staged' || val === 'all') scope = val;
    } else if (arg === '--json') {
      format = 'json';
    }
  }

  log('cli', 'detect-changes scope=' + scope);
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleDetectChanges({ scope, workspaceRoot, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (result.changedFiles.length === 0) {
    cliOutput('No changed files detected.');
    db.close();
    return;
  }

  cliOutput(`Risk Level: ${result.riskLevel}`);
  cliOutput('');

  cliOutput(`Changed Files (${result.changedFiles.length}):`);
  for (const f of result.changedFiles) {
    cliOutput(`  ${f}`);
  }
  cliOutput('');

  if (result.changedSymbols.length > 0) {
    cliOutput(`Changed Symbols (${result.changedSymbols.length}):`);
    for (const s of result.changedSymbols) {
      cliOutput(`  ${s.kind} ${s.name} (${s.filePath})`);
    }
    cliOutput('');
  }

  if (result.affectedFlows.length > 0) {
    cliOutput(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      cliOutput(`  ${f.flowType}: ${f.label}`);
    }
  }

  db.close();
}
