# Roo Code Codebase Indexing — Architecture Analysis

**Date**: 2026-03-08
**Source**: [`RooCodeInc/Roo-Code`](https://github.com/RooCodeInc/Roo-Code) (Apache-2.0)
**Module**: `src/services/code-index/`
**Purpose**: Evaluate Roo Code's Qdrant-based code indexing for ideas applicable to nano-brain

---

## 1. Architecture Overview

Roo Code implements a 7-component pipeline for semantic code search:

| Component | File | Role |
|---|---|---|
| **CodeParser** | `processors/parser.ts` | Tree-sitter AST → semantic CodeBlocks |
| **DirectoryScanner** | `processors/scanner.ts` | Walks workspace, batches, concurrency control |
| **Embedder** (8 providers) | `embedders/*.ts` | OpenAI, Ollama, Gemini, Mistral, Bedrock, OpenRouter, Vercel AI, OpenAI-compatible |
| **QdrantVectorStore** | `vector-store/qdrant-client.ts` | Qdrant CRUD + search |
| **CacheManager** | `cache-manager.ts` | SHA-256 file hash cache for incremental updates |
| **FileWatcher** | `processors/file-watcher.ts` | VS Code FS watcher for real-time re-indexing |
| **Orchestrator** | `orchestrator.ts` | Coordinates full pipeline lifecycle |

### Data Flow

```
Files → CodeParser (tree-sitter) → CodeBlocks → Embedder → Vectors → Qdrant
                                                                        ↑
Query → Embedder → Query Vector → Qdrant.search() → Results ──────────┘
```

---

## 2. Chunking Strategy (Tree-sitter AST)

This is the most interesting component. Roo Code uses **tree-sitter** to parse code into AST nodes, then applies size-based rules to create chunks that respect semantic boundaries.

### Constants

```typescript
MAX_BLOCK_CHARS = 1000       // target max chunk size
MIN_BLOCK_CHARS = 50         // skip tiny nodes
MAX_CHARS_TOLERANCE = 1.15   // 15% tolerance → effective max = 1150 chars
MIN_CHUNK_REMAINDER = 200    // prevents tiny trailing chunks
```

### Algorithm

1. Parse file with tree-sitter → get AST captures (functions, classes, methods)
2. For each captured node:
   - If `chars ≥ 50` AND `chars ≤ 1150` → create block directly
   - If `chars > 1150` AND has children → recurse into children
   - If `chars > 1150` AND is leaf → line-based chunking with re-balancing
   - If `chars < 50` → skip entirely
3. If no AST captures found AND content ≥ 50 chars → fallback to line-based chunking
4. **Markdown**: special parser extracts header sections as semantic blocks
5. **Dedup**: SHA-256 segment hashes prevent duplicate blocks from overlapping AST nodes

### Fallback Languages

Some languages use line-based chunking instead of tree-sitter:
- `.vb` (Visual Basic .NET — no WASM parser)
- `.scala` (parser instability)
- `.swift` (parser instability)

### CodeBlock Schema

```typescript
interface CodeBlock {
  file_path: string
  identifier: string | null  // function/class name from AST
  type: string               // AST node type (function_definition, class_declaration, etc.)
  start_line: number
  end_line: number
  content: string
  fileHash: string           // SHA-256 of entire file
  segmentHash: string        // SHA-256 of block identity (path + lines + size + preview)
}
```

---

## 3. Qdrant Collection Schema

### Collection Naming

```
ws-{sha256(workspacePath).substring(0, 16)}
```

One collection per workspace, deterministic name from path hash.

### Vector Configuration

```
Distance: Cosine
Vectors: on_disk = true
HNSW: m = 64, ef_construct = 512, on_disk = true
```

### Point Structure

```typescript
{
  id: UUIDv5(segmentHash, NAMESPACE),  // deterministic from content
  vector: number[],                     // embedding (size varies by model)
  payload: {
    filePath:     string,    // relative path from workspace root
    codeChunk:    string,    // actual code content
    startLine:    number,
    endLine:      number,
    segmentHash:  string,
    pathSegments: {          // path split by separator for directory filtering
      "0": "src",
      "1": "utils",
      "2": "auth.ts"
    },
    type:         string     // "metadata" for indexing status markers only
  }
}
```

### Payload Indexes

- `type` (keyword) — filters out metadata points during search
- `pathSegments.0` through `pathSegments.4` (keyword) — enables directory-scoped search

The **pathSegments** pattern is clever: it enables directory-scoped search via Qdrant payload filters without needing full-text path matching. Query for "files in src/utils/" becomes `must: [{key: "pathSegments.0", match: {value: "src"}}, {key: "pathSegments.1", match: {value: "utils"}}]`.

---

## 4. Search Pipeline

```typescript
// 1. Embed the query
const vector = await embedder.createEmbeddings([query])

// 2. Build filter (optional directory scope + exclude metadata)
const filter = {
  must: pathSegments.map((seg, i) => ({
    key: `pathSegments.${i}`,
    match: { value: seg }
  })),
  must_not: [{ key: "type", match: { value: "metadata" } }]
}

// 3. Search Qdrant
const results = await client.query(collection, {
  query: vector,
  filter,
  score_threshold: configurable,  // default from CODEBASE_INDEX_DEFAULTS
  limit: configurable,
  params: { hnsw_ef: 128, exact: false },
  with_payload: {
    include: ["filePath", "codeChunk", "startLine", "endLine", "pathSegments"]
  }
})
```

### Notable Limitations

- **No reranking** — pure vector similarity, first-pass results are final
- **No hybrid search** — semantic only, no BM25/keyword component
- **No cross-file awareness** — each chunk is independent, no relationship tracking
- **No query expansion** — single query vector, no variants

---

## 5. Performance Engineering

### Batching & Concurrency

| Parameter | Value | Purpose |
|---|---|---|
| `BATCH_SEGMENT_THRESHOLD` | 60 | Segments per embedding batch |
| `MAX_BATCH_TOKENS` | 100,000 | OpenAI batch token limit |
| `MAX_ITEM_TOKENS` | 8,191 | Per-item token limit |
| `PARSING_CONCURRENCY` | 10 | Parallel file parsing (pLimit) |
| `BATCH_PROCESSING_CONCURRENCY` | 10 | Parallel batch upserts (pLimit) |
| `MAX_PENDING_BATCHES` | 20 | Backpressure — wait when saturated |
| `MAX_BATCH_RETRIES` | 3 | Exponential backoff (500ms base) |
| `MAX_FILE_SIZE_BYTES` | 1 MB | Skip larger files |
| `MAX_LIST_FILES_LIMIT` | 50,000 | Max files to scan |

### Incremental Updates

- **CacheManager** stores `{filePath: sha256Hash}` in a JSON file
- On scan: compare current file hash vs cached → skip unchanged files
- On file change (watcher): re-parse, delete old Qdrant points, upsert new
- On file delete: delete points by pathSegments filter
- **Debounced cache writes** (1500ms) prevent I/O thrashing during bulk indexing
- **Indexing completion marker**: special metadata point in Qdrant with `indexing_complete: true/false`

### Embedding Providers (8 supported)

1. OpenAI (default: `text-embedding-3-small`)
2. Ollama (local)
3. OpenAI-compatible (custom endpoint)
4. Gemini (max 2048 tokens per item)
5. Mistral
6. Vercel AI Gateway
7. AWS Bedrock
8. OpenRouter

---

## 6. Comparison with nano-brain

### Where Roo Code is Better

| Area | Roo Code | nano-brain | Gap |
|---|---|---|---|
| **Chunking** | Tree-sitter AST boundaries | Regex heuristic breakpoints | **Significant** — nano-brain splits at blank lines/function patterns, may cut functions in half |
| **Parallel embedding** | 10 concurrent batches + backpressure | Sequential, one batch at a time | **Moderate** — slower initial indexing |

### Where nano-brain is Already Ahead

| Area | nano-brain | Roo Code |
|---|---|---|
| **Search quality** | Hybrid (BM25 + vector + RRF fusion + LLM reranking + query expansion + centrality boost) | Pure vector similarity only |
| **Dependency graph** | File-level import graph + PageRank + Louvain clustering | None |
| **Symbol analysis** | Tree-sitter symbol extraction + call graph + heritage edges + flow detection | None |
| **Cross-repo analysis** | Redis keys, PubSub channels, MySQL tables, API endpoints, Bull queues | None |
| **Session persistence** | SQLite + memory collection across sessions | Ephemeral per-workspace |
| **Cache mechanism** | SQLite WAL (transactional, crash-safe) | JSON file with debounce (can lose data on crash) |
| **Deduplication** | `hash:seq` per-document tracking | Segment hash per-block |

### Key Insight

nano-brain already uses tree-sitter in `treesitter.ts` for **symbol graph** extraction (function names, call edges, class heritage). But it does NOT use tree-sitter for **chunking**. The chunker (`chunker.ts`) uses regex-based breakpoint detection instead.

**The tree-sitter infrastructure is 80% there — it just needs to be wired into the chunking pipeline.**

---

## 7. Actionable Recommendations

### HIGH IMPACT: AST-Aware Chunking for Embeddings

**Problem**: Current `chunkSourceCode()` uses regex patterns to find break points (`/^export\s+function/`, blank lines, etc.). This is heuristic — it can split a function body in half at a blank line, producing chunks that are semantically incomplete.

**Solution**: Add a `chunkWithTreeSitter()` path that:
1. Parses with existing tree-sitter init (already in `treesitter.ts`)
2. Extracts AST nodes (functions, classes, methods) as chunk boundaries
3. Applies size limits similar to Roo Code (min 50, max ~1000-3600 chars)
4. Falls back to current regex chunking for unsupported languages
5. Prepends metadata header (file path, language, line range) as nano-brain already does

**Expected improvement**:
- Each chunk = one complete semantic unit (function, class, method)
- Better embedding quality → better vector similarity scores
- More precise search results (hit returns a complete unit, not a fragment)
- Reduced noise from overlap regions splitting logical units

**Effort**: Medium. Tree-sitter is already initialized and working. Need to:
- Add AST-based chunk extraction in `chunker.ts`
- Wire it into `codebase.ts` `indexCodebase()` flow
- Keep regex fallback for non-tree-sitter languages
- Re-embed affected documents (one-time cost)

### MEDIUM IMPACT: Parallel Batch Embedding

**Problem**: `embedPendingCodebase()` processes one batch at a time with `setImmediate` yields. For large codebases (2000+ files), initial indexing is slow.

**Solution**: Add `pLimit`-based concurrent batch processing with backpressure (similar to Roo Code's `MAX_PENDING_BATCHES` pattern).

**Effort**: Medium. Requires refactoring the embedding loop.

### LOW IMPACT (Skip Unless Needed)

- **pathSegments directory filtering** — not needed unless we add directory-scoped MCP search
- **Indexing completion markers** — SQLite per-document tracking is already superior
- **Debounced cache writes** — SQLite WAL already handles this
- **Segment hash dedup** — already solved by `hash:seq` scheme

---

## 8. Files Referenced

### Roo Code (cloned to `./Roo-Code`)

- `src/services/code-index/processors/parser.ts` — Tree-sitter chunking logic
- `src/services/code-index/processors/scanner.ts` — Directory scanning + batching
- `src/services/code-index/vector-store/qdrant-client.ts` — Qdrant integration
- `src/services/code-index/search-service.ts` — Search pipeline
- `src/services/code-index/orchestrator.ts` — Pipeline coordination
- `src/services/code-index/constants/index.ts` — All tuning parameters
- `src/services/code-index/embedders/openai.ts` — OpenAI embedder with batching
- `src/services/code-index/cache-manager.ts` — File hash cache
- `src/services/code-index/service-factory.ts` — Dependency injection
- `src/services/code-index/interfaces/` — All TypeScript interfaces

### nano-brain

- `src/chunker.ts` — Current regex-based chunking (target for improvement)
- `src/treesitter.ts` — Tree-sitter symbol extraction (already initialized)
- `src/codebase.ts` — Codebase indexing pipeline
- `src/search.ts` — Hybrid search with RRF + reranking
- `src/providers/qdrant.ts` — Qdrant vector store
- `src/vector-store.ts` — Vector store interface
