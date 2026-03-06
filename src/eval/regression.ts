import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EvalReport } from './types.js';

const NANO_BRAIN_HOME = path.join(os.homedir(), '.nano-brain');
const EVAL_BASELINES_DIR = path.join(NANO_BRAIN_HOME, 'eval-baselines');

export function saveBaseline(report: EvalReport): string {
  if (!fs.existsSync(EVAL_BASELINES_DIR)) {
    fs.mkdirSync(EVAL_BASELINES_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const filename = `${timestamp}.json`;
  const filepath = path.join(EVAL_BASELINES_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}

export function loadLatestBaseline(): EvalReport | null {
  if (!fs.existsSync(EVAL_BASELINES_DIR)) {
    return null;
  }

  const files = fs.readdirSync(EVAL_BASELINES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  const latestFile = path.join(EVAL_BASELINES_DIR, files[0]);
  const content = fs.readFileSync(latestFile, 'utf-8');
  return JSON.parse(content) as EvalReport;
}

export function formatComparison(current: EvalReport, baseline: EvalReport): string {
  const lines: string[] = [];
  lines.push('Accuracy Comparison');
  lines.push('═══════════════════════════════════════════════════');
  lines.push('  Dimension        Baseline    Current     Delta    Direction');
  lines.push('  ──────────────   ──────────  ──────────  ───────  ─────────');

  const dimensions: Array<{ name: string; key: 'symbols' | 'edges' | 'flows' }> = [
    { name: 'Symbols F1', key: 'symbols' },
    { name: 'Edges F1', key: 'edges' },
    { name: 'Flows F1', key: 'flows' },
  ];

  for (const dim of dimensions) {
    const baseF1 = baseline.aggregate[dim.key].f1;
    const currF1 = current.aggregate[dim.key].f1;
    const delta = currF1 - baseF1;

    let direction: string;
    if (delta < -0.01) {
      direction = '↓ regressed';
    } else if (delta > 0.01) {
      direction = '↑ improved';
    } else {
      direction = '≈ same';
    }

    const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;

    const nameCol = dim.name.padEnd(15);
    const baseCol = baseF1.toFixed(2).padStart(10);
    const currCol = currF1.toFixed(2).padStart(10);
    const deltaCol = deltaStr.padStart(7);

    lines.push(`  ${nameCol}  ${baseCol}  ${currCol}  ${deltaCol}  ${direction}`);
  }

  lines.push('');
  return lines.join('\n');
}

export function hasRegression(
  current: EvalReport,
  baseline: EvalReport,
  threshold: number = 0.05
): boolean {
  const dimensions: Array<'symbols' | 'edges' | 'flows'> = ['symbols', 'edges', 'flows'];

  for (const dim of dimensions) {
    const baseF1 = baseline.aggregate[dim].f1;
    const currF1 = current.aggregate[dim].f1;
    const delta = currF1 - baseF1;

    if (delta < -threshold) {
      return true;
    }
  }

  return false;
}
