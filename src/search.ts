import type { SearchResult, Store, StoreSearchOptions, SearchConfig } from './types.js';
import { DEFAULT_SEARCH_CONFIG } from './types.js';
import { computeHash } from './store.js';
import { log } from './logger.js';

export interface SearchOptions {
  query: string;
  limit?: number;
  collection?: string;
  useVec?: boolean;
  rerank?: boolean;
}

export interface HybridSearchOptions {
  query: string;
  limit?: number;
  collection?: string;
  minScore?: number;
  useExpansion?: boolean;
  useReranking?: boolean;
  topK?: number;
  projectHash?: string;
  scope?: 'workspace' | 'all';
  tags?: string[];
  since?: string;
  until?: string;
  searchConfig?: SearchConfig;
}

export interface SearchProviders {
  embedder?: { embed(text: string): Promise<{ embedding: number[] }> } | null;
  reranker?: { rerank(query: string, docs: any[]): Promise<{ results: Array<{ file: string; score: number; index: number }> }> } | null;
  expander?: { expand(query: string): Promise<string[]> } | null;
}

export function parseSearchConfig(partial?: Partial<SearchConfig>): SearchConfig {
  if (!partial) return { ...DEFAULT_SEARCH_CONFIG };
  
  const config: SearchConfig = { ...DEFAULT_SEARCH_CONFIG };
  
  if (partial.rrf_k !== undefined) {
    if (partial.rrf_k < 0) {
      console.warn('[search] Invalid rrf_k (negative), using default');
    } else {
      config.rrf_k = partial.rrf_k;
    }
  }
  
  if (partial.top_k !== undefined) {
    if (partial.top_k < 0) {
      console.warn('[search] Invalid top_k (negative), using default');
    } else {
      config.top_k = partial.top_k;
    }
  }
  
  if (partial.centrality_weight !== undefined) {
    if (partial.centrality_weight < 0) {
      console.warn('[search] Invalid centrality_weight (negative), using default');
    } else {
      config.centrality_weight = partial.centrality_weight;
    }
  }
  
  if (partial.supersede_demotion !== undefined) {
    if (partial.supersede_demotion < 0) {
      console.warn('[search] Invalid supersede_demotion (negative), using default');
    } else {
      config.supersede_demotion = partial.supersede_demotion;
    }
  }
  
  if (partial.blending) {
    config.blending = {
      top3: partial.blending.top3 ?? DEFAULT_SEARCH_CONFIG.blending.top3,
      mid: partial.blending.mid ?? DEFAULT_SEARCH_CONFIG.blending.mid,
      tail: partial.blending.tail ?? DEFAULT_SEARCH_CONFIG.blending.tail,
    };
    
    const checkWeights = (name: string, weights: { rrf: number; rerank: number }) => {
      const sum = weights.rrf + weights.rerank;
      if (Math.abs(sum - 1.0) > 0.01) {
        console.warn(`[search] Blending weights for ${name} sum to ${sum.toFixed(2)}, expected ~1.0`);
      }
    };
    checkWeights('top3', config.blending.top3);
    checkWeights('mid', config.blending.mid);
    checkWeights('tail', config.blending.tail);
  }
  
  if (partial.expansion) {
    config.expansion = {
      enabled: partial.expansion.enabled ?? DEFAULT_SEARCH_CONFIG.expansion.enabled,
      weight: partial.expansion.weight ?? DEFAULT_SEARCH_CONFIG.expansion.weight,
    };
    if (config.expansion.weight < 0) {
      console.warn('[search] Invalid expansion.weight (negative), using default');
      config.expansion.weight = DEFAULT_SEARCH_CONFIG.expansion.weight;
    }
  }
  
  if (partial.reranking) {
    config.reranking = {
      enabled: partial.reranking.enabled ?? DEFAULT_SEARCH_CONFIG.reranking.enabled,
    };
  }
  
  return config;
}

export function searchFTS(
  store: Store,
  query: string,
  options?: StoreSearchOptions
): SearchResult[] {
  return store.searchFTS(query, options);
}

export function searchVec(
  store: Store,
  query: string,
  embedding: number[],
  options?: StoreSearchOptions
): SearchResult[] {
  return store.searchVec(query, embedding, options);
}

