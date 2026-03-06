import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FixtureMetadata, GroundTruth } from './types.js';

export interface LoadedFixture {
  metadata: FixtureMetadata;
  groundTruth: GroundTruth;
  srcFiles: Map<string, string>;
}

export interface SymbolRef {
  file: string;
  name: string;
}

export function parseSymbolRef(ref: string): SymbolRef {
  const colonIndex = ref.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid symbol reference format: "${ref}". Expected "file:name" format.`);
  }
  return {
    file: ref.slice(0, colonIndex),
    name: ref.slice(colonIndex + 1),
  };
}

function validateFixtureMetadata(data: unknown): FixtureMetadata {
  if (typeof data !== 'object' || data === null) {
    throw new Error('fixture.json must be an object');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.language !== 'string') {
    throw new Error('fixture.json must have a "language" string field');
  }
  if (typeof obj.description !== 'string') {
    throw new Error('fixture.json must have a "description" string field');
  }
  return {
    language: obj.language,
    description: obj.description,
  };
}

function validateGroundTruth(data: unknown): GroundTruth {
  if (typeof data !== 'object' || data === null) {
    throw new Error('ground-truth.json must be an object');
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.symbols)) {
    throw new Error('ground-truth.json must have a "symbols" array');
  }
  if (!Array.isArray(obj.edges)) {
    throw new Error('ground-truth.json must have an "edges" array');
  }
  if (!Array.isArray(obj.flows)) {
    throw new Error('ground-truth.json must have a "flows" array');
  }
  for (const symbol of obj.symbols) {
    if (typeof symbol !== 'object' || symbol === null) {
      throw new Error('Each symbol must be an object');
    }
    const s = symbol as Record<string, unknown>;
    if (typeof s.name !== 'string') throw new Error('Symbol must have "name" string');
    if (!['function', 'class', 'method', 'variable', 'interface', 'type'].includes(s.kind as string)) {
      throw new Error(`Symbol kind must be one of: function, class, method, variable, interface, type. Got: ${s.kind}`);
    }
    if (typeof s.filePath !== 'string') throw new Error('Symbol must have "filePath" string');
    if (typeof s.startLine !== 'number') throw new Error('Symbol must have "startLine" number');
    if (typeof s.exported !== 'boolean') throw new Error('Symbol must have "exported" boolean');
  }
  for (const edge of obj.edges) {
    if (typeof edge !== 'object' || edge === null) {
      throw new Error('Each edge must be an object');
    }
    const e = edge as Record<string, unknown>;
    if (typeof e.source !== 'string') throw new Error('Edge must have "source" string');
    if (typeof e.target !== 'string') throw new Error('Edge must have "target" string');
    if (!['CALLS', 'EXTENDS', 'IMPLEMENTS'].includes(e.edgeType as string)) {
      throw new Error(`Edge edgeType must be one of: CALLS, EXTENDS, IMPLEMENTS. Got: ${e.edgeType}`);
    }
    if (e.expectedConfidence !== undefined) {
      if (typeof e.expectedConfidence !== 'object' || e.expectedConfidence === null) {
        throw new Error('Edge expectedConfidence must be an object');
      }
      const conf = e.expectedConfidence as Record<string, unknown>;
      if (typeof conf.min !== 'number' || typeof conf.max !== 'number') {
        throw new Error('Edge expectedConfidence must have "min" and "max" numbers');
      }
    }
  }
  for (const flow of obj.flows) {
    if (typeof flow !== 'object' || flow === null) {
      throw new Error('Each flow must be an object');
    }
    const f = flow as Record<string, unknown>;
    if (typeof f.label !== 'string') throw new Error('Flow must have "label" string');
    if (!['intra_community', 'cross_community'].includes(f.flowType as string)) {
      throw new Error(`Flow flowType must be one of: intra_community, cross_community. Got: ${f.flowType}`);
    }
    if (typeof f.entrySymbol !== 'string') throw new Error('Flow must have "entrySymbol" string');
    if (typeof f.terminalSymbol !== 'string') throw new Error('Flow must have "terminalSymbol" string');
    if (!Array.isArray(f.expectedSteps)) throw new Error('Flow must have "expectedSteps" array');
    for (const step of f.expectedSteps) {
      if (typeof step !== 'string') throw new Error('Each expectedStep must be a string');
    }
  }
  return obj as unknown as GroundTruth;
}

function collectSrcFiles(srcDir: string, basePath: string = ''): Map<string, string> {
  const files = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(srcDir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(srcDir, entry);
    const relativePath = basePath ? `${basePath}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const subFiles = collectSrcFiles(fullPath, relativePath);
      for (const [path, content] of subFiles) {
        files.set(path, content);
      }
    } else if (stat.isFile()) {
      files.set(relativePath, readFileSync(fullPath, 'utf-8'));
    }
  }
  return files;
}

export function loadFixture(fixturePath: string): LoadedFixture {
  const fixtureJsonPath = join(fixturePath, 'fixture.json');
  const groundTruthPath = join(fixturePath, 'ground-truth.json');
  const srcDir = join(fixturePath, 'src');

  let fixtureJson: unknown;
  try {
    fixtureJson = JSON.parse(readFileSync(fixtureJsonPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to read fixture.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  let groundTruthJson: unknown;
  try {
    groundTruthJson = JSON.parse(readFileSync(groundTruthPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to read ground-truth.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const metadata = validateFixtureMetadata(fixtureJson);
  const groundTruth = validateGroundTruth(groundTruthJson);
  const srcFiles = collectSrcFiles(srcDir);

  return {
    metadata,
    groundTruth,
    srcFiles,
  };
}
