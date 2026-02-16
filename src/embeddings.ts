import { getLlama } from 'node-llama-cpp';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir, cpus } from 'os';
import type { EmbeddingResult } from './types.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
  dispose(): void;
}

export interface EmbeddingProviderOptions {
  modelPath?: string;
  cacheDir?: string;
}

const DEFAULT_MODEL_URI = 'hf:nicoboss/EmbeddingGemma-300M-GGUF/EmbeddingGemma-300M-Q8_0.gguf';
const MODEL_NAME = 'EmbeddingGemma-300M';
const DIMENSIONS = 384;

interface ParsedModelURI {
  org: string;
  repo: string;
  file: string;
}

function parseModelURI(uri: string): ParsedModelURI | null {
  const match = uri.match(/^hf:([^/]+)\/([^/]+)\/(.+\.gguf)$/);
  if (!match) return null;
  return {
    org: match[1],
    repo: match[2],
    file: match[3],
  };
}

async function downloadModel(url: string, destPath: string): Promise<void> {
  console.log(`Downloading model from ${url}...`);
  
  await fs.mkdir(dirname(destPath), { recursive: true });
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.statusText}`);
  }
  
  const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
  let downloadedSize = 0;
  
  const tempPath = `${destPath}.tmp`;
  const fileHandle = await fs.open(tempPath, 'w');
  
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      await fileHandle.write(value);
      downloadedSize += value.length;
      
      if (totalSize > 0) {
        const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
        process.stdout.write(`\rDownload progress: ${percent}%`);
      }
    }
    
    console.log('\nDownload complete');
  } finally {
    await fileHandle.close();
  }
  
  await fs.rename(tempPath, destPath);
}

export async function resolveModelPath(
  uri: string,
  cacheDir?: string
): Promise<string> {
  const parsed = parseModelURI(uri);
  if (!parsed) {
    throw new Error(`Invalid model URI format: ${uri}`);
  }
  
  const baseDir = cacheDir || join(homedir(), '.cache', 'opencode-memory', 'models');
  const modelPath = join(baseDir, parsed.org, parsed.repo, parsed.file);
  
  try {
    await fs.access(modelPath);
    return modelPath;
  } catch {
    const url = `https://huggingface.co/${parsed.org}/${parsed.repo}/resolve/main/${parsed.file}`;
    await downloadModel(url, modelPath);
    return modelPath;
  }
}

function formatQueryPrompt(query: string): string {
  return `task: search result | query: ${query}`;
}

function formatDocumentPrompt(title: string, content: string): string {
  return `title: ${title} | text: ${content}`;
}

class EmbeddingProviderImpl implements EmbeddingProvider {
  private contexts: any[] = [];
  private currentContextIndex = 0;
  
  constructor(
    private model: any,
    private parallelism: number
  ) {}
  
  async initialize(): Promise<void> {
    for (let i = 0; i < this.parallelism; i++) {
      const context = await this.model.createEmbeddingContext();
      this.contexts.push(context);
    }
  }
  
  async embed(text: string): Promise<EmbeddingResult> {
    const context = this.contexts[0];
    const result = await context.getEmbeddingFor(text);
    
    return {
      embedding: Array.from(result.vector),
      model: MODEL_NAME,
      dimensions: DIMENSIONS,
    };
  }
  
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    const batchSize = Math.min(4, this.parallelism);
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(async (text, idx) => {
        const contextIdx = idx % this.contexts.length;
        const context = this.contexts[contextIdx];
        const result = await context.getEmbeddingFor(text);
        
        return {
          embedding: Array.from(result.vector),
          model: MODEL_NAME,
          dimensions: DIMENSIONS,
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }
  
  getDimensions(): number {
    return DIMENSIONS;
  }
  
  getModel(): string {
    return MODEL_NAME;
  }
  
  dispose(): void {
    this.contexts = [];
  }
}

export async function createEmbeddingProvider(
  options?: EmbeddingProviderOptions
): Promise<EmbeddingProvider | null> {
  try {
    const modelUri = options?.modelPath || DEFAULT_MODEL_URI;
    const modelPath = await resolveModelPath(modelUri, options?.cacheDir);
    
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    
    const cpuCount = cpus().length;
    const parallelism = Math.max(1, Math.min(4, Math.floor(cpuCount / 4)));
    
    const provider = new EmbeddingProviderImpl(model, parallelism);
    await provider.initialize();
    
    return provider;
  } catch (error) {
    console.warn('Failed to load embedding model:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export { formatQueryPrompt, formatDocumentPrompt, parseModelURI };
