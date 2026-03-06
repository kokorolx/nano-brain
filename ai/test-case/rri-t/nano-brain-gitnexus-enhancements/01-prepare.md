# RRI-T Phase 1: PREPARE

**Feature:** nano-brain-gitnexus-enhancements  
**Date:** 2026-03-06  
**Type:** Backend TypeScript Library (MCP Server + CLI)

---

## 1. Feature Overview

The nano-brain-gitnexus-enhancements feature adds symbol-level code intelligence capabilities to nano-brain, inspired by GitNexus. It transforms nano-brain from a file-level indexer into a symbol-aware knowledge graph system.

---

## 2. Five Core Capabilities

### C1: Tree-sitter AST Parsing
- Uses Tree-sitter native bindings to parse TypeScript, JavaScript, and Python files
- Extracts code symbols: functions, classes, methods, interfaces
- Captures metadata: name, kind, file path, start/end lines, export status
- Graceful fallback to regex-only parsing if Tree-sitter fails to load

### C2: Symbol-level Knowledge Graph
- Stores symbols in `code_symbols` table, edges in `symbol_edges` table
- Typed edges: CALLS, IMPORTS, EXTENDS, IMPLEMENTS
- Confidence scoring (0.5-1.0) based on resolution certainty:
  - Direct AST-resolved: 1.0
  - Import-resolved: 0.9
  - Same-file unresolved: 0.8
  - Cross-file heuristic: 0.7
  - Dynamic/computed: 0.5
- Coexists with existing infrastructure symbols (Redis, MySQL, etc.)

### C3: Impact Analysis (`impact` MCP tool)
- Computes blast radius for a symbol (upstream/downstream)
- Returns affected symbols grouped by traversal depth
- Includes risk assessment: LOW, MEDIUM, HIGH, CRITICAL
- Supports maxDepth and minConfidence filters
- Lists affected execution flows

### C4: Context Tool (`context` MCP tool)
- Provides 360-degree symbol view
- Returns: metadata, incoming refs (callers), outgoing refs (callees), cluster membership, flow participation
- Handles ambiguous symbol names with disambiguation list
- Supports file_path parameter for disambiguation
- Shows connected infrastructure symbols

### C5: Flow Detection & Change Detection
- Detects execution flows from entry points via BFS
- Entry points: exported functions with no internal callers, route handlers
- Configurable max depth (default: 10) and branching limit (default: 4)
- Labels flows heuristically from entry/terminal names
- Classifies flows: intra_community vs cross_community
- `detect_changes` MCP tool maps git diff to affected symbols and flows

---

## 3. Key Requirements from Specs

### Symbol Graph (symbol-graph/spec.md)
| ID | Requirement | Testable Scenario |
|----|-------------|-------------------|
| SG-1 | Tree-sitter extracts symbols from TS/JS/Python | Index a TS file, verify symbols extracted |
| SG-2 | Unsupported languages fall back to regex | Index a .go file, verify no crash |
| SG-3 | Tree-sitter failure degrades gracefully | Simulate load failure, verify regex works |
| SG-4 | CALLS edges created with confidence >= 0.7 | Function A calls B, verify edge exists |
| SG-5 | EXTENDS edges have confidence 1.0 | Class A extends B, verify edge |
| SG-6 | IMPLEMENTS edges have confidence 1.0 | Class implements interface, verify edge |
| SG-7 | Incremental indexing skips unchanged files | Re-index unchanged file, verify skip |
| SG-8 | Changed files are re-parsed | Modify file, verify symbols updated |
| SG-9 | Deleted files have symbols removed | Delete file, verify cleanup |
| SG-10 | Code symbols coexist with infra symbols | File with both, verify both extracted |

### Impact Analysis (impact-analysis/spec.md)
| ID | Requirement | Testable Scenario |
|----|-------------|-------------------|
| IA-1 | Upstream impact returns callers by depth | Query upstream, verify depth grouping |
| IA-2 | Downstream impact returns callees | Query downstream, verify results |
| IA-3 | maxDepth limits traversal | Set maxDepth=2, verify limit |
| IA-4 | minConfidence filters edges | Set minConfidence=0.8, verify filter |
| IA-5 | Risk assessment included | Verify LOW/MEDIUM/HIGH/CRITICAL |
| IA-6 | Affected flows listed | Symbol in flow, verify flow listed |

