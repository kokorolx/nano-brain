import { createStore, computeHash, indexDocument } from './store.js';
import { loadCollectionConfig } from './collections.js';
import { createEmbeddingProvider, checkOllamaHealth, detectOllamaUrl } from './embeddings.js';
import { hybridSearch } from './search.js';
import { traverse, getRelatedDocuments } from './connection-graph.js';
import { ConsolidationAgent } from './consolidation.js';
import { handleBenchSuite } from './bench/index.js';
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
  connections: 10,
  quality: 1,
  scale: 1,
  consolidation: 10,
  memory: 1,
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
      store.searchFTS('function', { limit: 10 });
    }, iterations)
  );

  results.push(
    await runBenchmark('FTS warm query', () => {
      store.searchFTS('function', { limit: 10 });
    }, iterations)
  );

  results.push(
    await runBenchmark('FTS multi-term', () => {
      store.searchFTS('authentication middleware', { limit: 10 });
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
        store.searchVec('error handling async', cachedEmbedding, { limit: 10 });
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

async function runConnectionsSuite(iterations: number): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-conn-${Date.now()}.sqlite`);
  const store = await createStore(tempDbPath);

  for (let i = 0; i < 100; i++) {
    const content = `# Doc ${i}\n\nContent for document ${i} in connections benchmark.`;
    const hash = computeHash(content);
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'bench',
      path: `/bench/conn-doc-${i}.md`,
      title: `Connection Doc ${i}`,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash: 'bench',
    });
  }

  results.push(
    await runBenchmark('insertConnection (single)', () => {
      store.insertConnection({
      fromDocId: 1,
      toDocId: 2,
      relationshipType: 'related',
      description: null,
      strength: 0.8,
      createdBy: 'user',
      projectHash: 'bench',
    });
    }, iterations)
  );

  let batchCounter = 0;
  results.push(
    await runBenchmark('insertConnection (batch 100)', () => {
      for (let i = 0; i < 100; i++) {
        store.insertConnection({
          fromDocId: (batchCounter * 100 + i) % 100 + 1,
          toDocId: (batchCounter * 100 + i + 1) % 100 + 1,
          relationshipType: 'related',
          description: null,
          strength: 0.7,
          createdBy: 'user',
          projectHash: 'bench',
        });
      }
      batchCounter++;
    }, iterations)
  );

  const doc0Conns = store.getConnectionsForDocument(100);
  results.push(
    await runBenchmark('getConnections (0 conns)', () => {
      store.getConnectionsForDocument(100);
    }, iterations)
  );

  for (let i = 0; i < 10; i++) {
    store.insertConnection({
      fromDocId: 50,
      toDocId: 60 + i,
      relationshipType: 'supports',
      description: null,
      strength: 0.9,
      createdBy: 'user',
      projectHash: 'bench',
    });
  }
  results.push(
    await runBenchmark('getConnections (10 conns)', () => {
      store.getConnectionsForDocument(50);
    }, iterations)
  );

  for (let i = 0; i < 40; i++) {
    store.insertConnection({
      fromDocId: 30,
      toDocId: (i % 99) + 1,
      relationshipType: 'extends',
      description: null,
      strength: 0.85,
      createdBy: 'user',
      projectHash: 'bench',
    });
  }
  results.push(
    await runBenchmark('getConnections (50 conns)', () => {
      store.getConnectionsForDocument(30);
    }, iterations)
  );

  results.push(
    await runBenchmark('traverse depth=1', () => {
      traverse(store, 1, { maxDepth: 1 });
    }, iterations)
  );

  results.push(
    await runBenchmark('traverse depth=2', () => {
      traverse(store, 1, { maxDepth: 2 });
    }, iterations)
  );

  results.push(
    await runBenchmark('traverse depth=3', () => {
      traverse(store, 1, { maxDepth: 3 });
    }, iterations)
  );

  results.push(
    await runBenchmark('getConnectionCount', () => {
      store.getConnectionCount(1);
    }, iterations)
  );

  const connToDelete = store.insertConnection({
    fromDocId: 99,
    toDocId: 98,
    relationshipType: 'related',
    description: null,
    strength: 0.5,
    createdBy: 'user',
    projectHash: 'bench',
  });
  let deleteId = connToDelete;
  results.push(
    await runBenchmark('deleteConnection', () => {
      store.deleteConnection(deleteId);
      deleteId = store.insertConnection({
        fromDocId: 99,
        toDocId: 98,
        relationshipType: 'related',
        description: null,
        strength: 0.5,
        createdBy: 'user',
        projectHash: 'bench',
      });
    }, iterations)
  );

  store.close();
  try {
    fs.unlinkSync(tempDbPath);
    fs.unlinkSync(tempDbPath + '-wal');
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
  }

  return results;
}

