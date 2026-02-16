import { getLlama } from 'node-llama-cpp';
import { resolveModelPath } from './embeddings.js';

export interface QueryExpander {
  expand(query: string): Promise<string[]>;
  dispose(): void;
}

export interface QueryExpanderOptions {
  modelPath?: string;
  cacheDir?: string;
}

const DEFAULT_MODEL_URI = 'hf:tobi/qmd-query-expansion-1.7B-GGUF/qmd-query-expansion-1.7B-Q8_0.gguf';
const MODEL_NAME = 'qmd-query-expansion-1.7B';

class QueryExpanderImpl implements QueryExpander {
  constructor(
    private model: any,
    private context: any
  ) {}
  
  async expand(query: string): Promise<string[]> {
    try {
      const prompt = `Generate 2 alternative search queries for: ${query}\n\n1.`;
      
      const result = await this.context.evaluate([prompt], {
        maxTokens: 200,
        temperature: 0.7,
      });
      
      const generated = result?.text || '';
      
      const lines = generated.split('\n').filter(line => line.trim());
      const variants: string[] = [];
      
      for (const line of lines) {
        const match = line.match(/^\d+\.\s*(.+)$/);
        if (match && match[1]) {
          variants.push(match[1].trim());
        }
      }
      
      if (variants.length >= 2) {
        return variants.slice(0, 2);
      }
      
      return [query];
    } catch (error) {
      console.warn('Query expansion failed:', error instanceof Error ? error.message : String(error));
      return [query];
    }
  }
  
  dispose(): void {
    this.context = null;
  }
}

export async function createQueryExpander(
  options?: QueryExpanderOptions
): Promise<QueryExpander | null> {
  try {
    const modelUri = options?.modelPath || DEFAULT_MODEL_URI;
    const modelPath = await resolveModelPath(modelUri, options?.cacheDir);
    
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    
    const context = await model.createContext({
      contextSize: 2048,
    });
    
    return new QueryExpanderImpl(model, context);
  } catch (error) {
    console.warn('Failed to load query expander model:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
