import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { TopicCluster, GeneratedDoc, GroundTruthQuery, CorpusMeta } from './types.js';

function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_CLUSTERS: TopicCluster[] = [
  {
    id: 'auth',
    label: 'JWT authentication middleware',
    keywords: ['JWT', 'token', 'bearer', 'OAuth', 'session', 'login', 'credentials', 'refresh token', 'auth middleware', 'password hash'],
    noiseKeywords: ['image resize', 'CSV export', 'color palette', 'PDF generation'],
  },
  {
    id: 'caching',
    label: 'Redis session caching',
    keywords: ['Redis', 'cache hit', 'TTL', 'cache miss', 'eviction', 'Memcached', 'LRU', 'cache invalidation', 'pub/sub', 'cache layer'],
    noiseKeywords: ['binary search', 'font rendering', 'timezone offset', 'audio codec'],
  },
  {
    id: 'payments',
    label: 'Stripe payment processing',
    keywords: ['Stripe', 'webhook', 'idempotency key', 'refund', 'charge', 'payment intent', 'PCI compliance', 'subscription', 'invoice', 'billing'],
    noiseKeywords: ['log rotation', 'dark mode', 'pagination cursor', 'queue priority'],
  },
  {
    id: 'deployment',
    label: 'Kubernetes deployment pipelines',
    keywords: ['Kubernetes', 'Docker', 'Helm chart', 'rolling update', 'CI/CD', 'canary release', 'blue-green', 'container registry', 'pod scaling', 'ingress'],
    noiseKeywords: ['regex pattern', 'fibonacci', 'color theory', 'mouse event'],
  },
  {
    id: 'debugging',
    label: 'Production debugging and tracing',
    keywords: ['stack trace', 'breakpoint', 'profiler', 'memory leak', 'core dump', 'heap snapshot', 'distributed trace', 'OpenTelemetry', 'log correlation', 'flamegraph'],
    noiseKeywords: ['gradient descent', 'user avatar', 'zip archive', 'SMS gateway'],
  },
  {
    id: 'api_design',
    label: 'REST and GraphQL API design',
    keywords: ['REST', 'GraphQL', 'versioning', 'rate limiting', 'pagination', 'HATEOAS', 'OpenAPI', 'schema validation', 'endpoint', 'response format'],
    noiseKeywords: ['pixel art', 'spreadsheet formula', 'hardware interrupt', 'color gradient'],
  },
  {
    id: 'database',
    label: 'PostgreSQL query optimization',
    keywords: ['index', 'query plan', 'N+1 problem', 'connection pool', 'transaction', 'deadlock', 'explain analyze', 'vacuum', 'partition', 'materialized view'],
    noiseKeywords: ['HTTP header', 'game physics', 'invoice template', 'drag and drop'],
  },
  {
    id: 'testing',
    label: 'Unit and integration testing strategies',
    keywords: ['unit test', 'integration test', 'mock', 'stub', 'fixture', 'test coverage', 'assertion', 'snapshot test', 'test runner', 'property-based testing'],
    noiseKeywords: ['grid layout', 'video encoding', 'microphone input', 'barcode scanner'],
  },
  {
    id: 'monitoring',
    label: 'Prometheus metrics and alerting',
    keywords: ['Prometheus', 'Grafana', 'metric', 'alert', 'histogram', 'gauge', 'SLO', 'error rate', 'latency p99', 'on-call'],
    noiseKeywords: ['emoji rendering', 'print stylesheet', 'GPS coordinate', 'Bluetooth pairing'],
  },
  {
    id: 'security',
    label: 'Application security and OWASP',
    keywords: ['SQL injection', 'XSS', 'CSRF token', 'OWASP', 'input sanitization', 'TLS', 'secret rotation', 'vulnerability scan', 'penetration test', 'dependency audit'],
    noiseKeywords: ['font loading', 'calendar widget', 'thumbnail generation', 'dark mode toggle'],
  },
  {
    id: 'frontend',
    label: 'React performance optimization',
    keywords: ['React', 'virtual DOM', 'memo', 'useCallback', 'code splitting', 'lazy loading', 'bundle size', 'hydration', 'server components', 'suspense'],
    noiseKeywords: ['batch processing', 'SSH tunnel', 'binary protocol', 'LDAP directory'],
  },
  {
    id: 'mobile',
    label: 'React Native and mobile development',
    keywords: ['React Native', 'Expo', 'native module', 'push notification', 'offline mode', 'AsyncStorage', 'bridge', 'Hermes engine', 'deep link', 'app store'],
    noiseKeywords: ['matrix multiplication', 'SQL join', 'log buffer', 'memory pool'],
  },
  {
    id: 'data_pipeline',
    label: 'ETL data pipeline architecture',
    keywords: ['ETL', 'data pipeline', 'Airflow', 'Kafka', 'Spark', 'batch job', 'data lake', 'schema registry', 'partitioning', 'backfill'],
    noiseKeywords: ['OAuth scopes', 'CSS animation', 'keyboard shortcut', 'tooltip position'],
  },
  {
    id: 'ml',
    label: 'Machine learning model serving',
    keywords: ['model serving', 'inference', 'feature store', 'A/B test', 'shadow mode', 'ONNX', 'model drift', 'training pipeline', 'embedding vector', 'GPU batch'],
    noiseKeywords: ['HTML table', 'file upload form', 'locale string', 'skeleton screen'],
  },
  {
    id: 'messaging',
    label: 'Message queue and event-driven architecture',
    keywords: ['message queue', 'dead letter queue', 'consumer group', 'at-least-once', 'idempotent consumer', 'event sourcing', 'CQRS', 'saga pattern', 'outbox pattern', 'RabbitMQ'],
    noiseKeywords: ['password strength', 'image cropping', 'column resize', 'date picker'],
  },
  {
    id: 'search',
    label: 'Elasticsearch full-text search indexing',
    keywords: ['Elasticsearch', 'index mapping', 'analyzer', 'tokenizer', 'BM25', 'fuzzy match', 'aggregation', 'relevance scoring', 'search as you type', 'synonym'],
    noiseKeywords: ['binary tree', 'network interface', 'GPU shader', 'SVG animation'],
  },
  {
    id: 'file_storage',
    label: 'S3 object storage and CDN',
    keywords: ['S3', 'presigned URL', 'CDN', 'CloudFront', 'multipart upload', 'object lifecycle', 'bucket policy', 'signed cookie', 'CORS header', 'object versioning'],
    noiseKeywords: ['unit conversion', 'form validation', 'context menu', 'map projection'],
  },
  {
    id: 'notifications',
    label: 'Push notifications and email delivery',
    keywords: ['push notification', 'FCM', 'APNs', 'email delivery', 'SMTP', 'bounce handling', 'unsubscribe', 'notification template', 'webhook delivery', 'retry backoff'],
    noiseKeywords: ['binary encoding', 'drag handle', 'chart tooltip', 'keyboard navigation'],
  },
  {
    id: 'analytics',
    label: 'Product analytics and event tracking',
    keywords: ['event tracking', 'funnel analysis', 'cohort', 'session replay', 'heatmap', 'A/B experiment', 'conversion rate', 'retention', 'DAU', 'analytics pipeline'],
    noiseKeywords: ['sprite sheet', 'HTTP/2 push', 'file locking', 'terminal emulator'],
  },
  {
    id: 'config_mgmt',
    label: 'Configuration management and feature flags',
    keywords: ['feature flag', 'LaunchDarkly', 'environment variable', 'secrets manager', 'config reload', 'blue-green config', 'rollout percentage', 'kill switch', 'remote config', 'override'],
    noiseKeywords: ['CSS grid', 'binary heap', 'audio visualization', 'handwriting recognition'],
  },
];