async function runQualitySuite(
  store: Store,
  embedder: { embed(text: string): Promise<{ embedding: number[] }> } | null,
  iterations: number
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-quality-${Date.now()}.sqlite`);
  const tempStore = await createStore(tempDbPath);

  const topics = [
    { name: 'authentication', keywords: ['JWT', 'token', 'login', 'session', 'OAuth', 'password', 'auth middleware', 'bearer', 'refresh token', 'credentials'] },
    { name: 'database-optimization', keywords: ['index', 'query plan', 'slow query', 'N+1', 'connection pool', 'transaction', 'deadlock', 'vacuum', 'explain analyze', 'cache hit'] },
    { name: 'error-handling', keywords: ['try catch', 'exception', 'error boundary', 'stack trace', 'retry logic', 'circuit breaker', 'fallback', 'graceful degradation', 'error code', 'validation'] },
    { name: 'deployment', keywords: ['Docker', 'Kubernetes', 'CI/CD', 'rolling update', 'blue-green', 'canary', 'helm chart', 'container', 'orchestration', 'scaling'] },
    { name: 'testing', keywords: ['unit test', 'integration test', 'mock', 'stub', 'fixture', 'coverage', 'assertion', 'test runner', 'snapshot', 'e2e'] },
  ];

  const docIndices: Record<string, number[]> = {};
  let docId = 0;
  for (const topic of topics) {
    docIndices[topic.name] = [];
    for (let i = 0; i < 10; i++) {
      const content = `# ${topic.name} Document ${i}\n\n${topic.keywords.slice(0, 5 + i % 5).join(', ')}.\n\nThis document covers ${topic.name} concepts including ${topic.keywords[i % topic.keywords.length]}.`;
      const hash = computeHash(content + docId);
      tempStore.insertContent(hash, content);
      tempStore.insertDocument({
        collection: 'bench',
        path: `/bench/${topic.name}-${i}.md`,
        title: `${topic.name} ${i}`,
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'bench',
      });
      docIndices[topic.name].push(docId);
      docId++;
    }
  }

  const queries = [
    { query: 'JWT token authentication middleware', relevant: docIndices['authentication'] },
    { query: 'database query optimization index', relevant: docIndices['database-optimization'] },
    { query: 'error handling try catch exception', relevant: docIndices['error-handling'] },
    { query: 'Docker Kubernetes deployment', relevant: docIndices['deployment'] },
    { query: 'unit test mock coverage', relevant: docIndices['testing'] },
    { query: 'OAuth login session credentials', relevant: docIndices['authentication'] },
    { query: 'slow query N+1 connection pool', relevant: docIndices['database-optimization'] },
    { query: 'circuit breaker retry fallback', relevant: docIndices['error-handling'] },
    { query: 'CI/CD rolling update canary', relevant: docIndices['deployment'] },
    { query: 'integration test fixture assertion', relevant: docIndices['testing'] },
  ];

  let ftsPrecision = 0, ftsRecall = 0, ftsMrr = 0;
  for (const q of queries) {
    const ftsResults = tempStore.searchFTS(q.query, { limit: 10 });
    const topIds = ftsResults.map(r => Number(r.id));
    const relevantSet = new Set(q.relevant);

    const top5Relevant = topIds.slice(0, 5).filter((id: number) => relevantSet.has(id)).length;
    ftsPrecision += top5Relevant / 5;

    const top10Relevant = topIds.filter((id: number) => relevantSet.has(id)).length;
    ftsRecall += top10Relevant / q.relevant.length;

    const firstRelevantRank = topIds.findIndex((id: number) => relevantSet.has(id));
    ftsMrr += firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;
  }

  results.push({
    name: 'P@5 (FTS)',
    iterations: 1,
    meanMs: ftsPrecision / queries.length,
    minMs: 0,
    maxMs: 0,
    opsPerSec: 0,
  });

  results.push({
    name: 'Recall@10 (FTS)',
    iterations: 1,
    meanMs: ftsRecall / queries.length,
    minMs: 0,
    maxMs: 0,
    opsPerSec: 0,
  });

  results.push({
    name: 'MRR (FTS)',
    iterations: 1,
    meanMs: ftsMrr / queries.length,
    minMs: 0,
    maxMs: 0,
    opsPerSec: 0,
  });

  if (embedder) {
    let hybridPrecision = 0, hybridRecall = 0, hybridMrr = 0;
    for (const q of queries) {
      const hybridResults = await hybridSearch(tempStore, { query: q.query, limit: 10 }, { embedder });
      const topIds = hybridResults.map((r: any) => Number(r.id));
      const relevantSet = new Set(q.relevant);

      const top5Relevant = topIds.slice(0, 5).filter((id: number) => relevantSet.has(id)).length;
      hybridPrecision += top5Relevant / 5;

      const top10Relevant = topIds.filter((id: number) => relevantSet.has(id)).length;
      hybridRecall += top10Relevant / q.relevant.length;

      const firstRelevantRank = topIds.findIndex((id: number) => relevantSet.has(id));
      hybridMrr += firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;
    }

    results.push({
      name: 'P@5 (Hybrid)',
      iterations: 1,
      meanMs: hybridPrecision / queries.length,
      minMs: 0,
      maxMs: 0,
      opsPerSec: 0,
    });

    results.push({
      name: 'Recall@10 (Hybrid)',
      iterations: 1,
      meanMs: hybridRecall / queries.length,
      minMs: 0,
      maxMs: 0,
      opsPerSec: 0,
    });

    results.push({
      name: 'MRR (Hybrid)',
      iterations: 1,
      meanMs: hybridMrr / queries.length,
      minMs: 0,
      maxMs: 0,
      opsPerSec: 0,
    });
  }

  tempStore.close();
  try {
    fs.unlinkSync(tempDbPath);
    fs.unlinkSync(tempDbPath + '-wal');
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
  }

  return results;
}

