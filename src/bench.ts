import { createStore, computeHash, indexDocument } from './store.js';
import { loadCollectionConfig } from './collections.js';
import { createEmbeddingProvider, checkOllamaHealth, detectOllamaUrl } from './embeddings.js';
import { hybridSearch } from './search.js';
import type { GlobalOptions } from './index.js';
import type { Store } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const NANO_BRAIN_HOME = path.join(os.homedir(), '.nano-brain');
const BENCHMARKS_DIR = path.join(NANO_BRAIN_HOME, 'benchmarks');

interface BenchResult {
  name: string;
  iterations: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  opsPerSec: number;
}

interface SuiteResults {
  [suiteName: string]: BenchResult[];
}

interface BenchOptions {
  suite?: string;
  iterations?: number;
  json: boolean;
  save: boolean;
  compare: boolean;
}

const DEFAULT_ITERATIONS: Record<string, number> = {
  search: 10,
  embed: 5,
  cache: 20,
  store: 20,
};

async function runBenchmark(
  name: string,
  fn: () => Promise<void> | void,
  iterations: number
): Promise<BenchResult> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const sum = times.reduce((a, b) => a + b, 0);
  const meanMs = sum / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  const opsPerSec = 1000 / meanMs;

  return {
    name,
    iterations,
    meanMs,
    minMs,
    maxMs,
    opsPerSec,
  };
}

async function runSearchSuite(
  store: Store,
  embedder: { embed(text: string): Promise<{ embedding: number[] }> } | null,
  iterations: number
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  results.push(
    await runBenchmark('FTS cold query', () => {
      store.searchFTS('function', 10);
    }, iterations)
  );

  results.push(
    await runBenchmark('FTS warm query', () => {
      store.searchFTS('function', 10);
    }, iterations)
  );

  results.push(
    await runBenchmark('FTS multi-term', () => {
      store.searchFTS('authentication middleware', 10);
    }, iterations)
  );

  if (embedder) {
    let cachedEmbedding: number[] | null = null;

    results.push(
      await runBenchmark('Vector search', async () => {
        if (!cachedEmbedding) {
          const result = await embedder.embed('error handling async');
          cachedEmbedding = result.embedding;
        }
        store.searchVec('error handling async', cachedEmbedding, 10);
      }, iterations)
    );

    results.push(
      await runBenchmark('Hybrid search', async () => {
        await hybridSearch(store, { query: 'error handling async', limit: 10 }, { embedder });
      }, iterations)
    );
  }

  return results;
}

async function runEmbedSuite(
  embedder: { embed(text: string): Promise<{ embedding: number[] }> },
  iterations: number
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  const sampleText = `This is a sample text chunk for benchmarking the embedding provider. 
It contains approximately 500 characters of content to simulate a typical document chunk 
that would be processed during indexing. The embedding model will convert this text into 
a dense vector representation that can be used for semantic similarity search. This helps 
measure the real-world performance of the embedding pipeline including any network latency 
if using a remote provider like Ollama.`;

  results.push(
    await runBenchmark('Single embed', async () => {
      await embedder.embed(sampleText);
    }, iterations)
  );

  const batchTexts = Array(10).fill(sampleText);
  results.push(
    await runBenchmark('Batch embed (10 sequential)', async () => {
      for (const text of batchTexts) {
        await embedder.embed(text);
      }
    }, iterations)
  );

  return results;
}

async function runCacheSuite(store: Store, iterations: number): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  const testHash = computeHash('bench-cache-test-key');
  const testValue = JSON.stringify({ test: 'value', data: Array(100).fill('x').join('') });
  store.setCachedResult(testHash, testValue, 'bench', 'bench');

  results.push(
    await runBenchmark('Cache hit', () => {
      store.getCachedResult(testHash, 'bench');
    }, iterations)
  );

  const missHash = computeHash('bench-cache-miss-key-nonexistent');
  results.push(
    await runBenchmark('Cache miss', () => {
      store.getCachedResult(missHash, 'bench');
    }, iterations)
  );

  let writeCounter = 0;
  results.push(
    await runBenchmark('Cache write', () => {
      const key = computeHash(`bench-cache-write-${writeCounter++}`);
      store.setCachedResult(key, testValue, 'bench', 'bench');
    }, iterations)
  );

  store.clearCache('bench');

  return results;
}

async function runStoreSuite(iterations: number, dbPath: string): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-${Date.now()}.sqlite`);
  const tempStore = await createStore(tempDbPath);

  let docCounter = 0;
  results.push(
    await runBenchmark('insertDocument', () => {
      const content = `# Test Document ${docCounter}\n\nThis is test content for benchmarking.`;
      const hash = computeHash(content);
      tempStore.insertContent(hash, content);
      tempStore.insertDocument({
        collection: 'bench',
        path: `/bench/doc-${docCounter++}.md`,
        title: `Test Document ${docCounter}`,
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'bench',
      });
    }, iterations)
  );

  tempStore.close();

  const userStore = await createStore(dbPath);

  results.push(
    await runBenchmark('getIndexHealth', () => {
      userStore.getIndexHealth();
    }, iterations)
  );

  results.push(
    await runBenchmark('getNextHashNeedingEmbedding', () => {
      userStore.getNextHashNeedingEmbedding();
    }, iterations)
  );

  userStore.close();

  try {
    fs.unlinkSync(tempDbPath);
    fs.unlinkSync(tempDbPath + '-wal');
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
  }

  return results;
}

