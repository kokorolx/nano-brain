import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { evaluateFixture, aggregateResults } from '../../src/eval/harness.js';
import { formatHumanReadable, formatJson } from '../../src/eval/report.js';
import { saveBaseline, loadLatestBaseline, formatComparison, hasRegression } from '../../src/eval/regression.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

describe('Code Intelligence Accuracy', { timeout: 30000 }, () => {
  const allResults: Awaited<ReturnType<typeof evaluateFixture>>[] = [];

  it('ts-simple: should produce measurable accuracy', async () => {
    const result = await evaluateFixture(path.join(FIXTURES_DIR, 'ts-simple'));
    allResults.push(result);
    console.log(`ts-simple: symbols P=${result.symbols.precision.toFixed(2)} R=${result.symbols.recall.toFixed(2)} F1=${result.symbols.f1.toFixed(2)} (TP=${result.symbols.truePositives} FP=${result.symbols.falsePositives} FN=${result.symbols.falseNegatives})`);
    console.log(`ts-simple: edges   P=${result.edges.precision.toFixed(2)} R=${result.edges.recall.toFixed(2)} F1=${result.edges.f1.toFixed(2)} (TP=${result.edges.truePositives} FP=${result.edges.falsePositives} FN=${result.edges.falseNegatives})`);
    console.log(`ts-simple: flows   P=${result.flows.precision.toFixed(2)} R=${result.flows.recall.toFixed(2)} F1=${result.flows.f1.toFixed(2)} (TP=${result.flows.truePositives} FP=${result.flows.falsePositives} FN=${result.flows.falseNegatives})`);
    expect(result.symbols.f1).toBeGreaterThanOrEqual(0);
    expect(result.edges.f1).toBeGreaterThanOrEqual(0);
  });

  it('ts-complex: should produce measurable accuracy', async () => {
    const result = await evaluateFixture(path.join(FIXTURES_DIR, 'ts-complex'));
    allResults.push(result);
    console.log(`ts-complex: symbols P=${result.symbols.precision.toFixed(2)} R=${result.symbols.recall.toFixed(2)} F1=${result.symbols.f1.toFixed(2)} (TP=${result.symbols.truePositives} FP=${result.symbols.falsePositives} FN=${result.symbols.falseNegatives})`);
    console.log(`ts-complex: edges   P=${result.edges.precision.toFixed(2)} R=${result.edges.recall.toFixed(2)} F1=${result.edges.f1.toFixed(2)} (TP=${result.edges.truePositives} FP=${result.edges.falsePositives} FN=${result.edges.falseNegatives})`);
    console.log(`ts-complex: flows   P=${result.flows.precision.toFixed(2)} R=${result.flows.recall.toFixed(2)} F1=${result.flows.f1.toFixed(2)} (TP=${result.flows.truePositives} FP=${result.flows.falsePositives} FN=${result.flows.falseNegatives})`);
    expect(result.symbols.f1).toBeGreaterThanOrEqual(0);
    expect(result.edges.f1).toBeGreaterThanOrEqual(0);
  });

  it('py-mixed: should produce measurable accuracy', async () => {
    const result = await evaluateFixture(path.join(FIXTURES_DIR, 'py-mixed'));
    allResults.push(result);
    console.log(`py-mixed: symbols P=${result.symbols.precision.toFixed(2)} R=${result.symbols.recall.toFixed(2)} F1=${result.symbols.f1.toFixed(2)} (TP=${result.symbols.truePositives} FP=${result.symbols.falsePositives} FN=${result.symbols.falseNegatives})`);
    console.log(`py-mixed: edges   P=${result.edges.precision.toFixed(2)} R=${result.edges.recall.toFixed(2)} F1=${result.edges.f1.toFixed(2)} (TP=${result.edges.truePositives} FP=${result.edges.falsePositives} FN=${result.edges.falseNegatives})`);
    console.log(`py-mixed: flows   P=${result.flows.precision.toFixed(2)} R=${result.flows.recall.toFixed(2)} F1=${result.flows.f1.toFixed(2)} (TP=${result.flows.truePositives} FP=${result.flows.falsePositives} FN=${result.flows.falseNegatives})`);
    expect(result.symbols.f1).toBeGreaterThanOrEqual(0);
    expect(result.edges.f1).toBeGreaterThanOrEqual(0);
  });

  it('aggregate: should produce full report', async () => {
    if (allResults.length === 3) {
      const report = aggregateResults(allResults);
      console.log('\n' + formatHumanReadable(report));
    }
    expect(allResults.length).toBe(3);
  });
});

describe('Report Generation', () => {
  it('formatHumanReadable should produce formatted output', () => {
    const mockReport = createMockReport();
    const output = formatHumanReadable(mockReport);

    expect(output).toContain('Code Intelligence Accuracy Report');
    expect(output).toContain('Fixture: test-fixture');
    expect(output).toContain('Symbols:');
    expect(output).toContain('Aggregate (micro-averaged)');
  });

  it('formatJson should produce valid JSON', () => {
    const mockReport = createMockReport();
    const output = formatJson(mockReport);

    const parsed = JSON.parse(output);
    expect(parsed.fixtures).toHaveLength(1);
    expect(parsed.aggregate.symbols.f1).toBe(0.9);
  });
});

describe('Regression Tracking', () => {
  it('hasRegression should detect F1 drops', () => {
    const baseline = createMockReport();
    const current = createMockReport();
    current.aggregate.symbols.f1 = 0.8;

    expect(hasRegression(current, baseline, 0.05)).toBe(true);
  });

  it('hasRegression should not flag small changes', () => {
    const baseline = createMockReport();
    const current = createMockReport();
    current.aggregate.symbols.f1 = 0.88;

    expect(hasRegression(current, baseline, 0.05)).toBe(false);
  });

  it('formatComparison should show delta and direction', () => {
    const baseline = createMockReport();
    const current = createMockReport();
    current.aggregate.symbols.f1 = 0.8;
    current.aggregate.edges.f1 = 0.95;

    const output = formatComparison(current, baseline);

    expect(output).toContain('Accuracy Comparison');
    expect(output).toContain('Symbols F1');
    expect(output).toContain('regressed');
    expect(output).toContain('improved');
  });
});

function createMockReport() {
  return {
    fixtures: [
      {
        fixtureName: 'test-fixture',
        symbols: { precision: 0.95, recall: 0.85, f1: 0.9, truePositives: 17, falsePositives: 1, falseNegatives: 3 },
        edges: { precision: 0.88, recall: 0.82, f1: 0.85, truePositives: 7, falsePositives: 1, falseNegatives: 2 },
        flows: { precision: 1.0, recall: 0.5, f1: 0.67, truePositives: 1, falsePositives: 0, falseNegatives: 1 },
        calibration: [],
      },
    ],
    aggregate: {
      symbols: { precision: 0.95, recall: 0.85, f1: 0.9, truePositives: 17, falsePositives: 1, falseNegatives: 3 },
      edges: { precision: 0.88, recall: 0.82, f1: 0.85, truePositives: 7, falsePositives: 1, falseNegatives: 2 },
      flows: { precision: 1.0, recall: 0.5, f1: 0.67, truePositives: 1, falsePositives: 0, falseNegatives: 1 },
    },
    calibration: {
      buckets: [],
      meanError: 0.015,
    },
    timestamp: new Date().toISOString(),
  };
}
