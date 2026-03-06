import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFixture, parseSymbolRef } from './loader.js';
import { calculateCalibration } from './calibration.js';
import type {
  FixtureEvalResult,
  EvalReport,
  DimensionMetrics,
  GroundTruthSymbol,
  GroundTruthEdge,
  GroundTruthFlow,
  CalibrationBucket,
} from './types.js';
import { parseSymbols, resolveCallEdges, resolveHeritageEdges, waitForInit } from '../treesitter.js';
import type { SymbolTable } from '../treesitter.js';
import { SymbolGraph } from '../symbol-graph.js';
import { detectAndStoreFlows } from '../flow-detection.js';
import { detectLanguage } from '../graph.js';

const PROJECT_HASH = 'eval';
const LINE_TOLERANCE = 2;
const FLOW_STEP_MATCH_THRESHOLD = 0.8;

interface ActualSymbol {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

interface ActualEdge {
  sourceName: string;
  targetName: string;
  edgeType: string;
  confidence: number;
}

interface ActualFlow {
  label: string;
  flowType: string;
  entrySymbolName: string;
  terminalSymbolName: string;
  steps: string[];
}

function createTempDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE code_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      project_hash TEXT NOT NULL DEFAULT 'global',
      cluster_id INTEGER
    );
    CREATE INDEX idx_code_symbols_file ON code_symbols(file_path, project_hash);
    CREATE INDEX idx_code_symbols_name ON code_symbols(name, kind);
    CREATE INDEX idx_code_symbols_project ON code_symbols(project_hash);

    CREATE TABLE symbol_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      project_hash TEXT NOT NULL DEFAULT 'global',
      FOREIGN KEY (source_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES code_symbols(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_symbol_edges_source ON symbol_edges(source_id);
    CREATE INDEX idx_symbol_edges_target ON symbol_edges(target_id);
    CREATE INDEX idx_symbol_edges_type ON symbol_edges(edge_type);

    CREATE TABLE execution_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      flow_type TEXT NOT NULL,
      entry_symbol_id INTEGER NOT NULL,
      terminal_symbol_id INTEGER NOT NULL,
      step_count INTEGER NOT NULL,
      project_hash TEXT NOT NULL DEFAULT 'global',
      FOREIGN KEY (entry_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
      FOREIGN KEY (terminal_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_execution_flows_project ON execution_flows(project_hash);

    CREATE TABLE flow_steps (
      flow_id INTEGER NOT NULL,
      symbol_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      PRIMARY KEY (flow_id, step_index),
      FOREIGN KEY (flow_id) REFERENCES execution_flows(id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_flow_steps_symbol ON flow_steps(symbol_id);
  `);

  return db;
}

function computeContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function calculateMetrics(tp: number, fp: number, fn: number): DimensionMetrics {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return {
    precision,
    recall,
    f1,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
  };
}

export function compareSymbols(
  actual: ActualSymbol[],
  expected: GroundTruthSymbol[]
): DimensionMetrics {
  const matchedExpected = new Set<number>();
  let tp = 0;

  for (const act of actual) {
    let foundMatch = false;
    for (let i = 0; i < expected.length; i++) {
      if (matchedExpected.has(i)) continue;

      const exp = expected[i];
      if (
        act.name === exp.name &&
        act.kind === exp.kind &&
        act.filePath === exp.filePath &&
        Math.abs(act.startLine - exp.startLine) <= LINE_TOLERANCE
      ) {
        matchedExpected.add(i);
        tp++;
        foundMatch = true;
        break;
      }
    }
  }

  const fp = actual.length - tp;
  const fn = expected.length - tp;

  return calculateMetrics(tp, fp, fn);
}

export function compareEdges(
  actual: ActualEdge[],
  expected: GroundTruthEdge[]
): DimensionMetrics {
  const matchedExpected = new Set<number>();
  let tp = 0;

  for (const act of actual) {
    for (let i = 0; i < expected.length; i++) {
      if (matchedExpected.has(i)) continue;

      const exp = expected[i];
      const expSourceRef = parseSymbolRef(exp.source);
      const expTargetRef = parseSymbolRef(exp.target);

      if (
        act.sourceName === expSourceRef.name &&
        act.targetName === expTargetRef.name &&
        act.edgeType === exp.edgeType
      ) {
        matchedExpected.add(i);
        tp++;
        break;
      }
    }
  }

  const fp = actual.length - tp;
  const fn = expected.length - tp;

  return calculateMetrics(tp, fp, fn);
}

function calculateStepSequenceMatch(actualSteps: string[], expectedSteps: string[]): number {
  if (expectedSteps.length === 0) return actualSteps.length === 0 ? 1 : 0;

  let matchCount = 0;
  const actualSet = new Set(actualSteps);

  for (const step of expectedSteps) {
    const stepRef = parseSymbolRef(step);
    if (actualSet.has(stepRef.name)) {
      matchCount++;
    }
  }

  return matchCount / expectedSteps.length;
}

export function compareFlows(
  actual: ActualFlow[],
  expected: GroundTruthFlow[]
): DimensionMetrics {
  const matchedExpected = new Set<number>();
  let tp = 0;

  for (const act of actual) {
    for (let i = 0; i < expected.length; i++) {
      if (matchedExpected.has(i)) continue;

      const exp = expected[i];
      const expEntryRef = parseSymbolRef(exp.entrySymbol);
      const expTerminalRef = parseSymbolRef(exp.terminalSymbol);

      if (
        act.entrySymbolName === expEntryRef.name &&
        act.terminalSymbolName === expTerminalRef.name
      ) {
        const stepMatch = calculateStepSequenceMatch(act.steps, exp.expectedSteps);
        if (stepMatch >= FLOW_STEP_MATCH_THRESHOLD) {
          matchedExpected.add(i);
          tp++;
          break;
        }
      }
    }
  }

  const fp = actual.length - tp;
  const fn = expected.length - tp;

  return calculateMetrics(tp, fp, fn);
}

export async function evaluateFixture(fixturePath: string): Promise<FixtureEvalResult> {
  await waitForInit();

  const fixture = loadFixture(fixturePath);
  const fixtureName = fixturePath.split('/').pop() || fixturePath;

  const db = createTempDatabase();
  const graph = new SymbolGraph(db);

  const tempDir = mkdtempSync(join(tmpdir(), 'nano-brain-eval-'));

  try {
    for (const [relativePath, content] of fixture.srcFiles) {
      const fullPath = join(tempDir, relativePath);
      const dir = dirname(fullPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }

    const symbolTable: SymbolTable = new Map();
    const symbolIdMap = new Map<string, number>();

    for (const [relativePath, content] of fixture.srcFiles) {
      const language = detectLanguage(relativePath);
      if (!language) continue;

      const symbols = await parseSymbols(relativePath, content, language);

      for (const symbol of symbols) {
        const contentHash = computeContentHash(content);
        const symbolId = graph.insertSymbol({
          name: symbol.name,
          kind: symbol.kind,
          filePath: symbol.filePath,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          exported: symbol.exported,
          contentHash,
          projectHash: PROJECT_HASH,
        });

        const key = `${symbol.filePath}:${symbol.name}`;
        symbolIdMap.set(key, symbolId);

        if (!symbolTable.has(symbol.name)) {
          symbolTable.set(symbol.name, []);
        }
        symbolTable.get(symbol.name)!.push({
          filePath: symbol.filePath,
          kind: symbol.kind,
        });
      }
    }

    for (const [relativePath, content] of fixture.srcFiles) {
      const language = detectLanguage(relativePath);
      if (!language) continue;

      const callEdges = await resolveCallEdges(relativePath, content, language, symbolTable);
      const heritageEdges = await resolveHeritageEdges(relativePath, content, language, symbolTable);

      for (const edge of [...callEdges, ...heritageEdges]) {
        const sourceKey = `${edge.sourceFilePath}:${edge.sourceName}`;
        const targetFilePath = edge.targetFilePath || edge.sourceFilePath;
        const targetKey = `${targetFilePath}:${edge.targetName}`;

        const sourceId = symbolIdMap.get(sourceKey);
        const targetId = symbolIdMap.get(targetKey);

        if (sourceId !== undefined && targetId !== undefined) {
          graph.insertEdge({
            sourceId,
            targetId,
            edgeType: edge.edgeType,
            confidence: edge.confidence,
            projectHash: PROJECT_HASH,
          });
        }
      }
    }

    detectAndStoreFlows(db, PROJECT_HASH);

    const actualSymbols = db.prepare(`
      SELECT name, kind, file_path as filePath, start_line as startLine, 
             end_line as endLine, exported
      FROM code_symbols
      WHERE project_hash = ?
    `).all(PROJECT_HASH) as ActualSymbol[];

    const actualEdgesRaw = db.prepare(`
      SELECT 
        s.name as sourceName,
        t.name as targetName,
        e.edge_type as edgeType,
        e.confidence
      FROM symbol_edges e
      JOIN code_symbols s ON e.source_id = s.id
      JOIN code_symbols t ON e.target_id = t.id
      WHERE e.project_hash = ?
    `).all(PROJECT_HASH) as ActualEdge[];

    const actualFlowsRaw = db.prepare(`
      SELECT 
        ef.id,
        ef.label,
        ef.flow_type as flowType,
        entry.name as entrySymbolName,
        terminal.name as terminalSymbolName
      FROM execution_flows ef
      JOIN code_symbols entry ON ef.entry_symbol_id = entry.id
      JOIN code_symbols terminal ON ef.terminal_symbol_id = terminal.id
      WHERE ef.project_hash = ?
    `).all(PROJECT_HASH) as Array<{
      id: number;
      label: string;
      flowType: string;
      entrySymbolName: string;
      terminalSymbolName: string;
    }>;

    const actualFlows: ActualFlow[] = actualFlowsRaw.map(flow => {
      const stepsRaw = db.prepare(`
        SELECT cs.name
        FROM flow_steps fs
        JOIN code_symbols cs ON fs.symbol_id = cs.id
        WHERE fs.flow_id = ?
        ORDER BY fs.step_index
      `).all(flow.id) as Array<{ name: string }>;

      return {
        label: flow.label,
        flowType: flow.flowType,
        entrySymbolName: flow.entrySymbolName,
        terminalSymbolName: flow.terminalSymbolName,
        steps: stepsRaw.map(s => s.name),
      };
    });

    const symbolMetrics = compareSymbols(actualSymbols, fixture.groundTruth.symbols);
    const edgeMetrics = compareEdges(actualEdgesRaw, fixture.groundTruth.edges);
    const flowMetrics = compareFlows(actualFlows, fixture.groundTruth.flows);
    const calibration = calculateCalibration(actualEdgesRaw, fixture.groundTruth.edges);

    return {
      fixtureName,
      symbols: symbolMetrics,
      edges: edgeMetrics,
      flows: flowMetrics,
      calibration,
    };
  } finally {
    db.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function aggregateResults(results: FixtureEvalResult[]): EvalReport {
  let symbolTp = 0, symbolFp = 0, symbolFn = 0;
  let edgeTp = 0, edgeFp = 0, edgeFn = 0;
  let flowTp = 0, flowFp = 0, flowFn = 0;

  const allCalibrationBuckets: CalibrationBucket[] = [];

  for (const result of results) {
    symbolTp += result.symbols.truePositives;
    symbolFp += result.symbols.falsePositives;
    symbolFn += result.symbols.falseNegatives;

    edgeTp += result.edges.truePositives;
    edgeFp += result.edges.falsePositives;
    edgeFn += result.edges.falseNegatives;

    flowTp += result.flows.truePositives;
    flowFp += result.flows.falsePositives;
    flowFn += result.flows.falseNegatives;

    allCalibrationBuckets.push(...result.calibration);
  }

  const aggregatedCalibration = aggregateCalibrationBuckets(allCalibrationBuckets);
  const meanError = calculateMeanCalibrationError(aggregatedCalibration);

  return {
    fixtures: results,
    aggregate: {
      symbols: calculateMetrics(symbolTp, symbolFp, symbolFn),
      edges: calculateMetrics(edgeTp, edgeFp, edgeFn),
      flows: calculateMetrics(flowTp, flowFp, flowFn),
    },
    calibration: {
      buckets: aggregatedCalibration,
      meanError,
    },
    timestamp: new Date().toISOString(),
  };
}

function aggregateCalibrationBuckets(buckets: CalibrationBucket[]): CalibrationBucket[] {
  const bucketRanges = [
    { min: 0.8, max: 0.85 },
    { min: 0.85, max: 0.9 },
    { min: 0.9, max: 0.95 },
    { min: 0.95, max: 1.0 },
  ];

  return bucketRanges.map(range => {
    const matchingBuckets = buckets.filter(
      b => b.range.min === range.min && b.range.max === range.max
    );

    const totalEdges = matchingBuckets.reduce((sum, b) => sum + b.totalEdges, 0);
    const correctEdges = matchingBuckets.reduce((sum, b) => sum + b.correctEdges, 0);
    const midpoint = (range.min + range.max) / 2;
    const actualAccuracy = totalEdges > 0 ? correctEdges / totalEdges : 0;
    const calibrationError = Math.abs(midpoint - actualAccuracy);

    return {
      range,
      midpoint,
      totalEdges,
      correctEdges,
      actualAccuracy,
      calibrationError,
    };
  });
}

function calculateMeanCalibrationError(buckets: CalibrationBucket[]): number {
  const validBuckets = buckets.filter(b => b.totalEdges >= 3);
  if (validBuckets.length === 0) return 0;

  const totalError = validBuckets.reduce((sum, b) => sum + b.calibrationError, 0);
  return totalError / validBuckets.length;
}