const SENTENCE_TEMPLATES = [
  'This document covers {topic} including {kw1} and {kw2}.',
  'When implementing {kw1}, consider how {kw2} interacts with your system.',
  'A common pattern for {topic} involves using {kw1} alongside {kw2}.',
  'The {kw1} approach helps teams manage {kw2} more effectively in production.',
  'Engineers often configure {kw1} to improve {kw2} reliability.',
  'Debugging {kw1} issues requires understanding the relationship with {kw2}.',
  'Best practices for {topic} recommend {kw1} as a foundational component.',
  'Teams adopting {kw1} frequently encounter {kw2} configuration challenges.',
];

function pickOne<T>(arr: T[], rand: () => number): T {
  return arr[Math.floor(rand() * arr.length)];
}

function renderTemplate(template: string, topic: string, kw1: string, kw2: string): string {
  return template
    .replace('{topic}', topic)
    .replace('{kw1}', kw1)
    .replace('{kw2}', kw2);
}

function generateDocBody(cluster: TopicCluster, docIndex: number, rand: () => number): string {
  const sentences: string[] = [];
  const sentenceCount = 4;

  for (let i = 0; i < Math.ceil(sentenceCount * 0.8); i++) {
    const tmpl = pickOne(SENTENCE_TEMPLATES, rand);
    const kw1 = pickOne(cluster.keywords, rand);
    const kw2 = pickOne(cluster.keywords.filter(k => k !== kw1), rand);
    sentences.push(renderTemplate(tmpl, cluster.label, kw1, kw2));
  }

  const noiseSentences = Math.ceil(sentenceCount * 0.2);
  for (let i = 0; i < noiseSentences; i++) {
    const noiseKw = pickOne(cluster.noiseKeywords, rand);
    sentences.push(`Additionally, note that ${noiseKw} may require separate consideration depending on your deployment context (doc-${docIndex}).`);
  }

  for (let i = sentences.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sentences[i], sentences[j]] = [sentences[j], sentences[i]];
  }

  return sentences.join(' ');
}