export function rrfFuse(
  resultSets: SearchResult[][],
  k: number = 60,
  weights?: number[]
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();
  
  resultSets.forEach((results, setIndex) => {
    const weight = weights?.[setIndex] ?? 1;
    
    results.forEach((result, rank) => {
      const rrfScore = weight / (k + rank + 1);
      
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(result.id, {
          result: { ...result },
          score: rrfScore,
        });
      }
    });
  });
  
  const merged = Array.from(scoreMap.values()).map(({ result, score }) => ({
    ...result,
    score,
  }));
  
  return merged.sort((a, b) => b.score - a.score);
}

export function applyTopRankBonus(
  results: SearchResult[],
  originalFtsResults: SearchResult[]
): SearchResult[] {
  const bonusMap = new Map<string, number>();
  
  if (originalFtsResults.length > 0) {
    bonusMap.set(originalFtsResults[0].id, 0.05);
  }
  if (originalFtsResults.length > 1) {
    bonusMap.set(originalFtsResults[1].id, 0.02);
  }
  if (originalFtsResults.length > 2) {
    bonusMap.set(originalFtsResults[2].id, 0.02);
  }
  
  const boosted = results.map(r => ({
    ...r,
    score: r.score + (bonusMap.get(r.id) ?? 0),
  }));
  
  return boosted.sort((a, b) => b.score - a.score);
}

export function positionAwareBlend(
  rrfResults: SearchResult[],
  rerankScores: Map<string, number>,
  blendingConfig?: SearchConfig['blending']
): SearchResult[] {
  const blending = blendingConfig ?? DEFAULT_SEARCH_CONFIG.blending;
  
  const blended = rrfResults.map((result, index) => {
    const rerankScore = rerankScores.get(result.id);
    
    if (rerankScore === undefined) {
      return result;
    }
    
    let rrfWeight: number;
    let rerankWeight: number;
    
    if (index <= 2) {
      rrfWeight = blending.top3.rrf;
      rerankWeight = blending.top3.rerank;
    } else if (index <= 9) {
      rrfWeight = blending.mid.rrf;
      rerankWeight = blending.mid.rerank;
    } else {
      rrfWeight = blending.tail.rrf;
      rerankWeight = blending.tail.rerank;
    }
    
    const finalScore = rrfWeight * result.score + rerankWeight * rerankScore;
    
    return {
      ...result,
      score: finalScore,
    };
  });
  
  return blended.sort((a, b) => b.score - a.score);
}

export function applyCentralityBoost(
  results: SearchResult[],
  centralityWeight: number
): SearchResult[] {
  return results.map(r => {
    if (r.centrality && r.centrality > 0) {
      return {
        ...r,
        score: r.score * (1 + centralityWeight * r.centrality),
      };
    }
    return r;
  });
}

export function applySupersedeDemotion(
  results: SearchResult[],
  demotionFactor: number
): SearchResult[] {
  return results.map(r => {
    if (r.supersededBy !== undefined && r.supersededBy !== null) {
      return {
        ...r,
        score: r.score * demotionFactor,
      };
    }
    return r;
  });
}

export function formatSnippet(text: string, maxLength: number = 700): string {
  if (text.length <= maxLength) {
    return text;
  }
  
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }
  
  return truncated + '...';
}

function cacheHash(prefix: string, ...parts: string[]): string {
  return computeHash(prefix + ':' + parts.join(':'));
}

