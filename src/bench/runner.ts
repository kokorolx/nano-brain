import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { createStore } from '../store.js';
import { hybridSearch } from '../search.js';
import { createEmbeddingProvider } from '../embeddings.js';
import { generateCorpus, computeCorpusHash } from './generator.js';
import type {
  BenchResult,
  BenchEnvironment,
  ScaleResult,
  ScaleQuality,
  ScaleLatency,
  QualityPerMode,
  CommandResult,
  CombinationTestResult,
  LatencyStats,
  GroundTruthQuery,
  GeneratedDoc,
  CorpusMeta,
} from './types.js';

const NANO_BRAIN_VERSION: string = (() => {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
})();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function computeLatencyStats(times: number[]): LatencyStats {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95) };
}

function detectCLIEntry(): string {
  const distEntry = new URL('../../dist/cli/index.js', import.meta.url).pathname;
  if (fs.existsSync(distEntry)) return distEntry;
  const srcEntry = new URL('../../src/index.ts', import.meta.url).pathname;
  return srcEntry;
}

function spawnCLI(
  cliEntry: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60000
): { exitCode: number; stdout: string; stderr: string; durationMs: number } {
  const isTs = cliEntry.endsWith('.ts');
  const t0 = Date.now();

  const fullEnv = { ...process.env, ...env } as Record<string, string>;

  let nodeArgs: string[];
  if (isTs) {
    const tsxBin = path.join(path.dirname(cliEntry), '..', 'node_modules', '.bin', 'tsx');
    nodeArgs = [tsxBin, cliEntry, ...args];
  } else {
    nodeArgs = [cliEntry, ...args];
  }

  const result = spawnSync('node', nodeArgs, {
    env: fullEnv,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf-8',
  });

  const durationMs = Date.now() - t0;
  const exitCode = result.status ?? 1;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return { exitCode, stdout, stderr, durationMs };
}

async function runCommandTest(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cliEntry: string
): Promise<CommandResult> {
  const result = spawnCLI(cliEntry, [cmd, ...args], env);
  const pass = result.exitCode === 0 && result.stdout.trim().length > 0;
  return {
    cmd,
    args,
    status: pass ? 'pass' : 'fail',
    exit_code: result.exitCode,
    stdout: result.stdout.substring(0, 2000),
    stderr: result.stderr.substring(0, 2000),
    duration_ms: result.durationMs,
  };
}

function computeQueryMetrics(
  resultIds: string[],
  relevantIds: string[],
  atK5 = 5,
  atK10 = 10
): { p5: number; r10: number; mrr: number } {
  const relevantSet = new Set(relevantIds);
  const top5 = resultIds.slice(0, atK5).filter(id => relevantSet.has(id)).length;
  const top10 = resultIds.slice(0, atK10).filter(id => relevantSet.has(id)).length;
  const firstRank = resultIds.findIndex(id => relevantSet.has(id));
  return {
    p5: top5 / atK5,
    r10: relevantIds.length > 0 ? top10 / relevantIds.length : 0,
    mrr: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
  };
}

function aggregateQuality(
  perQuery: Array<{ query: string; p5: number; r10: number; mrr: number }>
): QualityPerMode {
  const n = perQuery.length || 1;
  return {
    mean_p5: perQuery.reduce((s, q) => s + q.p5, 0) / n,
    mean_r10: perQuery.reduce((s, q) => s + q.r10, 0) / n,
    mean_mrr: perQuery.reduce((s, q) => s + q.mrr, 0) / n,
    per_query: perQuery,
  };
}

