import * as path from 'path';
import * as os from 'os';
import { generateCorpus } from './generator.js';
import { runBenchmarkSuite } from './runner.js';
import { runCompare } from './compare.js';
import type { GlobalOptions } from '../cli/types.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const DEFAULT_FIXTURES_DIR = path.join(REPO_ROOT, 'benchmarks', 'fixtures');
const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, 'benchmarks', 'results');
const VALID_SCALES = [100, 1000, 5000, 10000, 100000];

function parseScales(raw: string): number[] {
  return raw.split(',').map(s => {
    const n = parseInt(s.trim(), 10);
    if (!VALID_SCALES.includes(n)) {
      console.error(`Invalid scale: ${n}. Valid: ${VALID_SCALES.join(', ')}`);
      process.exit(1);
    }
    return n;
  });
}

export async function handleBenchSuite(_globalOpts: GlobalOptions, args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'generate':
      return handleGenerate(subArgs);
    case 'run':
      return handleRun(subArgs);
    case 'compare':
      return handleCompare(subArgs);
    default:
      console.error(`Unknown bench subcommand: ${subcommand}`);
      console.error('Usage: nano-brain bench <generate|run|compare> [options]');
      process.exit(1);
  }
}

function handleGenerate(args: string[]): void {
  let scale = 100;
  let seed = 42;
  let outDir = DEFAULT_FIXTURES_DIR;
  let outExplicit = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--scale=')) {
      scale = parseInt(arg.substring(8), 10);
    } else if (arg === '--scale' && i + 1 < args.length) {
      scale = parseInt(args[++i], 10);
    } else if (arg.startsWith('--seed=')) {
      seed = parseInt(arg.substring(7), 10);
    } else if (arg === '--seed' && i + 1 < args.length) {
      seed = parseInt(args[++i], 10);
    } else if (arg.startsWith('--out=')) {
      outDir = arg.substring(6);
      outExplicit = true;
    } else if (arg === '--out' && i + 1 < args.length) {
      outDir = args[++i];
      outExplicit = true;
    }
  }

  if (!VALID_SCALES.includes(scale)) {
    console.error(`Invalid scale: ${scale}. Valid scales: ${VALID_SCALES.join(', ')}`);
    process.exit(1);
  }

  // When --out is explicitly set, treat it as the final output dir.
  // When using the default fixtures dir, append scale-N for organisation.
  const scaleDir = outExplicit ? outDir : path.join(outDir, `scale-${scale}`);
  generateCorpus({ scale, seed, outDir: scaleDir });
}

async function handleRun(args: string[]): Promise<void> {
  let scales = [100];
  let noCleanup = false;
  let seed = 42;
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let resultsDir = DEFAULT_RESULTS_DIR;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--scale=')) {
      scales = parseScales(arg.substring(8));
    } else if (arg === '--scale' && i + 1 < args.length) {
      scales = parseScales(args[++i]);
    } else if (arg === '--no-cleanup') {
      noCleanup = true;
    } else if (arg.startsWith('--seed=')) {
      seed = parseInt(arg.substring(7), 10);
    } else if (arg === '--seed' && i + 1 < args.length) {
      seed = parseInt(args[++i], 10);
    } else if (arg.startsWith('--fixtures=')) {
      fixturesDir = arg.substring(11);
    } else if (arg.startsWith('--results=')) {
      resultsDir = arg.substring(10);
    }
  }

  await runBenchmarkSuite({ scales, noCleanup, fixturesBaseDir: fixturesDir, resultsDir, seed });
}

function handleCompare(args: string[]): void {
  let resultPath = '';
  let baselinePath = '';
  let savePath: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--save=')) {
      savePath = arg.substring(7);
    } else if (arg === '--save' && i + 1 < args.length) {
      savePath = args[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (!resultPath) {
      resultPath = arg;
    } else if (!baselinePath) {
      baselinePath = arg;
    }
  }

  if (!resultPath || !baselinePath) {
    console.error('Usage: nano-brain bench compare <result.json> <baseline.json> [--save <path>] [--force]');
    process.exit(1);
  }

  const exitCode = runCompare({ resultPath, baselinePath, savePath, force });
  process.exit(exitCode);
}