function formatHumanReadable(suiteResults: SuiteResults): string {
  const lines: string[] = [];
  lines.push('nano-brain Benchmark Results');
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');

  for (const [suiteName, results] of Object.entries(suiteResults)) {
    if (results.length === 0) continue;

    const iterations = results[0].iterations;
    lines.push(`${suiteName.charAt(0).toUpperCase() + suiteName.slice(1)} Suite (${iterations} iterations)`);

    for (const r of results) {
      const nameCol = r.name.padEnd(30);
      const meanCol = `${r.meanMs.toFixed(2)}ms`.padStart(10);
      const rangeCol = `(min: ${r.minMs.toFixed(1)}, max: ${r.maxMs.toFixed(1)})`.padStart(28);
      const opsCol = `${r.opsPerSec.toFixed(1)} ops/sec`.padStart(14);
      lines.push(`  ${nameCol}${meanCol}  ${rangeCol}  ${opsCol}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function formatJson(suiteResults: SuiteResults): string {
  return JSON.stringify(suiteResults, null, 2);
}

function saveBaseline(suiteResults: SuiteResults): string {
  if (!fs.existsSync(BENCHMARKS_DIR)) {
    fs.mkdirSync(BENCHMARKS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const filename = `${timestamp}.json`;
  const filepath = path.join(BENCHMARKS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(suiteResults, null, 2));
  return filepath;
}

function loadLatestBaseline(): SuiteResults | null {
  if (!fs.existsSync(BENCHMARKS_DIR)) {
    return null;
  }

  const files = fs.readdirSync(BENCHMARKS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    return null;
  }

  const latestFile = path.join(BENCHMARKS_DIR, files[0]);
  const content = fs.readFileSync(latestFile, 'utf-8');
  return JSON.parse(content) as SuiteResults;
}

function formatComparison(current: SuiteResults, baseline: SuiteResults): string {
  const lines: string[] = [];
  lines.push('nano-brain Benchmark Comparison');
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');
  lines.push('  Name                          Baseline    Current     Delta    Direction');
  lines.push('  ────────────────────────────  ──────────  ──────────  ───────  ─────────');

  for (const [suiteName, currentResults] of Object.entries(current)) {
    const baselineResults = baseline[suiteName];
    if (!baselineResults) continue;

    for (const cr of currentResults) {
      const br = baselineResults.find(b => b.name === cr.name);
      if (!br) continue;

      const delta = ((cr.meanMs - br.meanMs) / br.meanMs) * 100;
      const direction = delta > 5 ? '↑ slower' : delta < -5 ? '↓ faster' : '≈ same';
      const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;

      const nameCol = cr.name.padEnd(30);
      const baseCol = `${br.meanMs.toFixed(2)}ms`.padStart(10);
      const currCol = `${cr.meanMs.toFixed(2)}ms`.padStart(10);
      const deltaCol = deltaStr.padStart(7);

      lines.push(`  ${nameCol}  ${baseCol}  ${currCol}  ${deltaCol}  ${direction}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function parseOptions(commandArgs: string[]): BenchOptions {
  const options: BenchOptions = {
    json: false,
    save: false,
    compare: false,
  };

  for (const arg of commandArgs) {
    if (arg.startsWith('--suite=')) {
      options.suite = arg.substring(8);
    } else if (arg.startsWith('--iterations=')) {
      options.iterations = parseInt(arg.substring(13), 10);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--save') {
      options.save = true;
    } else if (arg === '--compare') {
      options.compare = true;
    }
  }

  return options;
}

export async function handleBench(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const options = parseOptions(commandArgs);

  const store = await createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);

  const embeddingConfig = config?.embedding;
  const ollamaUrl = embeddingConfig?.url || detectOllamaUrl();

  let embedder: { embed(text: string): Promise<{ embedding: number[] }> } | null = null;
  let ollamaAvailable = false;

  const ollamaHealth = await checkOllamaHealth(ollamaUrl);
  if (ollamaHealth.reachable) {
    ollamaAvailable = true;
    const provider = await createEmbeddingProvider({ embeddingConfig });
    if (provider) {
      embedder = provider;
    }
  }

  if (!ollamaAvailable && (!options.suite || options.suite === 'embed' || options.suite === 'search')) {
    console.warn('⚠️  Ollama not reachable — skipping embed and vector search benchmarks');
  }

  const suiteResults: SuiteResults = {};

  const suitesToRun = options.suite
    ? [options.suite]
    : ['search', 'embed', 'cache', 'store'];

  for (const suite of suitesToRun) {
    const iterations = options.iterations || DEFAULT_ITERATIONS[suite] || 10;

    switch (suite) {
      case 'search':
        suiteResults.search = await runSearchSuite(store, embedder, iterations);
        break;

      case 'embed':
        if (embedder) {
          suiteResults.embed = await runEmbedSuite(embedder, iterations);
        } else {
          suiteResults.embed = [];
        }
        break;

      case 'cache':
        suiteResults.cache = await runCacheSuite(store, iterations);
        break;

      case 'store':
        suiteResults.store = await runStoreSuite(iterations, globalOpts.dbPath);
        break;

      default:
        console.error(`Unknown suite: ${suite}`);
    }
  }

  if (embedder && 'dispose' in embedder) {
    (embedder as { dispose(): void }).dispose();
  }
  store.close();

  if (options.compare) {
    const baseline = loadLatestBaseline();
    if (baseline) {
      console.log(formatComparison(suiteResults, baseline));
    } else {
      console.warn('⚠️  No baseline found — run with --save first');
    }
  }

  if (options.json) {
    console.log(formatJson(suiteResults));
  } else if (!options.compare) {
    console.log(formatHumanReadable(suiteResults));
  }

  if (options.save) {
    const savedPath = saveBaseline(suiteResults);
    console.log(`Baseline saved to ${savedPath}`);
  }
}