const QUERIES_PER_TOPIC: Record<string, string[]> = {
  auth: ['JWT authentication middleware token validation', 'OAuth session credentials bearer token'],
  caching: ['Redis cache TTL eviction strategy', 'cache invalidation LRU Memcached'],
  payments: ['Stripe payment webhook idempotency', 'billing subscription invoice refund'],
  deployment: ['Kubernetes rolling update Helm chart', 'Docker CI/CD canary blue-green deployment'],
  debugging: ['production debugging stack trace profiler', 'distributed tracing memory leak flamegraph'],
  api_design: ['REST API versioning rate limiting', 'GraphQL schema OpenAPI pagination'],
  database: ['PostgreSQL index query plan optimization', 'N+1 problem connection pool deadlock'],
  testing: ['unit test mock integration fixture', 'test coverage snapshot property-based testing'],
  monitoring: ['Prometheus metrics alerting histogram', 'Grafana SLO error rate latency p99'],
  security: ['SQL injection XSS CSRF OWASP', 'TLS secret rotation vulnerability penetration test'],
  frontend: ['React memo useCallback performance', 'code splitting lazy loading bundle hydration'],
  mobile: ['React Native push notification offline', 'Expo deep link AsyncStorage Hermes'],
  data_pipeline: ['ETL Airflow Kafka pipeline batch job', 'data lake schema registry partitioning backfill'],
  ml: ['model serving inference feature store', 'ONNX model drift training embedding GPU'],
  messaging: ['message queue dead letter consumer group', 'event sourcing CQRS outbox saga pattern'],
  search: ['Elasticsearch BM25 index analyzer tokenizer', 'fuzzy match aggregation relevance scoring'],
  file_storage: ['S3 presigned URL CDN multipart upload', 'bucket policy CORS object versioning lifecycle'],
  notifications: ['push notification FCM APNs email delivery', 'SMTP bounce unsubscribe webhook retry'],
  analytics: ['event tracking funnel cohort A/B experiment', 'session replay heatmap retention DAU'],
  config_mgmt: ['feature flag LaunchDarkly rollout percentage', 'secrets manager config reload kill switch'],
};

export function computeCorpusHash(seed: number): string {
  const topicDefs = TOPIC_CLUSTERS.map(t => `${t.id}:${t.label}:${t.keywords.join(',')}`).join('|');
  return crypto.createHash('sha256').update(`seed=${seed}|topics=${topicDefs}`).digest('hex');
}

export interface GenerateOptions {
  scale: number;
  seed: number;
  outDir: string;
}

export function generateCorpus(opts: GenerateOptions): void {
  const { scale, seed, outDir } = opts;
  const rand = mulberry32(seed);
  const topicCount = TOPIC_CLUSTERS.length;
  const docsPerTopic = Math.max(1, Math.floor(scale / topicCount));

  const docs: GeneratedDoc[] = [];
  const groundTruth: GroundTruthQuery[] = [];

  for (const cluster of TOPIC_CLUSTERS) {
    const clusterDocIds: string[] = [];

    for (let i = 0; i < docsPerTopic; i++) {
      const docId = `${cluster.id}-${String(i + 1).padStart(4, '0')}`;
      const kw1 = pickOne(cluster.keywords, rand);
      const title = `${cluster.label}: ${kw1} (${i + 1})`;
      const body = generateDocBody(cluster, i, rand);
      docs.push({ id: docId, topic: cluster.id, title, body });
      clusterDocIds.push(docId);
    }

    const queries = QUERIES_PER_TOPIC[cluster.id] ?? [cluster.label];
    for (const query of queries) {
      groundTruth.push({
        query,
        topic: cluster.id,
        relevant_doc_ids: [...clusterDocIds],
      });
    }
  }

  const corpusHash = computeCorpusHash(seed);
  const meta: CorpusMeta = {
    corpus_hash: corpusHash,
    seed,
    scale,
    topic_count: topicCount,
    docs_per_topic: docsPerTopic,
    generated_at: new Date().toISOString(),
  };

  const docsDir = path.join(outDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });

  for (const doc of docs) {
    const docPath = path.join(docsDir, `${doc.id}.md`);
    const content = `# ${doc.title}\n\n${doc.body}\n`;
    fs.writeFileSync(docPath, content, 'utf-8');
  }

  fs.writeFileSync(path.join(outDir, 'ground-truth.json'), JSON.stringify(groundTruth, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`Generated ${docs.length} docs across ${topicCount} topics → ${outDir}`);
  console.log(`corpus_hash: ${corpusHash}`);
}

export { TOPIC_CLUSTERS };
