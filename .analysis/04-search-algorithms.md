# nano-brain: Search & Algorithms — Comprehensive Analysis

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Complete Search Pipeline](#2-complete-search-pipeline)
3. [Full-Text Search (FTS5/BM25)](#3-full-text-search-fts5bm25)
4. [Vector Search](#4-vector-search)
5. [Embedding Generation Pipeline](#5-embedding-generation-pipeline)
6. [Hybrid Merge Algorithm (RRF)](#6-hybrid-merge-algorithm-rrf)
7. [Query Expansion](#7-query-expansion)
8. [Reranking](#8-reranking)
9. [Position-Aware Blending](#9-position-aware-blending)
10. [Score Boosting & Demotion Pipeline](#10-score-boosting--demotion-pipeline)
11. [Thompson Sampling (Bandits)](#11-thompson-sampling-bandits)
12. [Intent Classification](#12-intent-classification)
13. [Importance Scoring](#13-importance-scoring)
14. [Caching Architecture](#14-caching-architecture)
15. [Code Intelligence](#15-code-intelligence)
16. [Memory Graph](#16-memory-graph)
17. [FTS Worker Architecture](#17-fts-worker-architecture)
18. [Search Telemetry](#18-search-telemetry)
19. [Eval/Benchmark Framework](#19-evalbenchmark-framework)
20. [Configuration & Defaults](#20-configuration--defaults)

---

## 1. Architecture Overview

nano-brain implements a **multi-stage hybrid search pipeline** combining full-text search (SQLite FTS5 with BM25 scoring), vector similarity search (sqlite-vec or Qdrant with cosine distance), LLM-based query expansion, neural reranking (Voyage AI), and multiple score-boosting heuristics. The system is designed as a persistent memory and code intelligence layer for AI coding agents.

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| Store | `src/store.ts` | SQLite database, FTS5 tables, vector tables, all prepared statements |
| Search Orchestrator | `src/search.ts` | `hybridSearch()` — the main entry point coordinating all stages |
| FTS Client | `src/fts-client.ts` | Worker-thread RPC wrapper for non-blocking FTS queries |
| FTS Worker | `src/fts-worker.ts` | Dedicated worker thread running FTS5/vector queries |
| Embeddings | `src/embeddings.ts` | Ollama and OpenAI-compatible embedding providers |
| Reranker | `src/reranker.ts` | Voyage AI neural reranking |
| Expansion | `src/expansion.ts` | LLM-based query expansion |
| Vector Store | `src/vector-store.ts` | Abstraction over sqlite-vec and Qdrant |
| sqlite-vec Provider | `src/providers/sqlite-vec.ts` | Local cosine similarity via sqlite-vec extension |
| Qdrant Provider | `src/providers/qdrant.ts` | External Qdrant vector database |
| Symbol Graph | `src/symbol-graph.ts` | Code symbol search, context, and impact analysis |
| Memory Graph | `src/memory-graph.ts` | Entity graph traversal (BFS) |
| Bandits | `src/bandits.ts` | Thompson Sampling for online search config optimization |
| Intent Classifier | `src/intent-classifier.ts` | Keyword-based query intent classification |
| Importance Scorer | `src/importance.ts` | Document importance scoring (usage, recency, entity density) |
| Cache | `src/cache.ts` | In-memory TTL result cache |
| LLM Provider | `src/llm-provider.ts` | Ollama/GitLab Duo LLM for expansion and consolidation |
| Eval Harness | `src/eval/harness.ts` | Code intelligence accuracy evaluation framework |

### Data Flow Summary

```
Query → Intent Classification → Bandit Config Selection
  → Query Expansion (LLM, cached)
  → For each query variant:
      ├── FTS5/BM25 search (via worker thread)
      ├── Vector search (embedding → sqlite-vec/Qdrant)
      └── Symbol graph search (code symbols by name)
  → RRF fusion (weighted Reciprocal Rank Fusion)
        preserves createdAt + charLength from whichever source has them
  → Top-rank bonus (FTS top-3)
  → Centrality boost (PageRank-like graph centrality)
  → Usage boost (access count × temporal decay)
  → Category weight boost (tag-based)
  → Supersede demotion (×0.05 — effectively buries outdated documents)
  → Length normalization (log2 penalty for large documents)
  → Recency boost (exponential decay, sessions/memory only)
  → Importance scoring boost
  → Neural reranking (Voyage AI, cached)
  → Position-aware blending (RRF × rerank scores)
  → Snippet formatting + symbol enrichment
  → Telemetry logging
  → Access tracking
  → Return results
```

## 2. Complete Search Pipeline

**Source:** `src/search.ts:hybridSearch()` (lines 426u2013751)

The `hybridSearch()` function is the single entry point for all search operations. It accepts `HybridSearchOptions` and `SearchProviders` and returns `Promise<SearchResult[]>`.

### Step-by-Step Execution

#### Step 1: Configuration Resolution
```typescript
const config = { ...(searchConfig ?? DEFAULT_SEARCH_CONFIG) };
```
- Merges user-provided `searchConfig` with `DEFAULT_SEARCH_CONFIG`
- If a `ThompsonSampler` is provided, bandit-selected variants override `rrf_k` and `centrality_weight`
- If `IntentClassifier` is enabled, query classification overrides config further

#### Step 2: Query Expansion (Optional)
- Checks `useExpansion` flag (default: `config.expansion.enabled`, which defaults to `false`)
- If enabled and `expander` provider exists:
  1. Check cache: `store.getCachedResult(cacheHash('expand', query), projectHash)`
  2. On miss: call `expander.expand(query)` u2192 returns 2u20133 LLM-generated variant queries
  3. Cache result for future use
  4. Final queries array: `[originalQuery, ...variants]`

#### Step 3: Parallel Search (Per Query Variant)
For each query `q` in the queries array, the following runs in parallel:

**FTS Search:**
- If `isFTSWorkerReady()`: sends query to worker thread via `searchFTSAsync(q, searchOpts)`
- Worker thread runs FTS5 MATCH query in an isolated thread (non-blocking)
- 5-second timeout with fallback to empty results
- **Never** calls synchronous `store.searchFTS()` from the main thread

**Vector Search:**
- If `embedder` provider exists:
  1. Check query embedding cache: `store.getQueryEmbeddingCache(q)`
  2. On miss: `embedder.embed(q)` u2192 get embedding vector
  3. Cache embedding for future queries
  4. Call `store.searchVecAsync(q, embedding, searchOpts)` u2192 Qdrant or sqlite-vec
  5. 5-second timeout with fallback to empty results

**Weight Assignment:**
- Original query: weight = `2` (double weight)
- Expansion variants: weight = `config.expansion.weight` (default: `1`)

#### Step 4: Symbol Graph Search
- If `db` and `projectHash` are provided:
  - For each query variant, `symbolGraph.searchByName(q, projectHash, topK)` runs
  - Matches code symbols by name (LIKE pattern match with camelCase/snake_case tokenization)
  - Matched symbols are converted to `SearchResult[]` with code snippets from the document body
  - Added as additional result sets with the same weight as the query variant

#### Step 5: RRF Fusion
- All result sets (FTS, vector, symbol) are fused using `rrfFuse(allResultSets, config.rrf_k, weights)`
- See Section 6 for the full RRF algorithm

#### Step 6: Post-Fusion Score Adjustments (in order)
1. **Top-rank bonus**: `applyTopRankBonus()` u2014 FTS top-1 gets +0.05, top-2/3 get +0.02
2. **Centrality boost**: `applyCentralityBoost()` u2014 `score * (1 + centrality_weight * centrality)`
3. **Usage boost**: `applyUsageBoost()` u2014 `score * (1 + log2(1 + accessCount) * decay * weight)`
4. **Category weight boost**: `applyCategoryWeightBoost()` u2014 multiplies by tag-based weights
5. **Supersede demotion**: `applySupersedeDemotion()` u2014 `score * 0.3` for superseded docs
6. **Importance scoring**: `importanceScorer.applyBoost()` u2014 `score * (1 + importance_weight * importanceScore)`

#### Step 7: Top-K Candidate Selection
```typescript
const candidates = fusedResults.slice(0, topK); // default topK = 15
```

#### Step 8: Neural Reranking (Optional)
- If `useReranking` is true and `reranker` provider exists:
  1. Check rerank cache: `store.getCachedResult(rerankCacheKey, projectHash)`
  2. On miss: call `reranker.rerank(query, docs)` u2192 Voyage AI relevance scores
  3. Cache rerank scores
  4. Apply `positionAwareBlend()` u2014 see Section 9

#### Step 9: Final Processing
- Filter by `minScore` threshold
- Slice to `limit` results
- Format snippets to 700 chars max
- Enrich with code symbols and cluster labels
- Log telemetry (query, tier, config variant, execution time)
- Track document access counts

## 3. Full-Text Search (FTS5/BM25)

**Source:** `src/store.ts` (lines 153u2013158, 670u2013739)

### FTS5 Virtual Table Schema

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  filepath,     -- collection/path composite
  title,        -- document title
  body,         -- full document content
  tokenize='porter unicode61'
);
```

**Tokenizer:** `porter unicode61` u2014 Porter stemming algorithm with Unicode-aware tokenization. This means:
- "running" matches "run", "runs", "runner"
- Unicode characters are handled correctly (not just ASCII)
- Automatic lowercasing

### FTS5 Triggers (Auto-Sync)

Three triggers keep `documents_fts` in sync with the `documents` table:

1. **`documents_ai` (AFTER INSERT):** Inserts `collection/path`, title, and body into FTS
2. **`documents_ad` (AFTER DELETE):** Removes FTS entry by filepath
3. **`documents_au` (AFTER UPDATE OF hash):** Deletes old entry, inserts new body

### Query Sanitization

**Source:** `src/store.ts:sanitizeFTS5Query()` (line 70)

```typescript
export function sanitizeFTS5Query(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const quotedTokens = tokens.map(token => `"${token.replace(/"/g, '""')}"`);
  if (quotedTokens.length === 1) return quotedTokens[0];
  return quotedTokens.join(' OR ');
}
```

Algorithm:
1. Split query on whitespace
2. Double-quote each token (escaping internal quotes)
3. Join with `OR` operator
4. Single token: no OR needed

Example: `"redis" OR "cache" OR "invalidation"`

### BM25 Scoring

The FTS5 `bm25()` function computes the Okapi BM25 relevance score. SQLite's FTS5 returns **negative** BM25 scores (lower = more relevant), so the store converts them:

```typescript
score: Math.abs(row.score as number)
```

### Search Variants

The store has four prepared FTS statements for different filter combinations:

| Variant | Filters | Statement |
|---------|---------|----------|
| Basic | none | `searchFTSStmt` |
| Collection | `collection = ?` | `searchFTSWithCollectionStmt` |
| Workspace | `project_hash = ?` (strict per-workspace) | `searchFTSWithWorkspaceStmt` |
| Both | collection + workspace | `searchFTSWithWorkspaceAndCollectionStmt` |

> **Note (2026-05-05):** Workspace filter was tightened from `IN (?, 'global')` to `= ?` to prevent cross-workspace result leakage. Pass `includeGlobal: true` in `StoreSearchOptions` to restore the old cross-workspace behavior explicitly.

The dynamic `searchFTS()` method (line 1671) builds SQL dynamically to handle additional filters:
- `since` / `until` date range on `modified_at`
- `tags` filtering via subquery on `document_tags` with `HAVING COUNT(DISTINCT tag) = ?`

### Result Shape

Each FTS result includes:
- `snippet()`: 64-token context window with `<mark>` highlights
- `bm25()`: relevance score (abs value)
- Document metadata: id, path, collection, title, hash, agent
- Graph metadata: centrality, cluster_id, superseded_by
- Access tracking: access_count, last_accessed_at

## 4. Vector Search

**Source:** `src/vector-store.ts`, `src/providers/sqlite-vec.ts`, `src/providers/qdrant.ts`

### VectorStore Interface

```typescript
export interface VectorStore {
  search(embedding: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  upsert(point: VectorPoint): Promise<void>;
  batchUpsert(points: VectorPoint[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByHash(hash: string): Promise<void>;
  health(): Promise<VectorStoreHealth>;
  close(): Promise<void>;
}
```

Two providers implement this interface: **sqlite-vec** (local, embedded) and **Qdrant** (external, networked).

### sqlite-vec Provider

**Source:** `src/providers/sqlite-vec.ts`

**Virtual Table:**
```sql
CREATE VIRTUAL TABLE vectors_vec USING vec0(
  hash_seq TEXT PRIMARY KEY,
  embedding float[<dimensions>] distance_metric=cosine
);
```

**Key ID format:** `hash_seq` = `"<content_hash>:<chunk_seq>"` — a composite of the document content hash and the chunk sequence number.

**Search Algorithm:**
1. Converts `number[]` embedding to `Float32Array` (required by sqlite-vec)
2. Executes `MATCH` query on the `vec0` virtual table with `k = limit` (default 10)
3. Results ordered by `distance` (ascending — closer = more similar)
4. Converts distance to similarity: `score = 1 - distance` (cosine distance → cosine similarity)
5. Splits `hash_seq` into `hash` and `seq` components

```sql
SELECT v.hash_seq, v.distance
FROM vectors_vec v
WHERE v.embedding MATCH ?
  AND k = ?
ORDER BY v.distance
```

**Dimension Management (`ensureVecTable`):**
- On startup, tests the table with a zero vector of the configured dimensions
- If dimensions mismatch (throws error), drops and recreates the table
- Also clears `content_vectors` and `llm_cache` to force re-embedding
- Detects orphan state: if `vectors_vec` is empty but `content_vectors` has rows, clears `content_vectors`

**Orphan Cleanup:**
```sql
DELETE FROM vectors_vec
WHERE substr(hash_seq, 1, instr(hash_seq, ':') - 1)
  NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
```

**Upsert Strategy:** Delete-then-insert (not ON CONFLICT) because vec0 doesn't support ON CONFLICT.

**Batch Upsert:** Wrapped in a SQLite transaction for atomicity.

### Qdrant Provider

**Source:** `src/providers/qdrant.ts`

**Collection Naming:** `"<baseName>-<dimensions>"` (e.g., `nano-brain-1024`) — dimensions are baked into the collection name so switching embedding models auto-creates a new collection.

**ID Generation (`stringToUuid`):**
- Takes `hash_seq` string → SHA-256 → truncates to 128 bits → formats as UUID v5
- Deterministic: same `hash_seq` always produces the same UUID
- Collision-safe for millions of vectors (unlike the old 32-bit `hashStringToInt` which collided at ~49K)

**Collection Initialization:**
- Lazy init with `ensureCollection()` — serialized via promise deduplication
- Creates collection with `Cosine` distance metric
- Creates payload indexes on `hash` (keyword) and `collection` (keyword)
- Client timeout set to 5s for fast-fail on unreachable instances
- `checkCompatibility: false` — disables background version check that can hang for 300s

**Search:**
- Supports filtering by `collection` and `projectHash` via Qdrant `must` filters
- Returns `point.score` directly (Qdrant returns cosine similarity, not distance)
- Extracts `hash` and `seq` from payload or falls back to parsing `hashSeq`
- Every upsert now includes `project_hash` and `created_at` in point payload for workspace isolation and temporal scoring
- On server startup, `backfillQdrantProjectHash()` runs async (fire-and-forget) to backfill existing points missing `project_hash` in batches of 100

**Retry Logic (`retryOnSocketError`):**
- Max 3 retries for socket errors: `UND_ERR_SOCKET`, `ECONNRESET`, `ECONNREFUSED`, `socket hang up`
- Exponential backoff: `min(1000 * 2^attempt, 8000)` ms

**Batch Upsert:** Chunks into batches of 100 points per API call.

## 5. Embedding Generation Pipeline

**Source:** `src/embeddings.ts` (490 lines)

### Provider Architecture

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  getDimensions(): number;
  getModel(): string;
  getMaxChars(): number;
  dispose(): void;
}
```

Two implementations: `OllamaEmbeddingProvider` and `OpenAICompatibleEmbeddingProvider`.

### Provider Selection (`createEmbeddingProvider`)

1. If `config.provider === 'openai'`: use OpenAI-compatible provider (requires `url` + `apiKey`)
2. If `config.provider !== 'local'` (default path): try Ollama at `config.url` or auto-detected URL
3. Both providers run a test embedding (`"test"`) during initialization to verify connectivity
4. Returns `null` if no provider is available (search falls back to FTS-only)

### Ollama Provider

- **Default model:** `nomic-embed-text`
- **Default dimensions:** 768 (auto-detected from model response)
- **Default max chars:** 6000
- **API endpoint:** `POST /api/embed` with `{ model, input: [text] }`
- **Timeout:** 90s per single embed, 180s per batch

**Context Detection (`detectModelContext`):**
1. Calls `POST /api/show` with model name
2. Extracts `general.architecture` from `model_info`
3. Reads `<arch>.context_length` and `<arch>.embedding_length`
4. Calculates `maxChars = min(floor((contextLength - 128) * 2), 6000)`
   - 128 = buffer tokens
   - 2 chars/token estimate (empirically tuned for BERT WordPiece on code-heavy content)

**Batch Embedding:**
- Sub-batches by cumulative character count: `MAX_CHARS_PER_BATCH = 100,000`
- Also capped at `MAX_ITEMS_PER_BATCH = 50`
- Sends all items in a single API call per sub-batch: `{ model, input: [text1, text2, ...] }`
- All texts truncated to `maxChars` before sending

### OpenAI-Compatible Provider

- **Default model:** `text-embedding-3-small` (configurable)
- **Default dimensions:** 1024 (configurable via `outputDimensions`)
- **Default max chars:** 8000
- **Default RPM limit:** 40 (configurable)
- **API endpoint:** `POST <baseUrl>/v1/embeddings`

**Rate Limiting (`throttle`):**
- Sliding window of 60 seconds
- Tracks timestamps of all requests in the window
- If at RPM limit, sleeps until oldest request expires + 100ms buffer

**Retry Logic (`fetchWithRetry`):**
- Max 3 retries on HTTP 429 (Too Many Requests)
- Uses `Retry-After` header if present, otherwise `2000 * (attempt + 1)` ms
- Throws on other HTTP errors

**Batch Embedding:**
- Sub-batches by character count: `maxCharsPerBatch = 200,000` (~100K token budget at ~3 chars/token)
- Uses `input_type: 'document'` for batch, `input_type: 'query'` for single
- Missing embeddings within a sub-batch get zero vectors as placeholders
- Failed sub-batches fill entire batch with zero vectors (preserves other sub-batch results)

**Token Usage Tracking:**
- Both providers support `onTokenUsage` callback: `(model: string, tokens: number) => void`
- OpenAI provider extracts `usage.total_tokens` from API response

### Prompt Formatting (Exported Utilities)

```typescript
function formatQueryPrompt(query: string): string {
  return `search_query: ${query}`;
}

function formatDocumentPrompt(title: string, content: string): string {
  return `search_document: ${content}`;
}
```

These follow the nomic-embed-text convention of prefixing queries vs documents.

## 6. Hybrid Merge Algorithm (RRF)

**Source:** `src/search.ts:rrfFuse()` (lines 152u2013183)

### Reciprocal Rank Fusion

RRF merges multiple ranked result lists into a single ranking without requiring score normalization. Each result set (FTS, vector, symbol) contributes to the final score based on rank position.

### Algorithm

```typescript
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
        // Preserve temporal metadata from whichever source has them
        if (!existing.result.createdAt && result.createdAt) existing.result.createdAt = result.createdAt;
        if (!existing.result.charLength && result.charLength) existing.result.charLength = result.charLength;
      } else {
        scoreMap.set(result.id, { result: { ...result }, score: rrfScore });
      }
    });
  });

  return Array.from(scoreMap.values())
    .map(({ result, score }) => ({ ...result, score }))
    .sort((a, b) => b.score - a.score);
}
```

### Formula

For a document `d` appearing at rank `r` in result set `s`:

```
RRF_score(d) = u03a3 [ weight_s / (k + rank_s(d) + 1) ]
```

Where:
- `k` = smoothing constant (default: 60). Higher `k` reduces the influence of top-ranked results.
- `rank_s(d)` = 0-indexed rank of document `d` in result set `s`
- `weight_s` = weight assigned to result set `s`

### Weight Assignment

| Source | Weight |
|--------|--------|
| Original query u2014 FTS results | 2 |
| Original query u2014 Vector results | 2 |
| Original query u2014 Symbol results | 2 |
| Expansion variant u2014 FTS results | `config.expansion.weight` (default: 1) |
| Expansion variant u2014 Vector results | `config.expansion.weight` (default: 1) |
| Expansion variant u2014 Symbol results | `config.expansion.weight` (default: 1) |

The original query gets double weight (2) to ensure the user's actual query dominates over LLM-generated expansions.

### Score Accumulation

Documents appearing in multiple result sets accumulate scores additively. A document ranked #1 in both FTS and vector search (with k=60, weight=2) would get:

```
score = 2/(60+0+1) + 2/(60+0+1) = 0.0328 + 0.0328 = 0.0656
```

Vs. a document ranked #1 in FTS only:

```
score = 2/(60+0+1) = 0.0328
```

This naturally rewards cross-modal agreement.

## 7. Query Expansion

**Source:** `src/expansion.ts` (61 lines)

### Architecture

Query expansion generates 2u20133 alternative search queries via an LLM, enabling the search pipeline to find documents that match semantically but not lexically.

### LLM Expander (`createLLMQueryExpander`)

Accepts any `LLMProvider` (Ollama or GitLab Duo) and returns a `QueryExpander`.

**Prompt Template:**
```
Generate 2-3 alternative search queries for finding relevant documents.
Return a JSON array of strings only, no explanation.

Original query: ${query}

Response format: ["variant 1", "variant 2"]
```

**Response Parsing:**
1. Regex extracts first JSON array from LLM response: `text.match(/\[[\s\S]*\]/)`
2. `JSON.parse()` the matched array
3. Filter out non-string values
4. Filter out variants identical to the original query (case-insensitive)
5. Returns empty array on any failure (LLM errors, parse errors)

### Caching in Search Pipeline

**Source:** `src/search.ts` (lines 491u2013512)

Expansion results are cached in the `llm_cache` table:
- **Cache key:** `computeHash('expand:' + query)` u2014 SHA-256 hash of the expansion key
- **Cache scope:** per `projectHash`
- **Cache type:** `'expand'`
- On hit: deserializes `JSON.parse(cached)` to `string[]`
- On miss: calls `expander.expand(query)`, then `store.setCachedResult(key, JSON.stringify(variants))`

### Pipeline Integration

- Expansion is **disabled by default** (`config.expansion.enabled = false`)
- When enabled: `queries = [originalQuery, ...variants]`
- Each variant runs the full FTS + vector + symbol search pipeline in parallel
- Original query weight = 2, expansion variant weight = `config.expansion.weight` (default: 1)

## 8. Reranking

**Source:** `src/reranker.ts` (104 lines)

### Voyage AI Reranker

The only reranker implementation uses the **Voyage AI Rerank API**.

- **API endpoint:** `https://api.voyageai.com/v1/rerank`
- **Default model:** `rerank-2.5-lite`
- **Timeout:** 30 seconds
- **Auth:** Bearer token via `apiKey`

### API Request Format

```json
{
  "query": "user search query",
  "documents": ["snippet1", "snippet2", ...],
  "model": "rerank-2.5-lite",
  "top_k": <number of documents>,
  "truncation": true
}
```

- `truncation: true` u2014 lets Voyage AI handle text that exceeds the model's context window
- `top_k` = all candidates (no pre-filtering; all candidates are scored)

### API Response Format

```json
{
  "results": [
    { "index": 0, "relevance_score": 0.92 },
    { "index": 3, "relevance_score": 0.87 }
  ],
  "total_tokens": 1234
}
```

### Result Mapping

The reranker maps Voyage AI's `index` back to the candidate's `file` (document ID) to create a `Map<string, number>` of ID u2192 relevance score. This map is passed to `positionAwareBlend()`.

### Error Handling

- HTTP errors: logs warning, returns empty results (search continues without reranking)
- Network errors: caught and logged, returns empty results
- Invalid response shape: logged, returns empty results
- Never throws u2014 reranking failure degrades gracefully to RRF-only ranking

### Caching in Search Pipeline

**Source:** `src/search.ts` (lines 659u2013694)

- **Cache key:** `computeHash('rerank:' + query + ':' + candidateIds.join(','))`
- **Cache scope:** per `projectHash`
- **Cache type:** `'rerank'`
- Stores `[{ file, score }]` as JSON
- On cache hit: deserializes and populates `rerankScores` map directly

## 9. Position-Aware Blending

PLACEHOLDER

## 10. Score Boosting & Demotion Pipeline

**Source:** `src/search.ts` (lines 185u2013345, 628u2013653)

After RRF fusion, eight score adjustments are applied in strict order. Each function is pure (creates new arrays) and the pipeline is sequential.

### Adjustment 1: Top-Rank Bonus (`applyTopRankBonus`)

**Source:** lines 185u2013207

Boosts the top-3 FTS results from the **original query only** (not expansion variants):

| FTS Rank | Bonus |
|----------|-------|
| #1 | +0.05 |
| #2 | +0.02 |
| #3 | +0.02 |

Formula: `newScore = rrfScore + bonus`

Rationale: FTS top results have high lexical relevance and deserve a nudge in the fused ranking.

### Adjustment 2: Centrality Boost (`applyCentralityBoost`)

**Source:** lines 248u2013261

Boosts documents with high graph centrality (PageRank-like metric stored in the `documents` table).

Formula: `newScore = score * (1 + centrality_weight * centrality)`

- `centrality_weight` default: **0.1**
- `centrality` is a 0u20131 value from the document graph
- Only applied if `centrality > 0`

### Adjustment 3: Usage Boost (`applyUsageBoost`)

**Source:** lines 291u2013312

Boosts documents that have been accessed frequently, with temporal decay.

Formula:
```
decayScore = 1 / (1 + daysSinceAccess / halfLifeDays)
boost = log2(1 + accessCount) * decayScore * weight
newScore = score * (1 + boost)
```

- `usageBoostWeight` default: **0.15** (clamped 0u20131)
- `decayHalfLifeDays` default: **30**
- `accessCount = 0` u2192 no boost (skipped entirely)
- Uses `lastAccessedAt` with fallback to `createdAt`
- `computeDecayScore()` returns 0.5 for invalid dates as a safe fallback

### Adjustment 4: Category Weight Boost (`applyCategoryWeightBoost`)

**Source:** lines 314u2013345

Multiplies score by tag-based category weights.

- Only processes tags prefixed with `auto:` or `llm:` (auto-generated category tags)
- Uses the **maximum** weight among matching tags (not sum)
- Default weight = 1.0 (no change) if no matching tags
- Only applied if `categoryWeights` is non-empty in options

### Adjustment 5: Supersede Demotion (`applySupersedeDemotion`)

**Source:** `src/search.ts`

Demotes documents that have been superseded by newer versions.

Formula: `newScore = score * demotionFactor`

- `supersede_demotion` default: **0.05** (95% penalty — effectively buries superseded docs)
- Only applied if `supersededBy !== undefined && supersededBy !== null`
- The `supersedeDocument(oldId, newId)` call now correctly receives the new doc's actual ID (was passing `0` — bug fixed 2026-05-05)

### Adjustment 6: Length Normalization (`applyLengthNorm`)

**Source:** `src/search.ts`

Penalizes large documents to prevent size bias in BM25 scoring.

Formula:
```
penalty = 1 / (1 + log2(max(1, charLength / anchor)))
newScore = score * penalty
```

- `length_norm_anchor` default: **2000** chars
- `charLength` = `LENGTH(body)` from SQLite (full content, not snippet)
- Doc ≤ 2000 chars → penalty = 1.0 (no change)
- Doc 8000 chars → penalty ≈ 0.5
- Doc 32000 chars → penalty ≈ 0.25
- Applied after supersede demotion, before recency boost

### Adjustment 7: Recency Boost (`applyRecencyBoost`)

**Source:** `src/search.ts`

Boosts recently created documents via exponential decay. Only applies to `sessions` and `memory` collections — `codebase` results are never affected.

Formula:
```
ageDays     = (now - createdAt) / 86_400_000
decayFactor = exp(-ln(2) × ageDays / halfLife)
newScore    = score × (1 - weight) + score × weight × decayFactor
```

- `recency_weight` default: **0.3** — 30% of score is modulated by age
- `recency_half_life_days` default: **180** — score contribution halves every 6 months
- `createdAt` sourced from `documents.created_at` (populated through FTS, vector, and worker paths)
- Results without `createdAt` are skipped (no boost, no penalty)
- `codebase` collection: explicitly guarded — recency does not apply to code

### Adjustment 8: Importance Scoring (`importanceScorer.applyBoost`)

**Source:** `src/importance.ts:applyBoost()` (line 35)

Formula: `newScore = score * (1 + importance_weight * importanceScore)`

- See Section 13 for the full importance scoring algorithm
- Only applied if an `importanceScorer` is provided and `importanceScore > 0`

### Execution Order

```
RRF fused scores (with createdAt + charLength preserved)
  → applyTopRankBonus        (additive, FTS top-3 only)
  → applyCentralityBoost     (multiplicative, graph centrality)
  → applyUsageBoost          (multiplicative, access count + decay)
  → applyCategoryWeightBoost (multiplicative, tag weights)
  → applySupersedeDemotion   (multiplicative, ×0.05 penalty)
  → applyLengthNorm          (multiplicative, log2 size penalty)
  → applyRecencyBoost        (multiplicative, sessions+memory only)
  → importanceScorer.applyBoost (multiplicative, importance)
  → sort descending
  → slice to topK candidates
```

## 11. Thompson Sampling (Bandits)

PLACEHOLDER

## 12. Intent Classification

PLACEHOLDER

## 13. Importance Scoring

PLACEHOLDER

## 14. Caching Architecture

PLACEHOLDER

## 15. Code Intelligence

PLACEHOLDER

## 16. Memory Graph

PLACEHOLDER

## 17. FTS Worker Architecture

PLACEHOLDER

## 18. Search Telemetry

PLACEHOLDER

## 19. Eval/Benchmark Framework

PLACEHOLDER

## 20. Configuration & Defaults

PLACEHOLDER