export async function hybridSearch(
  store: Store,
  options: HybridSearchOptions,
  providers: SearchProviders = {}
): Promise<SearchResult[]> {
  const {
    query,
    limit = 10,
    collection,
    minScore = 0,
    projectHash,
    tags,
    since,
    until,
    searchConfig,
  } = options;
  
  const config = searchConfig ?? DEFAULT_SEARCH_CONFIG;
  const useExpansion = options.useExpansion ?? config.expansion.enabled;
  const useReranking = options.useReranking ?? config.reranking.enabled;
  const topK = options.topK ?? config.top_k;
  
  log('search', 'hybridSearch query=' + query + ' limit=' + limit + ' collection=' + (collection || 'all') + ' expansion=' + useExpansion + ' reranking=' + useReranking);
  
  const { embedder, reranker, expander } = providers;
  
  const searchOpts: StoreSearchOptions = {
    limit: topK,
    collection,
    projectHash,
    tags,
    since,
    until,
  };
  
  let queries: string[] = [query];
  
  if (useExpansion && expander) {
    const expansionCacheKey = cacheHash('expand', query);
    const cached = store.getCachedResult(expansionCacheKey, projectHash);
    
    if (cached) {
      log('search', 'hybridSearch expansion cache hit');
      try {
        const variants = JSON.parse(cached) as string[];
        queries = [query, ...variants];
      } catch {
        queries = [query];
      }
    } else {
      try {
        const variants = await expander.expand(query);
        store.setCachedResult(expansionCacheKey, JSON.stringify(variants), projectHash, 'expand');
        queries = [query, ...variants];
      } catch {
        queries = [query];
      }
    }
  }
  
  const searchPromises = queries.map(async (q, i) => {
    const isOriginal = i === 0;
    const weight = isOriginal ? 2 : config.expansion.weight;
    
    const ftsResults = store.searchFTS(q, searchOpts);
    
    let vecResults: SearchResult[] = [];
    if (embedder) {
      try {
        let embedding: number[];
        const cached = store.getQueryEmbeddingCache(q);
        if (cached) {
          embedding = cached;
        } else {
          const result = await embedder.embed(q);
          embedding = result.embedding;
          store.setQueryEmbeddingCache(q, embedding);
        }
        vecResults = store.searchVec(q, embedding, searchOpts);
      } catch {
      }
    }
    
    return { ftsResults, vecResults, weight };
  });

  const searchResults = await Promise.all(searchPromises);

  const allResultSets: SearchResult[][] = [];
  const weights: number[] = [];
  let totalFts = 0;
  let totalVec = 0;
  for (const { ftsResults, vecResults, weight } of searchResults) {
    allResultSets.push(ftsResults);
    weights.push(weight);
    totalFts += ftsResults.length;
    if (vecResults.length > 0) {
      allResultSets.push(vecResults);
      weights.push(weight);
      totalVec += vecResults.length;
    }
  }
  log('search', 'hybridSearch fts=' + totalFts + ' vec=' + totalVec);
  
  const originalFtsResults = allResultSets[0] || [];
  
  let fusedResults = rrfFuse(allResultSets, config.rrf_k, weights);
  log('search', 'hybridSearch fused=' + fusedResults.length);
  
  fusedResults = applyTopRankBonus(fusedResults, originalFtsResults);
  
  fusedResults = applyCentralityBoost(fusedResults, config.centrality_weight);
  
  fusedResults = applySupersedeDemotion(fusedResults, config.supersede_demotion);
  
  fusedResults.sort((a, b) => b.score - a.score);
  
  const candidates = fusedResults.slice(0, topK);
  
  if (useReranking && reranker && candidates.length > 0) {
    const candidateIds = candidates.map(c => c.id).join(',');
    const rerankCacheKey = cacheHash('rerank', query, candidateIds);
    const cachedRerank = store.getCachedResult(rerankCacheKey, projectHash);
    
    let rerankScores = new Map<string, number>();
    
    if (cachedRerank) {
      log('search', 'hybridSearch rerank cache hit');
      try {
        const parsed = JSON.parse(cachedRerank) as Array<{ file: string; score: number }>;
        parsed.forEach(r => rerankScores.set(r.file, r.score));
      } catch {
      }
    } else {
      try {
        const docs = candidates.map((c, index) => ({
          text: c.snippet,
          file: c.id,
          index,
        }));
        
        const rerankResult = await reranker.rerank(query, docs);
        
        rerankResult.results.forEach(r => {
          rerankScores.set(r.file, r.score);
        });
        
        const cacheData = rerankResult.results.map(r => ({
          file: r.file,
          score: r.score,
        }));
        store.setCachedResult(rerankCacheKey, JSON.stringify(cacheData), projectHash, 'rerank');
      } catch {
      }
    }
    
    fusedResults = positionAwareBlend(candidates, rerankScores, config.blending);
    log('search', 'hybridSearch reranked=' + fusedResults.length);
  } else {
    fusedResults = candidates;
  }
  
  let filtered = fusedResults;
  if (minScore > 0) {
    filtered = fusedResults.filter(r => r.score >= minScore);
  }
  
  const final = filtered.slice(0, limit);
  log('search', 'hybridSearch final=' + final.length);
  
  return final.map(r => ({
    ...r,
    snippet: formatSnippet(r.snippet, 700),
  }));
}

export async function search(
  store: Store,
  options: SearchOptions
): Promise<SearchResult[]> {
  return store.searchFTS(options.query, { limit: options.limit, collection: options.collection });
}
