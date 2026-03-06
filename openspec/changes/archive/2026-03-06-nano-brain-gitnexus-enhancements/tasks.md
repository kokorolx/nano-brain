## 1. Dependencies & Schema Setup

- [x] 1.1 Add tree-sitter, tree-sitter-typescript, tree-sitter-javascript, tree-sitter-python to package.json dependencies
- [x] 1.2 Create SQLite schema for `code_symbols` table (id, name, kind, file_path, start_line, end_line, exported, content_hash, project_hash) and `symbol_edges` table (source_id, target_id, edge_type, confidence, project_hash) in `src/store.ts`
- [x] 1.3 Add indexes on `code_symbols(file_path, project_hash)`, `code_symbols(name, kind)`, `symbol_edges(source_id)`, `symbol_edges(target_id)`, `symbol_edges(edge_type)`
- [x] 1.4 Create `execution_flows` table (id, label, flow_type, entry_symbol_id, terminal_symbol_id, step_count, project_hash) and `flow_steps` table (flow_id, symbol_id, step_index) in `src/store.ts`

## 2. Tree-sitter Parser Module

- [x] 2.1 Create `src/treesitter.ts` module with Tree-sitter initialization and graceful fallback (log warning if native bindings fail to load, export `isTreeSitterAvailable()`)
- [x] 2.2 Implement `parseSymbols(filePath, content, language)` function that extracts functions, classes, methods, and interfaces from AST — returns `CodeSymbol[]` with name, kind, startLine, endLine, exported flag
- [x] 2.3 Write Tree-sitter queries for TypeScript/JavaScript: function declarations, arrow functions, class declarations, method definitions, interface declarations
- [x] 2.4 Write Tree-sitter queries for Python: function definitions (def), class definitions, method definitions (def inside class)
- [x] 2.5 Implement `resolveCallEdges(filePath, content, language, symbolTable)` function that extracts call expressions from AST and resolves them to target symbols using import map + same-file scope, returning edges with confidence scores
- [x] 2.6 Implement `resolveHeritageEdges(filePath, content, language, symbolTable)` function that extracts extends/implements clauses and resolves them to target symbols, returning EXTENDS/IMPLEMENTS edges with confidence 1.0
- [x] 2.7 Add unit tests for `parseSymbols` with TS, JS, and Python fixtures
- [x] 2.8 Add unit tests for `resolveCallEdges` and `resolveHeritageEdges` with multi-file fixtures

## 3. Symbol Graph Indexing Pipeline

- [x] 3.1 Create `src/symbol-graph.ts` module with `SymbolGraph` class that wraps SQLite queries for inserting/querying symbols and edges
- [x] 3.2 Implement `indexSymbolGraph(store, workspaceRoot, projectHash)` function in `src/codebase.ts` that: scans files, parses symbols via Tree-sitter, resolves edges, stores in SQLite. Support incremental indexing via content hash comparison.
- [x] 3.3 Wire symbol graph indexing into the existing `indexCodebase()` pipeline — run after file-level indexing, skip if Tree-sitter unavailable
- [x] 3.4 Implement `deleteSymbolsForFile(store, filePath, projectHash)` for incremental re-indexing of changed files
- [x] 3.5 Implement `getSymbolByName(store, name, projectHash, filePath?)` with disambiguation support (return candidates if multiple matches)
- [x] 3.6 Implement `getSymbolEdges(store, symbolId, direction, edgeTypes?, minConfidence?)` for querying incoming/outgoing edges
- [x] 3.7 Add integration test: index a small multi-file TS project, verify symbols and edges are correctly stored and queryable

## 4. Community Detection Upgrade

- [x] 4.1 Extend existing Louvain clustering in `src/graph.ts` to optionally run on symbol-level edges (CALLS graph) in addition to file-level edges
- [x] 4.2 Store cluster assignments in `code_symbols` table (add `cluster_id` column) and generate heuristic cluster labels from dominant symbol names/file paths
- [x] 4.3 Add test: verify symbol-level clustering produces meaningful groupings on a multi-module fixture

