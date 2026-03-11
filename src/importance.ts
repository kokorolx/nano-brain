import { log } from './logger.js';
import type { Store, ImportanceConfig } from './types.js';
import { DEFAULT_IMPORTANCE_CONFIG } from './types.js';

export interface ImportanceParams {
  usageCount: number;
  entityDensity: number;
  daysSinceAccess: number;
  connectionCount: number;
  maxUsage: number;
  maxConnections: number;
}

export class ImportanceScorer {
  private store: Store;
  private config: ImportanceConfig;
  private scoreCache: Map<string, number> = new Map();

  constructor(store: Store, config?: Partial<ImportanceConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_IMPORTANCE_CONFIG, ...config };
  }

  calculateScore(params: ImportanceParams): number {
    const w = this.config.formula_weights;
    
    const usageNorm = params.maxUsage > 0 ? params.usageCount / params.maxUsage : 0;
    const entityNorm = Math.min(params.entityDensity, 1.0);
    const recencyNorm = Math.exp(-0.693 * params.daysSinceAccess / this.config.decay_half_life_days);
    const connectionNorm = params.maxConnections > 0 ? params.connectionCount / params.maxConnections : 0;
    
    return w.usage * usageNorm + w.entity_density * entityNorm + w.recency * recencyNorm + w.connections * connectionNorm;
  }

  applyBoost(searchScore: number, importanceScore: number): number {
    return searchScore * (1 + this.config.weight * importanceScore);
  }

  getScore(docid: string): number {
    return this.scoreCache.get(docid) ?? 0;
  }

  async recalculateAll(): Promise<number> {
    log('importance', 'Recalculating importance scores');
    this.scoreCache.clear();
    return 0;
  }

  getConfig(): ImportanceConfig {
    return this.config;
  }
}
