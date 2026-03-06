import { parseSymbolRef } from './loader.js';
import type { CalibrationBucket, GroundTruthEdge } from './types.js';

interface ActualEdge {
  sourceName: string;
  targetName: string;
  edgeType: string;
  confidence: number;
}

const CALIBRATION_BUCKETS: Array<{ min: number; max: number }> = [
  { min: 0.8, max: 0.85 },
  { min: 0.85, max: 0.9 },
  { min: 0.9, max: 0.95 },
  { min: 0.95, max: 1.0 },
];

function isEdgeCorrect(
  actual: ActualEdge,
  expectedEdges: GroundTruthEdge[]
): boolean {
  for (const exp of expectedEdges) {
    const expSourceRef = parseSymbolRef(exp.source);
    const expTargetRef = parseSymbolRef(exp.target);

    if (
      actual.sourceName === expSourceRef.name &&
      actual.targetName === expTargetRef.name &&
      actual.edgeType === exp.edgeType
    ) {
      return true;
    }
  }
  return false;
}

export function calculateCalibration(
  actualEdges: ActualEdge[],
  expectedEdges: GroundTruthEdge[]
): CalibrationBucket[] {
  const callsEdges = actualEdges.filter(e => e.edgeType === 'CALLS');

  return CALIBRATION_BUCKETS.map(range => {
    const edgesInBucket = callsEdges.filter(
      e => e.confidence >= range.min && e.confidence < range.max
    );

    const totalEdges = edgesInBucket.length;
    const correctEdges = edgesInBucket.filter(e => isEdgeCorrect(e, expectedEdges)).length;
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

export function meanCalibrationError(buckets: CalibrationBucket[]): number {
  const validBuckets = buckets.filter(b => b.totalEdges >= 3);
  if (validBuckets.length === 0) return 0;

  const totalError = validBuckets.reduce((sum, b) => sum + b.calibrationError, 0);
  return totalError / validBuckets.length;
}
