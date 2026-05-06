import * as fs from 'fs';
import * as path from 'path';
import type { BenchResult, ScaleResult } from './types.js';

type MetricStatus = 'PASS' | 'WARN' | 'FAIL';

interface MetricRow {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  status: MetricStatus;
}

const THRESHOLDS = {
  p5:          { warn: 0.05, fail: 0.10 },
  r10:         { warn: 0.05, fail: 0.10 },
  mrr:         { warn: 0.03, fail: 0.05 },
  cmd_rate:    { warnBelow: 1.00, failBelow: 0.90 },
};

function metricStatus(drop: number, thresholds: { warn: number; fail: number }): MetricStatus {
  if (drop > thresholds.fail) return 'FAIL';
  if (drop > thresholds.warn) return 'WARN';
  return 'PASS';
}

function commandPassRate(result: BenchResult, scale: string): number {
  const sr = result.scales[scale];
  if (!sr || sr.commands.length === 0) return 1;
  const passed = sr.commands.filter(c => c.status === 'pass').length;
  return passed / sr.commands.length;
}

function collectMetricRows(current: BenchResult, baseline: BenchResult, scale: string): MetricRow[] {
  const rows: MetricRow[] = [];
  const cur = current.scales[scale];
  const bas = baseline.scales[scale];
  if (!cur || !bas) return rows;

  const metrics: Array<{ name: string; cur: number; bas: number; thr: { warn: number; fail: number } }> = [
    { name: `P@5 fts (scale=${scale})`, cur: cur.quality.fts.mean_p5, bas: bas.quality.fts.mean_p5, thr: THRESHOLDS.p5 },
    { name: `R@10 fts (scale=${scale})`, cur: cur.quality.fts.mean_r10, bas: bas.quality.fts.mean_r10, thr: THRESHOLDS.r10 },
    { name: `MRR fts (scale=${scale})`, cur: cur.quality.fts.mean_mrr, bas: bas.quality.fts.mean_mrr, thr: THRESHOLDS.mrr },
  ];

  if (cur.quality.hybrid !== null || bas.quality.hybrid !== null) {
    metrics.unshift(
      { name: `P@5 hybrid (scale=${scale})`, cur: cur.quality.hybrid?.mean_p5 ?? 0, bas: bas.quality.hybrid?.mean_p5 ?? 0, thr: THRESHOLDS.p5 },
      { name: `R@10 hybrid (scale=${scale})`, cur: cur.quality.hybrid?.mean_r10 ?? 0, bas: bas.quality.hybrid?.mean_r10 ?? 0, thr: THRESHOLDS.r10 },
      { name: `MRR hybrid (scale=${scale})`, cur: cur.quality.hybrid?.mean_mrr ?? 0, bas: bas.quality.hybrid?.mean_mrr ?? 0, thr: THRESHOLDS.mrr },
    );
  }

  for (const m of metrics) {
    const drop = m.bas - m.cur;
    rows.push({ metric: m.name, baseline: m.bas, current: m.cur, delta: -drop, status: metricStatus(drop, m.thr) });
  }

  const curRate = commandPassRate(current, scale);
  const basRate = commandPassRate(baseline, scale);
  let cmdStatus: MetricStatus = 'PASS';
  if (curRate < THRESHOLDS.cmd_rate.failBelow) cmdStatus = 'FAIL';
  else if (curRate < THRESHOLDS.cmd_rate.warnBelow) cmdStatus = 'WARN';
  rows.push({ metric: `Command pass rate (scale=${scale})`, baseline: basRate, current: curRate, delta: curRate - basRate, status: cmdStatus });

  const hybBeatsFts = cur.quality.hybrid_beats_fts;
  if (hybBeatsFts === false) {
    rows.push({ metric: `Hybrid≥FTS assertion (scale=${scale})`, baseline: 1, current: 0, delta: -1, status: 'WARN' });
  } else if (hybBeatsFts === true) {
    rows.push({ metric: `Hybrid≥FTS assertion (scale=${scale})`, baseline: 1, current: 1, delta: 0, status: 'PASS' });
  }

  return rows;
}

function printTable(rows: MetricRow[]): void {
  const colWidths = { metric: 45, baseline: 10, current: 10, delta: 10, status: 6 };
  const header = [
    'Metric'.padEnd(colWidths.metric),
    'Baseline'.padStart(colWidths.baseline),
    'Current'.padStart(colWidths.current),
    'Delta'.padStart(colWidths.delta),
    'Status'.padEnd(colWidths.status),
  ].join('  ');
  const sep = '-'.repeat(header.length);
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const row of rows) {
    const sign = row.delta >= 0 ? '+' : '';
    const line = [
      row.metric.substring(0, colWidths.metric).padEnd(colWidths.metric),
      row.baseline.toFixed(4).padStart(colWidths.baseline),
      row.current.toFixed(4).padStart(colWidths.current),
      `${sign}${row.delta.toFixed(4)}`.padStart(colWidths.delta),
      row.status.padEnd(colWidths.status),
    ].join('  ');
    console.log(line);
  }
  console.log(sep);
}

export interface CompareOptions {
  resultPath: string;
  baselinePath: string;
  savePath?: string;
  force: boolean;
}

export function runCompare(opts: CompareOptions): number {
  const { resultPath, baselinePath, savePath, force } = opts;

  if (!fs.existsSync(resultPath)) {
    console.error(`Result file not found: ${resultPath}`);
    return 1;
  }
  if (!fs.existsSync(baselinePath)) {
    console.error(`Baseline file not found: ${baselinePath}`);
    return 1;
  }

  let current: BenchResult;
  let baseline: BenchResult;
  try {
    current = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as BenchResult;
  } catch (err) {
    console.error(`Failed to parse ${resultPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BenchResult;
  } catch (err) {
    console.error(`Failed to parse ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (current.corpus_hash !== baseline.corpus_hash) {
    console.warn(`Warning: Corpus hash mismatch — results may not be comparable`);
    console.warn(`  baseline: ${baseline.corpus_hash}`);
    console.warn(`  current:  ${current.corpus_hash}`);
  }

  if (current.environment.ollama_model_digest !== baseline.environment.ollama_model_digest) {
    console.warn(`Warning: Embedding model digest changed — metric shifts may be expected`);
    console.warn(`  baseline: ${baseline.environment.ollama_model_digest}`);
    console.warn(`  current:  ${current.environment.ollama_model_digest}`);
  }

  const allScales = new Set([...Object.keys(current.scales), ...Object.keys(baseline.scales)]);
  const allRows: MetricRow[] = [];

  for (const scale of allScales) {
    const rows = collectMetricRows(current, baseline, scale);
    allRows.push(...rows);
  }

  console.log('\nnano-brain Benchmark Comparison');
  printTable(allRows);

  const hasFail = allRows.some(r => r.status === 'FAIL');
  const hasWarn = allRows.some(r => r.status === 'WARN');

  if (!hasFail && !hasWarn) {
    console.log('ALL PASS');
  } else if (hasFail) {
    console.log('REGRESSION DETECTED: one or more FAIL conditions');
  } else {
    console.log('WARNINGS: one or more WARN conditions');
  }

  if (savePath) {
    if (fs.existsSync(savePath) && !force) {
      console.error(`Error: ${savePath} already exists, use --force to overwrite`);
      return 3;
    }
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.copyFileSync(resultPath, savePath);
    console.log(`Saved result to ${savePath}`);
  }

  if (hasFail) return 1;
  if (hasWarn) return 2;
  return 0;
}
