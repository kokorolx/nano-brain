import type { SearchResult, Store, StoreSearchOptions, SearchConfig } from './types.js';
import { DEFAULT_SEARCH_CONFIG } from './types.js';
import { computeHash } from './store.js';
import { log } from './logger.js';
import { searchFTSAsync, isFTSWorkerReady } from './fts-client.js';
import type Database from 'better-sqlite3';
import { getClusterLabels } from './graph.js';
import { SymbolGraph } from './symbol-graph.js';
import { generateQueryId } from './telemetry.js';
import type { ThompsonSampler } from './bandits.js';
import type { IntentClassifier } from './intent-classifier.js';

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
  db?: Database.Database;
  cacheKey?: string;
  sessionId?: string;
  sampler?: ThompsonSampler;
  importanceScorer?: { getScore(docid: string): number; applyBoost(searchScore: number, importanceScore: number): number };
  intentClassifier?: IntentClassifier;
  internal?: boolean;
  categoryWeights?: Record<string, number>;
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
      log('search', 'Invalid rrf_k (negative), using default', 'warn');
    } else {
      config.rrf_k = partial.rrf_k;
    }
  }

  if (partial.top_k !== undefined) {
    if (partial.top_k < 0) {
      log('search', 'Invalid top_k (negative), using default', 'warn');
    } else {
      config.top_k = partial.top_k;
    }
  }

  if (partial.centrality_weight !== undefined) {
    if (partial.centrality_weight < 0) {
      log('search', 'Invalid centrality_weight (negative), using default', 'warn');
    } else {
      config.centrality_weight = partial.centrality_weight;
    }
  }

  if (partial.supersede_demotion !== undefined) {
    if (partial.supersede_demotion < 0) {
      log('search', 'Invalid supersede_demotion (negative), using default', 'warn');
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
        log('search', `Blending weights for ${name} sum to ${sum.toFixed(2)}, expected ~1.0`, 'warn');
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
      log('search', 'Invalid expansion.weight (negative), using default', 'warn');
      config.expansion.weight = DEFAULT_SEARCH_CONFIG.expansion.weight;
    }
  }

  if (partial.reranking) {
    config.reranking = {
      enabled: partial.reranking.enabled ?? DEFAULT_SEARCH_CONFIG.reranking.enabled,
    };
  }

  if (partial.length_norm_anchor !== undefined) {
    config.length_norm_anchor = partial.length_norm_anchor > 0 ? partial.length_norm_anchor : DEFAULT_SEARCH_CONFIG.length_norm_anchor;
  }

  if (partial.recency_weight !== undefined) {
    config.recency_weight = partial.recency_weight >= 0 && partial.recency_weight <= 1 ? partial.recency_weight : DEFAULT_SEARCH_CONFIG.recency_weight;
  }

  if (partial.recency_half_life_days !== undefined) {
    config.recency_half_life_days = partial.recency_half_life_days > 0 ? partial.recency_half_life_days : DEFAULT_SEARCH_CONFIG.recency_half_life_days;
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

export async function searchVecAsync(
  store: Store,
  query: string,
  embedding: number[],
  options?: StoreSearchOptions
): Promise<SearchResult[]> {
  return store.searchVecAsync(query, embedding, options);
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
        if (!existing.result.createdAt && result.createdAt) {
          existing.result.createdAt = result.createdAt;
        }
        if (!existing.result.charLength && result.charLength) {
          existing.result.charLength = result.charLength;
        }
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

export function computeDecayScore(
  lastAccessedAt: string | null,
  createdAt: string,
  halfLifeDays: number
): number {
  const dateStr = lastAccessedAt ?? createdAt;
  const parsed = Date.parse(dateStr);
  if (isNaN(parsed)) return 0.5; // safe fallback for invalid dates
  const daysSinceAccess = (Date.now() - parsed) / 86400000;
  if (daysSinceAccess < 0) return 1; // future dates treated as fresh
  return 1 / (1 + daysSinceAccess / halfLifeDays);
}

export function applyUsageBoost(
  results: SearchResult[],
  config: { usageBoostWeight: number; decayHalfLifeDays: number }
): SearchResult[] {
  const weight = Math.max(0, Math.min(1, config.usageBoostWeight ?? 0.15));
  const halfLife = Math.max(1, config.decayHalfLifeDays ?? 30);
  const boosted = results.map(r => {
    const accessCount = (r as any).access_count ?? 0;
    if (accessCount === 0) {
      return r;
    }
    const lastAccessedAt = (r as any).lastAccessedAt ?? null;
    const createdAt = (r as any).createdAt ?? new Date().toISOString();
    const decayScore = computeDecayScore(lastAccessedAt, createdAt, halfLife);
    const boost = Math.log2(1 + accessCount) * decayScore * weight;
    return {
      ...r,
      score: r.score * (1 + boost),
    };
  });
  return boosted.sort((a, b) => b.score - a.score);
}

export function applyCategoryWeightBoost(
  results: SearchResult[],
  store: Store,
  categoryWeights: Record<string, number>
): SearchResult[] {
  if (Object.keys(categoryWeights).length === 0) {
    return results;
  }

  return results.map(r => {
    const docId = parseInt(r.id);
    if (isNaN(docId)) return r;

    const tags = store.getDocumentTags(docId);
    const categoryTags = tags.filter(t => t.startsWith('auto:') || t.startsWith('llm:'));

    if (categoryTags.length === 0) return r;

    let maxWeight = 1.0;
    for (const tag of categoryTags) {
      const weight = categoryWeights[tag];
      if (weight !== undefined && weight > maxWeight) {
        maxWeight = weight;
      }
    }

    return {
      ...r,
      score: r.score * maxWeight,
    };
  });
}

export function applyLengthNorm(
  results: SearchResult[],
  config: SearchConfig
): SearchResult[] {
  const anchor = config.length_norm_anchor ?? 2000;
  return results.map(r => {
    const charLength = r.charLength;
    if (!charLength || charLength <= 0) return r;
    const penalty = 1 / (1 + Math.log2(Math.max(1, charLength / anchor)));
    return { ...r, score: r.score * penalty };
  });
}

export function applyRecencyBoost(
  results: SearchResult[],
  config: SearchConfig
): SearchResult[] {
  const weight = config.recency_weight ?? 0.3;
  const halfLife = config.recency_half_life_days ?? 180;
  const now = Date.now();

  return results.map(r => {
    if (r.collection !== 'sessions' && r.collection !== 'memory') return r;
    if (!r.createdAt) return r;

    const parsed = Date.parse(r.createdAt);
    if (isNaN(parsed)) return r;

    const ageDays = (now - parsed) / 86400000;
    const decayFactor = Math.exp(-Math.log(2) * ageDays / halfLife);
    const score = r.score * (1 - weight) + r.score * weight * decayFactor;
    return { ...r, score };
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

function enrichResultWithSymbols(
  result: SearchResult,
  db: Database.Database,
  projectHash: string,
  clusterLabels: Map<number, string>
): SearchResult {
  const symbolsStmt = db.prepare(`
    SELECT id, name, cluster_id
    FROM code_symbols
    WHERE file_path = ? AND project_hash = ?
  `);
  const symbols = symbolsStmt.all(result.path, projectHash) as Array<{
    id: number;
    name: string;
    cluster_id: number | null;
  }>;

  if (symbols.length === 0) {
    return result;
  }

  const symbolNames = symbols.map(s => s.name);

  const clusterCounts = new Map<number, number>();
  for (const s of symbols) {
    if (s.cluster_id !== null) {
      clusterCounts.set(s.cluster_id, (clusterCounts.get(s.cluster_id) ?? 0) + 1);
    }
  }
  let dominantClusterId: number | null = null;
  let maxCount = 0;
  for (const [clusterId, count] of clusterCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominantClusterId = clusterId;
    }
  }
  const clusterLabel = dominantClusterId !== null ? clusterLabels.get(dominantClusterId) : undefined;

  const symbolIds = symbols.map(s => s.id);
  let flowCount = 0;
  if (symbolIds.length > 0) {
    const placeholders = symbolIds.map(() => '?').join(',');
    const flowStmt = db.prepare(`
      SELECT COUNT(DISTINCT flow_id) as count
      FROM flow_steps
      WHERE symbol_id IN (${placeholders})
    `);
    const flowResult = flowStmt.get(...symbolIds) as { count: number };
    flowCount = flowResult.count;
  }

  return {
    ...result,
    symbols: symbolNames,
    clusterLabel,
    flowCount: flowCount > 0 ? flowCount : undefined,
  };
}

export async function hybridSearch(
  store: Store,
  options: HybridSearchOptions,
  providers: SearchProviders = {}
): Promise<SearchResult[]> {
  const startTime = Date.now();
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
    db,
    cacheKey,
    sessionId,
  } = options;

  const config = { ...(searchConfig ?? DEFAULT_SEARCH_CONFIG) };
  let selectedBanditVariants: Record<string, number> | null = null;

  if (options.sampler) {
    try {
      const variants = options.sampler.selectSearchConfig();
      selectedBanditVariants = variants;
      if (variants.rrf_k !== undefined) config.rrf_k = variants.rrf_k;
      if (variants.centrality_weight !== undefined) config.centrality_weight = variants.centrality_weight;
    } catch (err) {
      log('search', 'Bandit variant selection failed, using static config: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (options.intentClassifier?.isEnabled()) {
    const classification = options.intentClassifier.classify(query);
    if (classification.intent !== 'unclassified') {
      const overrides = options.intentClassifier.getConfigOverrides(classification.intent);
      if (overrides.rrf_k !== undefined) config.rrf_k = overrides.rrf_k;
      if (overrides.centrality_weight !== undefined) config.centrality_weight = overrides.centrality_weight;
      if (overrides.top_k !== undefined) config.top_k = overrides.top_k;
      log('search', 'Intent: ' + classification.intent + ' (confidence=' + classification.confidence.toFixed(2) + ')');
    }
  }

  const useExpansion = options.useExpansion ?? config.expansion.enabled;
  const useReranking = options.useReranking ?? config.reranking.enabled;
  const topK = options.topK ?? config.top_k;

  log('search', 'hybridSearch START query=' + query + ' limit=' + limit + ' expansion=' + useExpansion + ' reranking=' + useReranking + ' hasEmbedder=' + !!providers.embedder + ' hasExpander=' + !!providers.expander);

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

  log('search', 'hybridSearch expansion done queries=' + queries.length);
  const searchPromises = queries.map(async (q, i) => {
    const isOriginal = i === 0;
    const weight = isOriginal ? 2 : config.expansion.weight;

    let ftsResults: SearchResult[] = [];
    if (isFTSWorkerReady()) {
      const FTS_WORKER_TIMEOUT_MS = 5000;
      try {
        ftsResults = await Promise.race([
          searchFTSAsync(q, searchOpts),
          new Promise<SearchResult[]>((resolve) =>
            setTimeout(() => resolve([]), FTS_WORKER_TIMEOUT_MS)
          ),
        ]);
      } catch {
        ftsResults = store.searchFTS(q, searchOpts);
      }
    } else {
      ftsResults = store.searchFTS(q, searchOpts);
    }

    let vecResults: SearchResult[] = [];
    if (embedder) {
      const VEC_SEARCH_TIMEOUT_MS = 5000;
      try {
        vecResults = await Promise.race([
          (async () => {
            let embedding: number[];
            const cached = store.getQueryEmbeddingCache(q);
            if (cached) {
              embedding = cached;
            } else {
              const result = await embedder.embed(q);
              embedding = result.embedding;
              store.setQueryEmbeddingCache(q, embedding);
            }
            return store.searchVecAsync(q, embedding, searchOpts);
          })(),
          new Promise<SearchResult[]>((resolve) =>
            setTimeout(() => resolve([]), VEC_SEARCH_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        log('search', `Vector search failed, falling back to FTS-only: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    }

    return { ftsResults, vecResults, weight };
  });

  log('search', 'hybridSearch awaiting searchPromises...');
  const searchResults = await Promise.all(searchPromises);
  log('search', 'hybridSearch searchPromises resolved');

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

  log('search', 'hybridSearch fusing results...');
  if (db && projectHash) {
    const symbolGraph = new SymbolGraph(db);
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const isOriginal = i === 0;
      const weight = isOriginal ? 2 : config.expansion.weight;

      const symbolMatches = symbolGraph.searchByName(q, projectHash, topK);

      const symbolResults: SearchResult[] = [];
      for (const sym of symbolMatches) {
        const doc = store.findDocument(sym.filePath);
        if (doc) {
          const body = store.getDocumentBody(doc.hash);
          const lines = body?.split('\n') ?? [];
          const snippetLines = lines.slice(Math.max(0, sym.startLine - 1), sym.endLine);
          const snippet = snippetLines.join('\n');
          symbolResults.push({
            id: String(doc.id),
            path: sym.filePath,
            snippet: snippet || sym.name,
            score: 0,
            collection: doc.collection,
            title: doc.title,
            startLine: sym.startLine,
            endLine: sym.endLine,
            docid: doc.hash.substring(0, 6),
          });
        }
      }

      if (symbolResults.length > 0) {
        allResultSets.push(symbolResults);
        weights.push(weight);
      }
    }
  }

  const originalFtsResults = allResultSets[0] || [];

  let fusedResults = rrfFuse(allResultSets, config.rrf_k, weights);
  log('search', 'hybridSearch fused=' + fusedResults.length);

  fusedResults = applyTopRankBonus(fusedResults, originalFtsResults);

  fusedResults = applyCentralityBoost(fusedResults, config.centrality_weight);

  if ((config as any).usage_boost_weight > 0) {
    fusedResults = applyUsageBoost(fusedResults, {
      usageBoostWeight: (config as any).usage_boost_weight ?? 0.15,
      decayHalfLifeDays: 30,
    });
  }

  if (options.categoryWeights && Object.keys(options.categoryWeights).length > 0) {
    fusedResults = applyCategoryWeightBoost(fusedResults, store, options.categoryWeights);
  }

  fusedResults = applySupersedeDemotion(fusedResults, config.supersede_demotion);

  fusedResults = applyLengthNorm(fusedResults, config);

  fusedResults = applyRecencyBoost(fusedResults, config);

  if (options.importanceScorer) {
    fusedResults = fusedResults.map(r => {
      const importanceScore = options.importanceScorer!.getScore(r.docid);
      if (importanceScore > 0) {
        return { ...r, score: options.importanceScorer!.applyBoost(r.score, importanceScore) };
      }
      return r;
    });
  }

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

  let results = final.map(r => ({
    ...r,
    snippet: formatSnippet(r.snippet, 700),
  }));

  if (db && projectHash) {
    const clusterLabels = getClusterLabels(db, projectHash);
    results = results.map(r => enrichResultWithSymbols(r, db, projectHash, clusterLabels));
  }

  try {
    const executionMs = Date.now() - startTime;
    const queryId = generateQueryId();
    const resultDocids = results.map(r => r.docid);
    const tier = providers.reranker && useReranking ? 'hybrid+rerank' : (providers.embedder ? 'hybrid' : 'fts');
    const configVariant = selectedBanditVariants ? JSON.stringify(selectedBanditVariants) : null;
    store.logSearchQuery(
      queryId,
      query,
      tier,
      configVariant,
      resultDocids,
      executionMs,
      sessionId ?? null,
      cacheKey ?? null,
      projectHash ?? 'global'
    );
  } catch {
  }

  if (!options.internal) {
    try {
      const ids = results.map(r => parseInt(r.id)).filter(id => !isNaN(id));
      if (ids.length > 0) {
        store.trackAccess(ids);
      }
    } catch {
    }
  }

  return results;
}

export async function search(
  store: Store,
  options: SearchOptions
): Promise<SearchResult[]> {
  return store.searchFTS(options.query, { limit: options.limit, collection: options.collection });
}
