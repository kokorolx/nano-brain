import type { SearchResult, Store } from './types.js';
import { computeHash } from './store.js';

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
}

export interface SearchProviders {
  embedder?: { embed(text: string): Promise<{ embedding: number[] }> } | null;
  reranker?: { rerank(query: string, docs: any[]): Promise<{ results: Array<{ file: string; score: number; index: number }> }> } | null;
  expander?: { expand(query: string): Promise<string[]> } | null;
}

export function searchFTS(
  store: Store,
  query: string,
  options?: { limit?: number; collection?: string }
): SearchResult[] {
  const limit = options?.limit;
  const collection = options?.collection;
  return store.searchFTS(query, limit, collection);
}

export function searchVec(
  store: Store,
  query: string,
  embedding: number[],
  options?: { limit?: number; collection?: string }
): SearchResult[] {
  const limit = options?.limit;
  const collection = options?.collection;
  return store.searchVec(query, embedding, limit, collection);
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
  rerankScores: Map<string, number>
): SearchResult[] {
  const blended = rrfResults.map((result, index) => {
    const rerankScore = rerankScores.get(result.id);
    
    if (rerankScore === undefined) {
      return result;
    }
    
    let rrfWeight: number;
    let rerankWeight: number;
    
    if (index <= 2) {
      rrfWeight = 0.75;
      rerankWeight = 0.25;
    } else if (index <= 9) {
      rrfWeight = 0.60;
      rerankWeight = 0.40;
    } else {
      rrfWeight = 0.40;
      rerankWeight = 0.60;
    }
    
    const finalScore = rrfWeight * result.score + rerankWeight * rerankScore;
    
    return {
      ...result,
      score: finalScore,
    };
  });
  
  return blended.sort((a, b) => b.score - a.score);
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
    useExpansion = true,
    useReranking = true,
    topK = 30,
  } = options;
  
  const { embedder, reranker, expander } = providers;
  
  let queries: string[] = [query];
  
  if (useExpansion && expander) {
    const expansionCacheKey = cacheHash('expand', query);
    const cached = store.getCachedResult(expansionCacheKey);
    
    if (cached) {
      try {
        const variants = JSON.parse(cached) as string[];
        queries = [query, ...variants];
      } catch {
        queries = [query];
      }
    } else {
      try {
        const variants = await expander.expand(query);
        store.setCachedResult(expansionCacheKey, JSON.stringify(variants));
        queries = [query, ...variants];
      } catch {
        queries = [query];
      }
    }
  }
  
  const allResultSets: SearchResult[][] = [];
  const weights: number[] = [];
  
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const isOriginal = i === 0;
    const weight = isOriginal ? 2 : 1;
    
    const ftsResults = store.searchFTS(q, topK, collection);
    allResultSets.push(ftsResults);
    weights.push(weight);
    
    if (embedder) {
      try {
        const { embedding } = await embedder.embed(q);
        const vecResults = store.searchVec(q, embedding, topK, collection);
        allResultSets.push(vecResults);
        weights.push(weight);
      } catch {
      }
    }
  }
  
  const originalFtsResults = allResultSets[0] || [];
  
  let fusedResults = rrfFuse(allResultSets, 60, weights);
  
  fusedResults = applyTopRankBonus(fusedResults, originalFtsResults);
  
  const candidates = fusedResults.slice(0, topK);
  
  if (useReranking && reranker && candidates.length > 0) {
    const candidateIds = candidates.map(c => c.id).join(',');
    const rerankCacheKey = cacheHash('rerank', query, candidateIds);
    const cachedRerank = store.getCachedResult(rerankCacheKey);
    
    let rerankScores = new Map<string, number>();
    
    if (cachedRerank) {
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
        store.setCachedResult(rerankCacheKey, JSON.stringify(cacheData));
      } catch {
      }
    }
    
    fusedResults = positionAwareBlend(candidates, rerankScores);
  } else {
    fusedResults = candidates;
  }
  
  let filtered = fusedResults;
  if (minScore > 0) {
    filtered = fusedResults.filter(r => r.score >= minScore);
  }
  
  const final = filtered.slice(0, limit);
  
  return final.map(r => ({
    ...r,
    snippet: formatSnippet(r.snippet, 700),
  }));
}

export async function search(
  store: Store,
  options: SearchOptions
): Promise<SearchResult[]> {
  return store.searchFTS(options.query, options.limit, options.collection);
}
