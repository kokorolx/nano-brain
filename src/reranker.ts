import { getLlama } from 'node-llama-cpp';
import { cpus } from 'os';
import { resolveModelPath } from './embeddings.js';
import type { RerankResult, RerankDocument } from './types.js';
import { log } from './logger.js';

export interface Reranker {
  rerank(query: string, documents: RerankDocument[]): Promise<RerankResult>;
  dispose(): void;
}

export interface RerankerOptions {
  modelPath?: string;
  cacheDir?: string;
}

const DEFAULT_MODEL_URI = 'hf:gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q4_K_M.gguf';
const MODEL_NAME = 'bge-reranker-v2-m3';
const CONTEXT_SIZE = 8192;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

class RerankerImpl implements Reranker {
  private contexts: any[] = [];
  
  constructor(
    private model: any,
    private parallelism: number
  ) {}
  
  async initialize(): Promise<void> {
    log('reranker', 'initializing with parallelism=' + this.parallelism);
    for (let i = 0; i < this.parallelism; i++) {
      const context = await this.model.createContext({
        contextSize: CONTEXT_SIZE,
      });
      this.contexts.push(context);
    }
  }
  
  async rerank(query: string, documents: RerankDocument[]): Promise<RerankResult> {
    log('reranker', 'rerank query="' + query.slice(0, 50) + '" docs=' + documents.length);
    const scoredDocs: Array<{ file: string; score: number; index: number }> = [];
    
    const batchSize = Math.min(4, this.parallelism);
    log('reranker', 'batch size=' + batchSize);
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchPromises = batch.map(async (doc, idx) => {
        const contextIdx = idx % this.contexts.length;
        const context = this.contexts[contextIdx];
        
        const prompt = `Query: ${query}\nDocument: ${doc.text}`;
        
        const result = await context.evaluate([prompt]);
        const rawScore = result?.logits?.[0] || 0;
        const normalizedScore = sigmoid(rawScore);
        
        return {
          file: doc.file,
          score: normalizedScore,
          index: doc.index,
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      scoredDocs.push(...batchResults);
    }
    
    scoredDocs.sort((a, b) => b.score - a.score);
    
    log('reranker', 'rerank complete results=' + scoredDocs.length);
    return {
      results: scoredDocs,
      model: MODEL_NAME,
    };
  }
  
  dispose(): void {
    this.contexts = [];
  }
}

export async function createReranker(
  options?: RerankerOptions
): Promise<Reranker | null> {
  try {
    log('reranker', 'loading reranker model');
    const modelUri = options?.modelPath || DEFAULT_MODEL_URI;
    const modelPath = await resolveModelPath(modelUri, options?.cacheDir);
    
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    
    const cpuCount = cpus().length;
    const parallelism = Math.max(1, Math.min(4, Math.floor(cpuCount / 4)));
    
    const reranker = new RerankerImpl(model, parallelism);
    await reranker.initialize();
    
    log('reranker', 'reranker model loaded successfully');
    return reranker;
  } catch (error) {
    log('reranker', 'failed to load reranker model: ' + (error instanceof Error ? error.message : String(error)));
    console.warn('Failed to load reranker model:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