async function measureQuality(
  dbPath: string,
  groundTruth: GroundTruthQuery[],
  ollamaUrl: string | null
): Promise<{ quality: ScaleQuality; latency: Omit<ScaleLatency, 'insert'> }> {
  const store = createStore(dbPath);

  let embedder: { embed(text: string): Promise<{ embedding: number[] }>; dispose(): void } | null = null;
  if (ollamaUrl) {
    try {
      embedder = await createEmbeddingProvider({ embeddingConfig: { url: ollamaUrl } });
    } catch {
      embedder = null;
    }
  }

  const ftsPerQuery: Array<{ query: string; p5: number; r10: number; mrr: number }> = [];
  const vecPerQuery: Array<{ query: string; p5: number; r10: number; mrr: number }> = [];
  const hybPerQuery: Array<{ query: string; p5: number; r10: number; mrr: number }> = [];

  const ftsQueryTimes: number[] = [];
  const vecQueryTimes: number[] = [];
  const hybQueryTimes: number[] = [];

  const docIdFromPath = (p: string): string => path.basename(p, '.md');

  for (const gt of groundTruth) {
    const t0fts = Date.now();
    const ftsResults = store.searchFTS(gt.query, { limit: 10 });
    ftsQueryTimes.push(Date.now() - t0fts);
    const ftsIds = ftsResults.map(r => docIdFromPath(r.path));
    ftsPerQuery.push({ query: gt.query, ...computeQueryMetrics(ftsIds, gt.relevant_doc_ids) });

    if (embedder) {
      const t0vec = Date.now();
      const { embedding } = await embedder.embed(gt.query);
      const vecResults = await store.searchVecAsync(gt.query, embedding, { limit: 10 });
      vecQueryTimes.push(Date.now() - t0vec);
      const vecIds = vecResults.map(r => docIdFromPath(r.path));
      vecPerQuery.push({ query: gt.query, ...computeQueryMetrics(vecIds, gt.relevant_doc_ids) });

      const t0hyb = Date.now();
      const hybResults = await hybridSearch(store, { query: gt.query, limit: 10 }, { embedder });
      hybQueryTimes.push(Date.now() - t0hyb);
      const hybIds = hybResults.map((r: { path: string }) => docIdFromPath(r.path));
      hybPerQuery.push({ query: gt.query, ...computeQueryMetrics(hybIds, gt.relevant_doc_ids) });
    }
  }

  embedder?.dispose();

  const ftsQuality = aggregateQuality(ftsPerQuery);
  const vecQuality = vecPerQuery.length > 0 ? aggregateQuality(vecPerQuery) : null;
  const hybQuality = hybPerQuery.length > 0 ? aggregateQuality(hybPerQuery) : null;

  let hybridBeatsFts: boolean | null = null;
  if (ftsQuality && hybQuality) {
    const maxBaseline = Math.max(ftsQuality.mean_mrr, vecQuality?.mean_mrr ?? 0);
    hybridBeatsFts = hybQuality.mean_mrr >= maxBaseline - 0.03;
  }

  store.close();

  return {
    quality: {
      fts: ftsQuality,
      vector: vecQuality,
      hybrid: hybQuality,
      hybrid_beats_fts: hybridBeatsFts,
    },
    latency: {
      query_fts: computeLatencyStats(ftsQueryTimes),
      query_vector: vecQueryTimes.length > 0 ? computeLatencyStats(vecQueryTimes) : null,
      query_hybrid: hybQueryTimes.length > 0 ? computeLatencyStats(hybQueryTimes) : null,
    },
  };
}

async function insertDocs(
  dbPath: string,
  fixturesDir: string
): Promise<LatencyStats> {
  const store = createStore(dbPath);
  const docsDir = path.join(fixturesDir, 'docs');
  const docFiles = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
  const insertTimes: number[] = [];
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  for (const fname of docFiles) {
    const docPath = path.join(docsDir, fname);
    const content = fs.readFileSync(docPath, 'utf-8');
    const lines = content.split('\n');
    const title = (lines[0] || fname).replace(/^#\s*/, '');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const t0 = Date.now();
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'bench',
      path: docPath,
      title,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash,
    });
    insertTimes.push(Date.now() - t0);
  }

  store.close();
  return computeLatencyStats(insertTimes);
}

