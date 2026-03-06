export interface GroundTruthSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
  filePath: string;
  startLine: number;
  exported: boolean;
}

export interface GroundTruthEdge {
  source: string;
  target: string;
  edgeType: 'CALLS' | 'EXTENDS' | 'IMPLEMENTS';
  expectedConfidence?: { min: number; max: number };
}

export interface GroundTruthFlow {
  label: string;
  flowType: 'intra_community' | 'cross_community';
  entrySymbol: string;
  terminalSymbol: string;
  expectedSteps: string[];
}

export interface GroundTruth {
  symbols: GroundTruthSymbol[];
  edges: GroundTruthEdge[];
  flows: GroundTruthFlow[];
}

export interface FixtureMetadata {
  language: string;
  description: string;
}

export interface DimensionMetrics {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface CalibrationBucket {
  range: { min: number; max: number };
  midpoint: number;
  totalEdges: number;
  correctEdges: number;
  actualAccuracy: number;
  calibrationError: number;
}

export interface FixtureEvalResult {
  fixtureName: string;
  symbols: DimensionMetrics;
  edges: DimensionMetrics;
  flows: DimensionMetrics;
  calibration: CalibrationBucket[];
}

export interface EvalReport {
  fixtures: FixtureEvalResult[];
  aggregate: {
    symbols: DimensionMetrics;
    edges: DimensionMetrics;
    flows: DimensionMetrics;
  };
  calibration: {
    buckets: CalibrationBucket[];
    meanError: number;
  };
  timestamp: string;
}
