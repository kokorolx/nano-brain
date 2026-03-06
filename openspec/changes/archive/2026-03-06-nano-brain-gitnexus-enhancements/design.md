## Context

nano-brain is a persistent memory system for AI agents, built as an MCP server (stdio) + CLI in TypeScript/Node.js (ESM). It uses better-sqlite3 for storage, sqlite-vec/Qdrant for vector search, and exposes search/query tools via MCP.

Currently, the codebase indexer (`src/codebase.ts`) scans files, chunks them, and stores them as documents. The graph layer (`src/graph.ts`) parses imports via regex and builds a file-level dependency graph stored in the `file_edges` table. Louvain clustering and PageRank run on this file graph. Infrastructure symbols (Redis keys, MySQL tables, API endpoints, Bull queues) are extracted via regex in `src/symbols.ts` and stored in the `symbols` table.

After analyzing GitNexus, we identified that symbol-level granularity (function→function CALLS, class EXTENDS) unlocks impact analysis, 360-degree context, and execution flow tracing — capabilities that make AI agents significantly more reliable when editing code.

## Goals / Non-Goals

**Goals:**
- Extract code symbols (functions, classes, methods, interfaces) from source files using Tree-sitter AST parsing
- Build a symbol-level knowledge graph with typed edges (CALLS, IMPORTS, EXTENDS, IMPLEMENTS) and confidence scoring
- Detect execution flows by tracing call chains from entry points
- Expose `context`, `impact`, and `detect_changes` MCP tools
- Keep existing infrastructure symbol extraction (Redis, MySQL, etc.) — layer code symbols on top
- Incremental indexing: only re-parse changed files

**Non-Goals:**
- Replacing the existing file-level graph (keep it, symbol graph is additive)
- Supporting all 12 languages GitNexus supports (start with TS/JS/Python — the languages nano-brain already handles)
- Building a web UI or visualization layer
- Cypher query language support (use SQL against SQLite instead)
- Wiki generation

## Decisions

### 1. Tree-sitter via `tree-sitter` npm package (native bindings)

**Choice:** Use `tree-sitter` + `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python` npm packages.

**Alternatives considered:**
- **Regex parsing (current approach):** Already used for imports. Cannot reliably extract function bodies, class hierarchies, or call sites. Too fragile for symbol-level graph.
- **TypeScript Compiler API:** Only works for TS/JS. Heavy dependency. Slow for large codebases.
- **Tree-sitter WASM:** Slower than native bindings. nano-brain runs server-side, so native is fine.

**Rationale:** Tree-sitter is the industry standard for multi-language AST parsing. Native bindings are fast. GitNexus validates this approach at scale. Start with TS/JS/Python grammars — same languages nano-brain already supports for import parsing.

### 2. SQLite tables for symbol graph (not a separate graph DB)

**Choice:** Store symbol nodes and edges in new SQLite tables (`code_symbols`, `symbol_edges`) alongside existing tables.

**Alternatives considered:**
- **KuzuDB (what GitNexus uses):** Adds a heavy native dependency. Overkill for our query patterns (we don't need Cypher).
- **Separate SQLite database:** Complicates transactions and joins with existing document/chunk data.
- **In-memory graph only:** Loses persistence. Must rebuild on every server start.

**Rationale:** nano-brain already uses better-sqlite3 with WAL mode. SQL with proper indexes handles our query patterns (find callers, find callees, traverse N hops) efficiently. Keeps the single-database architecture. Joins with existing `documents` and `symbols` tables are trivial.

### 3. Confidence scoring via heuristics (not ML)

**Choice:** Assign confidence scores to edges based on parsing certainty:
- Direct AST-resolved call: 1.0
- Import-resolved call: 0.9
- Same-file unresolved call: 0.8
- Cross-file heuristic match: 0.7
- Dynamic/computed call: 0.5

**Rationale:** ML-based confidence would require training data and add complexity. Heuristic scoring (like GitNexus) is sufficient and deterministic.

### 4. BFS-based flow detection with configurable depth

**Choice:** Detect execution flows by:
1. Finding entry points (exported functions with no internal callers, API route handlers, CLI commands)
2. BFS forward through CALLS edges up to configurable max depth (default: 10)
3. Label flows heuristically from entry/terminal symbol names

**Rationale:** Matches GitNexus's proven approach. BFS is simple, predictable, and fast on a graph stored in SQLite with proper indexes.

### 5. New MCP tools as separate handler functions

**Choice:** Add `context`, `impact`, and `detect_changes` as new MCP tool registrations in `src/server.ts`, with query logic in a new `src/symbol-graph.ts` module.

**Rationale:** Keeps MCP tool registration centralized. Query logic is isolated and testable. Follows existing pattern in server.ts.

### 6. Incremental parsing via content hash comparison

**Choice:** Store `content_hash` per symbol source file. On re-index, skip files whose hash hasn't changed. For changed files: delete all symbols/edges for that file, re-parse, re-insert.

**Rationale:** Simple and correct. Avoids complex diff-based incremental updates. File-level granularity is sufficient — Tree-sitter parsing is fast enough that re-parsing a single changed file is <50ms.

## Risks / Trade-offs

- **Tree-sitter native bindings may have build issues on some platforms** → Mitigation: Use prebuilt binaries where available. Fall back gracefully to regex-only parsing if Tree-sitter fails to load (degrade, don't crash).
- **Symbol graph size for large codebases (10k+ files) could be significant** → Mitigation: Lazy indexing (only index on demand or on file change). Storage budget check before indexing. Estimate: ~100 bytes per symbol, ~50 bytes per edge. 50k symbols + 200k edges ≈ 15MB.
- **BFS flow detection could be slow on highly connected graphs** → Mitigation: Max depth limit (default 10), max branching factor (default 4), max processes (default 75). Same limits GitNexus uses.
- **Adding 3 new MCP tools increases server complexity** → Mitigation: Query logic isolated in `src/symbol-graph.ts`. Tools are read-only. No state mutation beyond indexing.
- **Call resolution across files is inherently imperfect** → Mitigation: Confidence scoring makes uncertainty explicit. Agents can filter by confidence threshold.