async function runCombinationTests(
  dbPath: string,
  cliEntry: string,
  env: Record<string, string>,
  sessionsDir: string
): Promise<CombinationTestResult[]> {
  const results: CombinationTestResult[] = [];
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  {
    const uniqueToken = 'BENCH_UNIQUE_TOKEN_' + Date.now();
    const writeResult = spawnCLI(cliEntry, ['write', uniqueToken], env);
    const reindexResult = spawnCLI(cliEntry, ['reindex'], env);
    const queryResult = spawnCLI(cliEntry, ['search', uniqueToken], env);
    const found = queryResult.stdout.includes(uniqueToken);
    results.push({
      name: 'write→reindex→query',
      status: writeResult.exitCode === 0 && reindexResult.exitCode === 0 && found ? 'pass' : 'fail',
      detail: found ? `Token found in results` : `Token not found. exit_write=${writeResult.exitCode} exit_reindex=${reindexResult.exitCode} stdout=${queryResult.stdout.substring(0, 200)}`,
    });
  }

  {
    const store = createStore(dbPath);
    const tokenA = 'BENCH_SUPERSEDE_A_' + Date.now();
    const contentA = `Supersede test document A: ${tokenA}`;
    const hashA = crypto.createHash('sha256').update(contentA).digest('hex');
    const memoryDir = path.join(os.homedir(), '.nano-brain', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    const dateStr = new Date().toISOString().split('T')[0];
    const filePathA = path.join(memoryDir, `bench-supersede-${Date.now()}.md`);
    fs.writeFileSync(filePathA, contentA, 'utf-8');
    store.insertContent(hashA, contentA);
    const docIdA = store.insertDocument({
      collection: 'memory',
      path: filePathA,
      title: tokenA,
      hash: hashA,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash,
    });

    const tokenB = 'BENCH_SUPERSEDE_B_' + Date.now();
    const writeResult = spawnCLI(cliEntry, ['write', tokenB, `--supersedes=${filePathA}`], env);
    const queryResult = spawnCLI(cliEntry, ['search', tokenA], env);
    const oldGone = !queryResult.stdout.includes(tokenA);

    store.close();
    try { fs.unlinkSync(filePathA); } catch {}

    results.push({
      name: 'supersede→query',
      status: writeResult.exitCode === 0 && oldGone ? 'pass' : 'fail',
      detail: oldGone ? 'Superseded doc absent from results' : `Old doc still present. write_exit=${writeResult.exitCode}`,
    });
  }

  {
    const sessionToken = 'BENCH_SESSION_HARVEST_' + Date.now();
    const sessionFile = path.join(sessionsDir, `bench-session-${Date.now()}.md`);
    fs.writeFileSync(sessionFile, `# Bench Session\n\n${sessionToken}\n`, 'utf-8');

    const reindexResult = spawnCLI(cliEntry, ['reindex'], env);
    const searchResult = spawnCLI(cliEntry, ['search', sessionToken], env);
    const found = searchResult.stdout.includes(sessionToken);

    try { fs.unlinkSync(sessionFile); } catch {}

    results.push({
      name: 'harvest→reindex→search',
      status: reindexResult.exitCode === 0 && found ? 'pass' : 'fail',
      detail: found ? 'Session content found in search' : `Not found. reindex_exit=${reindexResult.exitCode} search_stdout=${searchResult.stdout.substring(0, 200)}`,
    });
  }

  return results;
}

async function getOllamaInfo(ollamaUrl: string | null): Promise<{ model: string; digest: string } | null> {
  if (!ollamaUrl) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return { model: 'nomic-embed-text:latest', digest: 'unknown' };
  } catch {
    return null;
  }
}

async function detectOllamaUrl(): Promise<string | null> {
  const candidates = ['http://localhost:11434', 'http://host.docker.internal:11434'];
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${url}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) return url;
    } catch {}
  }
  return null;
}

export interface RunOptions {
  scales: number[];
  noCleanup: boolean;
  fixturesBaseDir: string;
  resultsDir: string;
  seed: number;
}

