import { log } from './logger.js';

export interface BanditVariant {
  value: number;
  successes: number;
  failures: number;
}

export interface BanditConfig {
  parameterName: string;
  variants: BanditVariant[];
  minObservations: number;
  dampeningFactor: number;
  bounds: { min: number; max: number };
}

export interface BanditState {
  configs: BanditConfig[];
  version: number;
  updatedAt: string;
}

export class ThompsonSampler {
  private configs: BanditConfig[];
  private seed: number | null;
  private rng: () => number;

  constructor(configs: BanditConfig[], seed?: number) {
    this.configs = configs;
    this.seed = seed ?? null;
    this.rng = seed !== undefined ? this.seededRandom(seed) : Math.random.bind(Math);
  }

  selectVariant(parameterName: string): number {
    const config = this.configs.find(c => c.parameterName === parameterName);
    if (!config) throw new Error(`Unknown parameter: ${parameterName}`);
    
    const totalObs = config.variants.reduce((sum, v) => sum + v.successes + v.failures, 0);
    
    if (totalObs < config.minObservations * config.variants.length) {
      const idx = Math.floor(this.rng() * config.variants.length);
      return config.variants[idx].value;
    }
    
    let bestValue = -1;
    let bestVariant = config.variants[0].value;
    for (const variant of config.variants) {
      const sample = this.betaSample(variant.successes, variant.failures);
      if (sample > bestValue) {
        bestValue = sample;
        bestVariant = variant.value;
      }
    }
    return bestVariant;
  }

  recordReward(parameterName: string, variantValue: number, success: boolean): void {
    const config = this.configs.find(c => c.parameterName === parameterName);
    if (!config) return;
    const variant = config.variants.find(v => v.value === variantValue);
    if (!variant) return;
    if (success) variant.successes++;
    else variant.failures++;
  }

  getState(): BanditConfig[] {
    return this.configs;
  }

  selectSearchConfig(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const config of this.configs) {
      let value = this.selectVariant(config.parameterName);
      value = Math.max(config.bounds.min, Math.min(config.bounds.max, value));
      result[config.parameterName] = value;
    }
    return result;
  }

  private betaSample(alpha: number, beta: number): number {
    const x = this.gammaSample(alpha);
    const y = this.gammaSample(beta);
    return x / (x + y);
  }

  private gammaSample(shape: number): number {
    if (shape < 1) {
      return this.gammaSample(shape + 1) * Math.pow(this.rng(), 1 / shape);
    }
    const d = shape - 1/3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do {
        x = this.normalSample();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.rng();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private normalSample(): number {
    const u1 = this.rng();
    const u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  private seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
      return (s >>> 0) / 0xFFFFFFFF;
    };
  }
}

export const DEFAULT_BANDIT_CONFIGS: BanditConfig[] = [
  {
    parameterName: 'rrf_k',
    variants: [
      { value: 30, successes: 1, failures: 1 },
      { value: 60, successes: 1, failures: 1 },
      { value: 90, successes: 1, failures: 1 },
    ],
    minObservations: 100,
    dampeningFactor: 0.1,
    bounds: { min: 10, max: 120 },
  },
  {
    parameterName: 'centrality_weight',
    variants: [
      { value: 0.0, successes: 1, failures: 1 },
      { value: 0.05, successes: 1, failures: 1 },
      { value: 0.1, successes: 1, failures: 1 },
      { value: 0.2, successes: 1, failures: 1 },
    ],
    minObservations: 100,
    dampeningFactor: 0.1,
    bounds: { min: 0.0, max: 0.5 },
  },
];
