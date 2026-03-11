import { log } from './logger.js';
import type { SearchConfig, IntentConfig } from './types.js';
import { DEFAULT_INTENT_CONFIG } from './types.js';

export type IntentType = 'lookup' | 'explanation' | 'architecture' | 'recall' | 'unclassified';

export interface ClassificationResult {
  intent: IntentType;
  confidence: number;
  matchedKeyword?: string;
}

export class IntentClassifier {
  private config: IntentConfig;
  private keywordPatterns: Map<IntentType, RegExp[]>;

  constructor(config?: Partial<IntentConfig>) {
    this.config = { ...DEFAULT_INTENT_CONFIG, ...config } as IntentConfig;
    this.keywordPatterns = new Map();
    
    for (const [intent, def] of Object.entries(this.config.intents)) {
      const patterns = def.keywords.map(kw => new RegExp('\\b' + kw.replace(/\s+/g, '\\s+') + '\\b', 'i'));
      this.keywordPatterns.set(intent as IntentType, patterns);
    }
  }

  classify(query: string): ClassificationResult {
    const lowerQuery = query.toLowerCase();
    
    const entries = Array.from(this.keywordPatterns.entries());
    for (const [intent, patterns] of entries) {
      for (const pattern of patterns) {
        if (pattern.test(lowerQuery)) {
          log('intent', 'Classified as ' + intent + ' via keyword: ' + pattern.source, 'debug');
          return {
            intent,
            confidence: 0.9,
            matchedKeyword: pattern.source,
          };
        }
      }
    }
    
    return { intent: 'unclassified', confidence: 0.0 };
  }

  getConfigOverrides(intent: IntentType): Partial<SearchConfig> {
    if (intent === 'unclassified') return {};
    const intentDef = this.config.intents[intent];
    return intentDef?.config_overrides ?? {};
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}