### Context Tool (context-tool/spec.md)
| ID | Requirement | Testable Scenario |
|----|-------------|-------------------|
| CT-1 | 360-degree view returned | Query symbol, verify all sections |
| CT-2 | Ambiguous names return disambiguation | Query "handle", verify list |
| CT-3 | Infrastructure connections shown | Symbol uses redis, verify shown |
| CT-4 | Not found returns clear message | Query nonexistent, verify message |
| CT-5 | file_path disambiguates | Same name in 2 files, use file_path |

### Flow Detection (flow-detection/spec.md)
| ID | Requirement | Testable Scenario |
|----|-------------|-------------------|
| FD-1 | Entry points detected | Exported function, verify entry |
| FD-2 | BFS traces forward | Entry to terminal, verify path |
| FD-3 | Max depth limits trace | Set depth=10, verify limit |
| FD-4 | Branching limit applied | >4 callees, verify top 4 followed |
| FD-5 | Flows labeled heuristically | handleLogin->createSession, verify label |
| FD-6 | Flows classified by community | Same cluster = intra, verify |
| FD-7 | detect_changes maps git diff | Modified function, verify affected flow |
| FD-8 | No changes returns empty | Clean repo, verify empty result |
| FD-9 | Non-symbol files listed | Config changed, verify listed |

### Search Pipeline (search-pipeline/spec.md)
| ID | Requirement | Testable Scenario |
|----|-------------|-------------------|
| SP-1 | Search enriched with symbol metadata | Search file with symbols, verify enrichment |
| SP-2 | Files without symbols not enriched | Search markdown, verify no enrichment |
| SP-3 | No symbol graph = backward compatible | Tree-sitter disabled, verify search works |

---

## 4. Source Files Involved

| File | Purpose |
|------|---------|
| `src/treesitter.ts` | Tree-sitter AST parsing, symbol extraction |
| `src/symbol-graph.ts` | Symbol graph queries, impact/context tools |
| `src/flow-detection.ts` | BFS flow detection, entry point identification |
| `src/graph.ts` | Graph utilities, clusterSymbols function |
| `src/codebase.ts` | Codebase indexing, incremental updates |
| `src/server.ts` | MCP tool registration (context, impact, detect_changes) |
| `src/search.ts` | Search pipeline with symbol enrichment |
| `src/types.ts` | Type definitions for symbols, edges, flows |
| `src/store.ts` | SQLite storage for code_symbols, symbol_edges |

---

## 5. Test Files Involved

| File | Coverage Area |
|------|---------------|
| `test/treesitter.test.ts` | Tree-sitter parsing, symbol extraction |
| `test/symbol-graph.test.ts` | Symbol graph queries, edge creation |
| `test/symbol-clustering.test.ts` | Louvain clustering on symbol graph |
| `test/flow-detection.test.ts` | BFS flow detection, entry points |
| `test/mcp-tools-symbol.test.ts` | MCP tools: context, impact, detect_changes |
| `test/search-enrichment.test.ts` | Search result enrichment |

---

## 6. Test Environment

- **Runtime:** Node.js (ESM)
- **Test Framework:** Vitest
- **Database:** better-sqlite3 (WAL mode)
- **Parser:** Tree-sitter native bindings
- **Languages:** TypeScript, JavaScript, Python

---

## 7. Pre-existing Test Status

- **Total tests:** 726
- **Passing:** 725
- **Failing:** 1 (pre-existing in watcher.test.ts, unrelated to this feature)

---

## 8. Output Directory

```
/Users/tamlh/workspaces/self/AI/Tools/nano-brain/ai/test-case/rri-t/nano-brain-gitnexus-enhancements/
├── 01-prepare.md (this file)
├── 02-discover.md (persona interviews)
├── 03-structure.md (Q-A-R-P-T test cases)
├── 04-execute.md (test execution results)
├── 05-analyze.md (coverage analysis)
└── summary.md (final verdict)
```