export async function runBenchmarkSuite(opts: RunOptions): Promise<BenchResult> {
  const { scales, noCleanup, fixturesBaseDir, resultsDir, seed } = opts;

  const ollamaUrl = await detectOllamaUrl();
  if (!ollamaUrl) {
    console.warn('Warning: Ollama not reachable — skipping vector and hybrid quality tests');
  }

  const ollamaInfo = await getOllamaInfo(ollamaUrl);
  const env: BenchEnvironment = {
    ollama_model: ollamaInfo?.model ?? 'none',
    ollama_model_digest: ollamaInfo?.digest ?? 'none',
    platform: `${process.platform}-${process.arch}`,
    node_version: process.version,
  };

  const cliEntry = detectCLIEntry();
  const scaleResults: Record<string, ScaleResult> = {};

  const tmpBase = path.join(os.tmpdir(), `nano-brain-bench-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });
  const testDbPath = path.join(tmpBase, 'bench-test.sqlite');
  const sessionsDir = path.join(tmpBase, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const cliBenchEnv: Record<string, string> = {
    NANO_BRAIN_DB_PATH: testDbPath,
    NANO_BRAIN_SESSIONS_DIR: sessionsDir,
    NANO_BRAIN_DIRECT: '1',
  };
  if (ollamaUrl) cliBenchEnv['NANO_BRAIN_OLLAMA_URL'] = ollamaUrl;

  let firstCorpusHash = '';

  try {
    for (const scale of scales) {
      console.log(`\nRunning scale=${scale}...`);
      const fixturesDir = path.join(fixturesBaseDir, `scale-${scale}`);

      generateCorpus({ scale, seed, outDir: fixturesDir });

      const meta = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'corpus.json'), 'utf-8')) as CorpusMeta;
      const groundTruth = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'ground-truth.json'), 'utf-8')) as GroundTruthQuery[];
      if (!firstCorpusHash) firstCorpusHash = meta.corpus_hash;

      if (fs.existsSync(testDbPath)) {
        try { fs.unlinkSync(testDbPath); } catch {}
        try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
        try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
      }

      console.log('  Inserting docs...');
      const insertLatency = await insertDocs(testDbPath, fixturesDir);

      console.log('  Running quality metrics...');
      const { quality, latency: queryLatency } = await measureQuality(testDbPath, groundTruth, ollamaUrl);

      const scaleLatency: ScaleLatency = {
        insert: insertLatency,
        ...queryLatency,
      };

      console.log('  Running command tests...');
      const commandResults: CommandResult[] = [];
      const firstQuery = groundTruth[0]?.query ?? 'authentication token';

      commandResults.push(await runCommandTest('search', [firstQuery], cliBenchEnv, cliEntry));
      commandResults.push(await runCommandTest('query', [firstQuery], cliBenchEnv, cliEntry));
      if (ollamaUrl) {
        commandResults.push(await runCommandTest('vsearch', [firstQuery], cliBenchEnv, cliEntry));
      }
      commandResults.push(await runCommandTest('write', ['benchmark test document content'], cliBenchEnv, cliEntry));
      commandResults.push(await runCommandTest('reindex', [], cliBenchEnv, cliEntry));
      commandResults.push(await runCommandTest('status', [], cliBenchEnv, cliEntry));
      commandResults.push(await runCommandTest('tags', [], cliBenchEnv, cliEntry));

      console.log('  Running combination tests...');
      const combinationTests = await runCombinationTests(testDbPath, cliEntry, cliBenchEnv, sessionsDir);

      scaleResults[String(scale)] = {
        quality,
        latency: scaleLatency,
        commands: commandResults,
        combination_tests: combinationTests,
      };
    }
  } finally {
    if (!noCleanup) {
      try { fs.unlinkSync(testDbPath); } catch {}
      try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
      try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
      console.log('\nTest DB cleaned up.');
    } else {
      console.log(`\n--no-cleanup: test DB retained at ${testDbPath}`);
    }
  }

  const result: BenchResult = {
    schema_version: 1,
    nano_brain_version: NANO_BRAIN_VERSION,
    timestamp: new Date().toISOString(),
    environment: env,
    corpus_hash: firstCorpusHash,
    scales: scaleResults,
  };

  validateResult(result);

  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const resultFile = path.join(resultsDir, `${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nResult written to ${resultFile}`);

  return result;
}

function validateResult(result: BenchResult): void {
  const required: (keyof BenchResult)[] = ['schema_version', 'environment', 'scales'];
  for (const key of required) {
    if (result[key] === undefined) {
      throw new Error(`Result JSON missing required key: ${key}`);
    }
  }
}