## 5. Execution Flow Detection

- [x] 5.1 Implement `detectEntryPoints(store, projectHash)` function that identifies symbols with no internal callers + exported + matching entry point patterns (route handlers, CLI commands)
- [x] 5.2 Implement `traceFlows(store, entryPoints, config)` function that BFS-traces from entry points through CALLS edges, respecting maxDepth (10), maxBranching (4), maxProcesses (75), minSteps (3)
- [x] 5.3 Implement flow labeling: generate human-readable labels from entry/terminal symbol names (e.g., "HandleLogin -> CreateSession")
- [x] 5.4 Implement flow classification: `intra_community` vs `cross_community` based on cluster membership of flow steps
- [x] 5.5 Store detected flows in `execution_flows` and `flow_steps` tables
- [x] 5.6 Wire flow detection into the indexing pipeline — run after symbol graph indexing and clustering
- [x] 5.7 Add test: verify flow detection on a fixture with known call chains produces expected flows

## 6. MCP Tools — Context

- [x] 6.1 Implement `handleContext(store, params)` query function in `src/symbol-graph.ts`: given symbol name (+ optional file_path), return 360-degree view — metadata, incoming edges, outgoing edges, cluster label, flow participation, connected infrastructure symbols
- [x] 6.2 Register `context` MCP tool in `src/server.ts` with input schema: `{ name: string, file_path?: string, project_hash?: string }`
- [x] 6.3 Handle disambiguation: if multiple symbols match, return candidate list with file paths and kinds
- [x] 6.4 Add test: verify context tool returns correct callers, callees, cluster, and flows for a known symbol

## 7. MCP Tools — Impact

- [x] 7.1 Implement `handleImpact(store, params)` query function in `src/symbol-graph.ts`: BFS traversal from target symbol in specified direction, group results by depth, compute risk level
- [x] 7.2 Register `impact` MCP tool in `src/server.ts` with input schema: `{ target: string, direction: "upstream"|"downstream", maxDepth?: number, minConfidence?: number, file_path?: string }`
- [x] 7.3 Implement risk assessment: LOW (0-2 direct deps, 0 flows), MEDIUM (3-5 direct deps or 1-2 flows), HIGH (6-9 direct deps or 2-3 flows), CRITICAL (10+ direct deps or 3+ flows)
- [x] 7.4 Include affected execution flows in impact results (flow name + step position)
- [x] 7.5 Add test: verify impact analysis returns correct depth groupings and risk levels

## 8. MCP Tools — Detect Changes

- [x] 8.1 Implement `handleDetectChanges(store, params)` function: run `git diff` (or `git diff --cached` for staged), parse changed file paths and line ranges, map to affected symbols and flows
- [x] 8.2 Register `detect_changes` MCP tool in `src/server.ts` with input schema: `{ scope?: "unstaged"|"staged"|"all", project_hash?: string }`
- [x] 8.3 Handle edge cases: no git repo, no changes, changed files not in symbol graph
- [x] 8.4 Add test: verify detect_changes correctly maps a file change to affected symbols and flows

## 9. Search Enrichment

- [x] 9.1 Modify `hybridSearch` in `src/search.ts` to optionally enrich results with symbol-level metadata (symbol names, cluster label, flow count) when symbol graph is available
- [x] 9.2 Ensure backward compatibility: if symbol graph is not available, search results are returned as-is
- [x] 9.3 Add test: verify search results include symbol enrichment when graph is available and omit it when not

## 10. Integration & Validation

- [x] 10.1 Run full indexing pipeline on nano-brain's own codebase, verify symbols, edges, clusters, and flows are generated correctly
- [x] 10.2 Test all 3 new MCP tools via MCP inspector or manual stdio interaction
- [x] 10.3 Verify existing MCP tools (query, search, status) still work correctly with no regressions
- [x] 10.4 Run existing test suite — all tests must pass
- [x] 10.5 Performance check: full index of nano-brain codebase completes in <30 seconds, individual MCP tool queries respond in <100ms