async function runScaleSuite(iterations: number): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const scalePoints = [100, 500, 1000, 5000];

  for (const n of scalePoints) {
    const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-scale-${n}-${Date.now()}.sqlite`);
    const store = await createStore(tempDbPath);

    const insertStart = performance.now();
    for (let i = 0; i < n; i++) {
      const content = `# Scale Doc ${i}\n\nContent for scale testing at ${n} documents. Keywords: test benchmark performance scale.`;
      const hash = computeHash(content + i + n);
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'bench',
        path: `/bench/scale-${n}-${i}.md`,
        title: `Scale Doc ${i}`,
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'bench',
      });
    }
    const insertEnd = performance.now();
    const insertMs = insertEnd - insertStart;

    results.push({
      name: `insert @${n}`,
      iterations: 1,
      meanMs: insertMs,
      minMs: insertMs,
      maxMs: insertMs,
      opsPerSec: n / (insertMs / 1000),
    });

    const searchTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      store.searchFTS('benchmark performance', { limit: 10 });
      searchTimes.push(performance.now() - start);
    }
    const avgSearchMs = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;

    results.push({
      name: `FTS search @${n}`,
      iterations: 5,
      meanMs: avgSearchMs,
      minMs: Math.min(...searchTimes),
      maxMs: Math.max(...searchTimes),
      opsPerSec: 1000 / avgSearchMs,
    });

    const healthTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      store.getIndexHealth();
      healthTimes.push(performance.now() - start);
    }
    const avgHealthMs = healthTimes.reduce((a, b) => a + b, 0) / healthTimes.length;

    results.push({
      name: `indexHealth @${n}`,
      iterations: 5,
      meanMs: avgHealthMs,
      minMs: Math.min(...healthTimes),
      maxMs: Math.max(...healthTimes),
      opsPerSec: 1000 / avgHealthMs,
    });

    const rss = process.memoryUsage().rss / (1024 * 1024);
    results.push({
      name: `RSS @${n}`,
      iterations: 1,
      meanMs: rss,
      minMs: rss,
      maxMs: rss,
      opsPerSec: 0,
    });

    store.close();
    try {
      fs.unlinkSync(tempDbPath);
      fs.unlinkSync(tempDbPath + '-wal');
      fs.unlinkSync(tempDbPath + '-shm');
    } catch {
    }
  }

  return results;
}

