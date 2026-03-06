## Why

nano-brain's codebase graph operates at file-level only (import edges between files). After analyzing GitNexus — a knowledge graph tool that indexes codebases at symbol-level (function→function CALLS, class EXTENDS, etc.) — it's clear that symbol-level granularity unlocks three high-value capabilities nano-brain currently lacks: impact analysis ("what breaks if I change X?"), 360-degree symbol context, and execution flow tracing. These are the features that make AI agents actually reliable when editing code. nano-brain already has the infrastructure (graph, clustering, PageRank, MCP server) — it just needs to go one level deeper.

## What Changes

- **Add Tree-sitter AST parsing** to extract code symbols (functions, classes, methods, interfaces) from source files, replacing regex-only import parsing for structural analysis.
- **Build a symbol-level knowledge graph** alongside the existing file-level graph. Nodes: functions, classes, methods, interfaces. Edges: CALLS, IMPORTS, EXTENDS, IMPLEMENTS — each with confidence scoring (0–1).
- **Add execution flow detection** — trace call chains from entry points (API handlers, CLI commands, event listeners) through the codebase via BFS to identify processes/flows.
- **Upgrade community detection** from file-level Louvain to symbol-level clustering, producing functional groupings like "Authentication", "Payment Processing".
- **Expose 3 new MCP tools**: `context` (360-degree symbol view), `impact` (blast radius analysis), and `detect_changes` (git diff → affected symbols/flows).
- **Hybrid infrastructure + code graph** — keep nano-brain's unique infrastructure symbol extraction (Redis keys, MySQL tables, API endpoints, Bull queues) AND layer code structure symbols on top. The combination is more powerful than either alone.

## Capabilities

### New Capabilities
- `symbol-graph`: Tree-sitter AST parsing, symbol extraction, symbol-level knowledge graph with typed edges and confidence scoring
- `impact-analysis`: Blast radius analysis — given a symbol, return what breaks at depth 1/2/3 with confidence, affected flows, and affected clusters
- `context-tool`: 360-degree symbol view MCP tool — callers, callees, cluster membership, process participation, infrastructure symbol connections
- `flow-detection`: Execution flow tracing from entry points through call chains, process labeling

### Modified Capabilities
- `search-pipeline`: Search results enriched with symbol-level context (cluster, process participation, callers/callees count) in addition to existing file-level results

## Impact

- **Code**: `src/graph.ts` (major — add Tree-sitter parsing, symbol graph), `src/codebase.ts` (add symbol extraction pipeline), `src/search.ts` (enrich results), `src/server.ts` (new MCP tools)
- **Dependencies**: New dep on `tree-sitter` + language grammar packages (tree-sitter-typescript, tree-sitter-javascript, tree-sitter-python, etc.)
- **Storage**: Symbol graph stored in SQLite alongside existing chunk/document tables. Expect 5-10x more rows than file-level graph for large codebases.
- **Performance**: Tree-sitter parsing adds indexing time. Must be incremental (only re-parse changed files). Runtime queries against symbol graph must stay <100ms.
- **APIs**: 3 new MCP tools added. Existing tools unchanged (backward compatible).
