import type { EvalReport, DimensionMetrics, CalibrationBucket } from './types.js';

function formatMetrics(m: DimensionMetrics): string {
  const p = m.precision.toFixed(2);
  const r = m.recall.toFixed(2);
  const f = m.f1.toFixed(2);
  return `P=${p}  R=${r}  F1=${f}  (${m.truePositives}/${m.truePositives + m.falsePositives} TP, ${m.falsePositives} FP, ${m.falseNegatives} FN)`;
}

function formatAggregateMetrics(m: DimensionMetrics): string {
  const p = m.precision.toFixed(2);
  const r = m.recall.toFixed(2);
  const f = m.f1.toFixed(2);
  return `P=${p}  R=${r}  F1=${f}`;
}

function formatCalibrationBucket(b: CalibrationBucket): string {
  const rangeStr = `${b.range.min.toFixed(2)}-${b.range.max.toFixed(2)}`;
  const expected = b.midpoint.toFixed(3);
  const actual = b.actualAccuracy.toFixed(2);
  const error = b.calibrationError.toFixed(3);
  return `${rangeStr}: expected=${expected}, actual=${actual}, error=${error} (N=${b.totalEdges})`;
}

export function formatHumanReadable(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('Code Intelligence Accuracy Report');
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');

  for (const fixture of report.fixtures) {
    lines.push(`Fixture: ${fixture.fixtureName}`);
    lines.push(`  Symbols:  ${formatMetrics(fixture.symbols)}`);
    lines.push(`  Edges:    ${formatMetrics(fixture.edges)}`);
    lines.push(`  Flows:    ${formatMetrics(fixture.flows)}`);
    lines.push('');
  }

  lines.push('Aggregate (micro-averaged)');
  lines.push(`  Symbols:  ${formatAggregateMetrics(report.aggregate.symbols)}`);
  lines.push(`  Edges:    ${formatAggregateMetrics(report.aggregate.edges)}`);
  lines.push(`  Flows:    ${formatAggregateMetrics(report.aggregate.flows)}`);
  lines.push('');

  if (report.calibration.buckets.length > 0) {
    lines.push('Confidence Calibration');
    for (const bucket of report.calibration.buckets) {
      lines.push(`  ${formatCalibrationBucket(bucket)}`);
    }
    lines.push(`  Mean calibration error: ${report.calibration.meanError.toFixed(3)}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}
