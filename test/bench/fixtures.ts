import { createStore, computeHash } from '../../src/store.js';
import type { Store } from '../../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'algorithm', 'function', 'variable', 'component', 'interface', 'module', 'service',
  'database', 'query', 'index', 'cache', 'memory', 'storage', 'network', 'protocol',
  'authentication', 'authorization', 'encryption', 'security', 'performance',
  'optimization', 'refactoring', 'debugging', 'testing', 'deployment', 'monitoring',
  'logging', 'configuration', 'documentation', 'architecture', 'design', 'pattern',
  'implementation', 'integration', 'migration', 'validation', 'serialization',
  'asynchronous', 'synchronous', 'concurrent', 'parallel', 'distributed', 'scalable',
  'maintainable', 'extensible', 'reusable', 'modular', 'decoupled', 'cohesive',
  'typescript', 'javascript', 'nodejs', 'react', 'angular', 'vue', 'svelte',
  'express', 'fastify', 'nestjs', 'graphql', 'rest', 'websocket', 'grpc',
  'postgresql', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'rabbitmq',
  'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github', 'gitlab',
  'agile', 'scrum', 'kanban', 'devops', 'cicd', 'microservices', 'serverless',
  'machine', 'learning', 'artificial', 'intelligence', 'neural', 'network',
  'embedding', 'vector', 'search', 'semantic', 'similarity', 'ranking', 'scoring',
];

const TITLES = [
  'Getting Started Guide', 'API Reference', 'Configuration Options', 'Best Practices',
  'Troubleshooting Guide', 'Performance Tuning', 'Security Guidelines', 'Migration Guide',
  'Architecture Overview', 'Design Patterns', 'Testing Strategies', 'Deployment Guide',
  'Monitoring Setup', 'Logging Configuration', 'Error Handling', 'Data Modeling',
  'Query Optimization', 'Cache Strategies', 'Authentication Flow', 'Authorization Rules',
];

function generateMarkdownContent(rng: () => number, minLength: number, maxLength: number): string {
  const targetLength = Math.floor(rng() * (maxLength - minLength)) + minLength;
  const lines: string[] = [];
  let currentLength = 0;

  const title = TITLES[Math.floor(rng() * TITLES.length)];
  lines.push(`# ${title}`);
  lines.push('');
  currentLength += title.length + 4;

  while (currentLength < targetLength) {
    const sectionType = rng();

    if (sectionType < 0.2) {
      const heading = WORDS[Math.floor(rng() * WORDS.length)];
      lines.push(`## ${heading.charAt(0).toUpperCase() + heading.slice(1)}`);
      lines.push('');
      currentLength += heading.length + 5;
    } else if (sectionType < 0.4) {
      const numItems = Math.floor(rng() * 5) + 2;
      for (let i = 0; i < numItems && currentLength < targetLength; i++) {
        const item = Array.from({ length: Math.floor(rng() * 6) + 3 }, () =>
          WORDS[Math.floor(rng() * WORDS.length)]
        ).join(' ');
        lines.push(`- ${item}`);
        currentLength += item.length + 3;
      }
      lines.push('');
    } else if (sectionType < 0.6) {
      const codeLines = Math.floor(rng() * 8) + 3;
      lines.push('```typescript');
      for (let i = 0; i < codeLines && currentLength < targetLength; i++) {
        const codeLine = `const ${WORDS[Math.floor(rng() * WORDS.length)]} = ${WORDS[Math.floor(rng() * WORDS.length)]}();`;
        lines.push(codeLine);
        currentLength += codeLine.length + 1;
      }
      lines.push('```');
      lines.push('');
    } else {
      const sentenceCount = Math.floor(rng() * 4) + 2;
      const paragraph: string[] = [];
      for (let i = 0; i < sentenceCount && currentLength < targetLength; i++) {
        const wordCount = Math.floor(rng() * 12) + 8;
        const sentence = Array.from({ length: wordCount }, () =>
          WORDS[Math.floor(rng() * WORDS.length)]
        ).join(' ');
        paragraph.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.');
        currentLength += sentence.length + 2;
      }
      lines.push(paragraph.join(' '));
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateEmbedding(rng: () => number, dimensions: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    embedding.push(rng() * 2 - 1);
  }
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / norm);
}

export const BENCH_QUERIES = [
  'algorithm optimization',
  'database query performance',
  'authentication security',
  'typescript interface',
  'microservices architecture',
  'cache invalidation',
  'vector embedding search',
  'deployment kubernetes',
  'testing strategies',
  'error handling patterns',
];

const EMBEDDING_SEED = 54321;
const embeddingRng = mulberry32(EMBEDDING_SEED);
export const BENCH_EMBEDDINGS: number[][] = Array.from({ length: 10 }, () =>
  generateEmbedding(embeddingRng, 1024)
);

export interface BenchStoreSetup {
  store: Store;
  dbPath: string;
  documentHashes: string[];
  cacheHashes: string[];
}

export async function createBenchStore(): Promise<BenchStoreSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-bench-'));
  const dbPath = path.join(tmpDir, 'bench.db');
  const store = createStore(dbPath);

  const rng = mulberry32(12345);
  const documentHashes: string[] = [];

  store.ensureVecTable(1024);

  for (let i = 0; i < 200; i++) {
    const content = generateMarkdownContent(rng, 500, 5000);
    const hash = computeHash(content);
    documentHashes.push(hash);

    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'bench',
      path: `docs/doc-${i.toString().padStart(3, '0')}.md`,
      title: `Document ${i}`,
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });

    const embedding = generateEmbedding(rng, 1024);
    store.insertEmbedding(hash, 0, 0, embedding, 'bench-model');
  }

  const cacheHashes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const cacheKey = computeHash(`cache-key-${i}`);
    cacheHashes.push(cacheKey);
    store.setCachedResult(cacheKey, JSON.stringify({ expanded: [`query-${i}-a`, `query-${i}-b`] }), 'bench', 'expand');
  }

  return { store, dbPath, documentHashes, cacheHashes };
}

export function cleanupBenchStore(store: Store, dbPath: string): void {
  try {
    store.close();
  } catch {
  }
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