async function runConsolidationSuite(iterations: number): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-consol-${Date.now()}.sqlite`);
  const store = await createStore(tempDbPath);

  for (let i = 0; i < 50; i++) {
    const content = `# Memory ${i}\n\nThis is a memory document for consolidation benchmarking. Topic: ${i % 5 === 0 ? 'authentication' : i % 5 === 1 ? 'database' : i % 5 === 2 ? 'errors' : i % 5 === 3 ? 'deployment' : 'testing'}.`;
    const hash = computeHash(content + i);
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'memory',
      path: `/memory/consol-${i}.md`,
      title: `Memory ${i}`,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
      projectHash: 'bench',
    });
  }

  const mockLlmResponse = JSON.stringify([{
    sourceIds: [1, 2, 3],
    summary: 'test summary',
    insight: 'test insight',
    connections: [{ fromId: 1, toId: 2, relationship: 'supports', confidence: 0.9 }],
    overallConfidence: 0.85,
  }]);

  const mockLlmProvider = {
    complete: async (_prompt: string) => ({ text: mockLlmResponse, tokensUsed: 100 }),
    model: 'mock',
  };

  const agent = new ConsolidationAgent(store, { llmProvider: mockLlmProvider });

  const db = store.getDb();

  results.push(
    await runBenchmark('getUnconsolidatedMemories', () => {
      db.prepare(`
        SELECT d.id, d.title, d.path, d.hash, c.body 
        FROM documents d 
        JOIN content c ON d.hash = c.hash 
        WHERE d.collection = 'memory' 
          AND d.active = 1 
          AND d.superseded_by IS NULL 
        ORDER BY d.modified_at DESC 
        LIMIT 20
      `).all();
    }, iterations)
  );

  const sampleMemories = [
    { id: 1, title: 'Memory 1', path: '/memory/1.md', hash: 'h1', body: 'Sample body content for memory 1' },
    { id: 2, title: 'Memory 2', path: '/memory/2.md', hash: 'h2', body: 'Sample body content for memory 2' },
    { id: 3, title: 'Memory 3', path: '/memory/3.md', hash: 'h3', body: 'Sample body content for memory 3' },
  ];

  results.push(
    await runBenchmark('buildConsolidationPrompt', () => {
      const prompt = `You are a memory consolidation agent. Analyze the following memories and find connections between them.

For each group of related memories, output a JSON object with:
- sourceIds: array of memory IDs that are related
- summary: a concise summary of the related memories
- insight: a new insight derived from connecting these memories
- connections: array of {fromId, toId, relationship, confidence} objects
- overallConfidence: 0.0-1.0 rating of how confident you are in this consolidation

Output a JSON array of consolidation objects. Only include consolidations with confidence >= 0.7.

Memories:
${sampleMemories.map(m => `[ID: ${m.id}] ${m.title}\n${m.body.substring(0, 500)}`).join('\n\n---\n\n')}

Respond with ONLY a JSON array, no other text.`;
    }, iterations)
  );

  results.push(
    await runBenchmark('parseConsolidationResponse', () => {
      const text = mockLlmResponse;
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        JSON.parse(jsonMatch[0]);
      }
    }, iterations)
  );

  results.push(
    await runBenchmark('applyConsolidation', () => {
      const result = {
        sourceIds: [1, 2, 3],
        summary: 'test summary',
        insight: 'test insight',
        connections: [] as Array<{ fromId: number; toId: number; relationship: string; confidence: number }>,
        overallConfidence: 0.85,
      };
      db.prepare(`
        INSERT INTO consolidations (source_ids, summary, insight, connections, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        JSON.stringify(result.sourceIds),
        result.summary,
        result.insight,
        JSON.stringify(result.connections),
        result.overallConfidence,
        new Date().toISOString()
      );
    }, iterations)
  );

  store.close();
  try {
    fs.unlinkSync(tempDbPath);
    fs.unlinkSync(tempDbPath + '-wal');
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
  }

  return results;
}

async function runMemorySuite(iterations: number): Promise<BenchResult[]> {
  const results: BenchResult[] = [];

  const baselineRss = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'baseline RSS',
    iterations: 1,
    meanMs: baselineRss,
    minMs: baselineRss,
    maxMs: baselineRss,
    opsPerSec: 0,
  });

  const tempDbPath = path.join(os.tmpdir(), `nano-brain-bench-mem-${Date.now()}.sqlite`);
  const store = await createStore(tempDbPath);

  const insertDocs = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const content = `# Memory Doc ${i}\n\nContent for memory benchmarking document ${i}. This is filler text to simulate real document sizes.`;
      const hash = computeHash(content + Date.now() + i);
      store.insertContent(hash, content);
      store.insertDocument({
        collection: 'bench',
        path: `/bench/mem-${Date.now()}-${i}.md`,
        title: `Memory Doc ${i}`,
        hash,
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        active: true,
        projectHash: 'bench',
      });
    }
  };

  await insertDocs(100);
  const rss100 = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'RSS after 100 docs',
    iterations: 1,
    meanMs: rss100,
    minMs: rss100,
    maxMs: rss100,
    opsPerSec: 0,
  });

  await insertDocs(400);
  const rss500 = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'RSS after 500 docs',
    iterations: 1,
    meanMs: rss500,
    minMs: rss500,
    maxMs: rss500,
    opsPerSec: 0,
  });

  await insertDocs(500);
  const rss1000 = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'RSS after 1000 docs',
    iterations: 1,
    meanMs: rss1000,
    minMs: rss1000,
    maxMs: rss1000,
    opsPerSec: 0,
  });

  for (let i = 0; i < 100; i++) {
    store.insertConnection({
      fromDocId: (i % 100) + 1,
      toDocId: ((i + 1) % 100) + 1,
      relationshipType: 'related',
      description: null,
      strength: 0.8,
      createdBy: 'user',
      projectHash: 'bench',
    });
  }
  const rss100Conns = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'RSS after 100 conns',
    iterations: 1,
    meanMs: rss100Conns,
    minMs: rss100Conns,
    maxMs: rss100Conns,
    opsPerSec: 0,
  });

  for (let i = 0; i < 400; i++) {
    store.insertConnection({
      fromDocId: (i % 100) + 1,
      toDocId: ((i + 50) % 100) + 1,
      relationshipType: 'supports',
      description: null,
      strength: 0.7,
      createdBy: 'user',
      projectHash: 'bench',
    });
  }
  const rss500Conns = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'RSS after 500 conns',
    iterations: 1,
    meanMs: rss500Conns,
    minMs: rss500Conns,
    maxMs: rss500Conns,
    opsPerSec: 0,
  });

  const searchPromises = [];
  for (let i = 0; i < 10; i++) {
    searchPromises.push(Promise.resolve(store.searchFTS('memory benchmarking', { limit: 10 })));
  }
  await Promise.all(searchPromises);
  const peakRss = process.memoryUsage().rss / (1024 * 1024);
  results.push({
    name: 'peak RSS',
    iterations: 1,
    meanMs: peakRss,
    minMs: peakRss,
    maxMs: peakRss,
    opsPerSec: 0,
  });

  const heapGrowth = ((rss1000 - rss100) / 900) * 1024;
  results.push({
    name: 'heap growth rate (KB/doc)',
    iterations: 1,
    meanMs: heapGrowth,
    minMs: heapGrowth,
    maxMs: heapGrowth,
    opsPerSec: 0,
  });

  store.close();
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
  const suiteSubcommands = ['generate', 'run', 'compare'];
  if (commandArgs.length > 0 && suiteSubcommands.includes(commandArgs[0])) {
    return handleBenchSuite(globalOpts, commandArgs);
  }

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
    : ['search', 'embed', 'cache', 'store', 'connections', 'quality', 'scale', 'consolidation', 'memory'];

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

      case 'connections':
        suiteResults.connections = await runConnectionsSuite(iterations);
        break;

      case 'quality':
        suiteResults.quality = await runQualitySuite(store, embedder, iterations);
        break;

      case 'scale':
        suiteResults.scale = await runScaleSuite(iterations);
        break;

      case 'consolidation':
        suiteResults.consolidation = await runConsolidationSuite(iterations);
        break;

      case 'memory':
        suiteResults.memory = await runMemorySuite(iterations);
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
