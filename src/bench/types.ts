export interface BenchEnvironment {
  ollama_model: string;
  ollama_model_digest: string;
  platform: string;
  node_version: string;
}

export interface QualityPerMode {
  mean_p5: number;
  mean_r10: number;
  mean_mrr: number;
  per_query: Array<{
    query: string;
    p5: number;
    r10: number;
    mrr: number;
  }>;
}

export interface ScaleQuality {
  fts: QualityPerMode;
  vector: QualityPerMode | null;
  hybrid: QualityPerMode | null;
  hybrid_beats_fts: boolean | null;
}

export interface LatencyStats {
  p50_ms: number;
  p95_ms: number;
}

export interface ScaleLatency {
  insert: LatencyStats;
  query_fts: LatencyStats;
  query_vector: LatencyStats | null;
  query_hybrid: LatencyStats | null;
}

export interface CommandResult {
  cmd: string;
  args: string[];
  status: 'pass' | 'fail';
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface CombinationTestResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface ScaleResult {
  quality: ScaleQuality;
  latency: ScaleLatency;
  commands: CommandResult[];
  combination_tests: CombinationTestResult[];
}

export interface BenchResult {
  schema_version: 1;
  nano_brain_version: string;
  timestamp: string;
  environment: BenchEnvironment;
  corpus_hash: string;
  scales: Record<string, ScaleResult>;
}

export interface TopicCluster {
  id: string;
  label: string;
  keywords: string[];
  noiseKeywords: string[];
}

export interface GeneratedDoc {
  id: string;
  topic: string;
  title: string;
  body: string;
}

export interface GroundTruthQuery {
  query: string;
  topic: string;
  relevant_doc_ids: string[];
}

export interface CorpusMeta {
  corpus_hash: string;
  seed: number;
  scale: number;
  topic_count: number;
  docs_per_topic: number;
  generated_at: string;
}
