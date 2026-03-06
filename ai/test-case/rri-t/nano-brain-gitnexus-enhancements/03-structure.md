# RRI-T Phase 3: STRUCTURE

**Feature:** nano-brain-gitnexus-enhancements  
**Date:** 2026-03-06  
**Test Cases:** 42 (covering all 7 dimensions)

---

## Dimension Coverage Map

| Dimension | Test Cases | Priority Distribution |
|-----------|------------|----------------------|
| D1: UI/UX | TC-01 to TC-06 | 2 P0, 2 P1, 2 P2 |
| D2: API | TC-07 to TC-12 | 3 P0, 2 P1, 1 P2 |
| D3: Performance | TC-13 to TC-18 | 1 P0, 3 P1, 2 P2 |
| D4: Security | TC-19 to TC-24 | 4 P0, 2 P1, 0 P2 |
| D5: Data Integrity | TC-25 to TC-30 | 3 P0, 2 P1, 1 P2 |
| D6: Infrastructure | TC-31 to TC-36 | 2 P0, 2 P1, 2 P2 |
| D7: Edge Cases | TC-37 to TC-42 | 2 P0, 2 P1, 2 P2 |

---

## D1: UI/UX (MCP Tool Response Format, Disambiguation, Error Messages)

### TC-01: Context tool returns structured response
**Q:** When I call the context tool with a function name, do I get a clear, structured response I can parse?  
**A:** The response includes symbol metadata, incoming edges, outgoing edges, cluster info, and flow participation in a consistent JSON structure.  
**R:** CT-1 (Context tool provides 360-degree symbol view)  
**P:** P0  
**T:**
- Precondition: Symbol graph indexed with at least one function
- Steps:
  1. Call context tool with name="testFunction"
  2. Parse response JSON
- Expected: Response contains fields: symbol (with kind, file, lines), incoming, outgoing, cluster, flows

### TC-02: Ambiguous symbol returns disambiguation list
**Q:** If multiple symbols match my query, do I get a disambiguation list with enough info to choose?  
**A:** When multiple symbols match, the response includes a list with file path, kind, and line number for each match.  
**R:** CT-2 (Ambiguous symbol name scenario)  
**P:** P0  
**T:**
- Precondition: Two functions named "validate" in different files
- Steps:
  1. Call context tool with name="validate"
  2. Check response structure
- Expected: Response contains disambiguation array with [{file, kind, line}, ...]

### TC-03: Symbol not found returns helpful message
**Q:** What happens if I query a symbol that does not exist?  
**A:** The response includes a clear "not found" message suggesting to run a search query instead.  
**R:** CT-4 (Symbol not found scenario)  
**P:** P1  
**T:**
- Precondition: Symbol graph indexed
- Steps:
  1. Call context tool with name="nonExistentSymbol123"
- Expected: Response contains error with message suggesting search

### TC-04: Impact response shows risk level clearly
**Q:** Does the impact response clearly show the risk level?  
**A:** The impact response includes a riskLevel field with value LOW, MEDIUM, HIGH, or CRITICAL.  
**R:** IA-5 (Risk assessment included)  
**P:** P1  
**T:**
- Precondition: Symbol graph with dependencies
- Steps:
  1. Call impact tool with target symbol
  2. Check response for riskLevel field
- Expected: riskLevel is one of: LOW, MEDIUM, HIGH, CRITICAL

### TC-05: Flow labels are human-readable
**Q:** Are execution flows labeled in a human-readable way?  
**A:** Flow labels follow the pattern "EntryPoint -> TerminalSymbol" (e.g., "HandleLogin -> CreateSession").  
**R:** FD-5 (Flows are labeled heuristically)  
**P:** P2  
**T:**
- Precondition: Flow detected from handleLogin to createSession
- Steps:
  1. Query flows for the workspace
  2. Check label format
- Expected: Label matches pattern "HandleLogin -> CreateSession"

### TC-06: Error messages are actionable
**Q:** Are error messages actionable, telling me what to do next?  
**A:** Error messages include the error type, description, and suggested action.  
**R:** General UX requirement  
**P:** P2  
**T:**
- Precondition: None
- Steps:
  1. Call context with empty string
  2. Check error message
- Expected: Error includes suggestion like "provide a valid symbol name"

---

## D2: API (MCP Tool Input/Output Contracts, Parameter Validation)

### TC-07: Context tool accepts file_path for disambiguation
**Q:** Can I use file_path to disambiguate when I know which file I am asking about?  
**A:** The context tool accepts an optional file_path parameter that filters results to that specific file.  
**R:** CT-5 (file_path disambiguates)  
**P:** P0  
**T:**
- Precondition: Two functions named "validate" in different files
- Steps:
  1. Call context with name="validate", file_path="src/auth/validate.ts"
- Expected: Returns context for only the symbol in src/auth/validate.ts

### TC-08: Impact tool accepts direction parameter
**Q:** Can I specify upstream vs downstream direction for impact analysis?  
**A:** The impact tool accepts direction parameter with values "upstream" or "downstream".  
**R:** IA-1, IA-2 (Upstream/downstream impact)  
**P:** P0  
**T:**
- Precondition: Symbol graph with call relationships
- Steps:
  1. Call impact with direction="upstream"
  2. Call impact with direction="downstream"
- Expected: Upstream returns callers, downstream returns callees

### TC-09: Impact tool accepts maxDepth parameter
**Q:** Can I limit traversal depth in impact analysis?  
**A:** The impact tool accepts maxDepth parameter (default: 10) to limit traversal.  
**R:** IA-3 (maxDepth limits traversal)  
**P:** P0  
**T:**
- Precondition: Symbol graph with 5+ depth chain
- Steps:
  1. Call impact with maxDepth=2
- Expected: Results only include symbols up to depth 2

### TC-10: Impact tool accepts minConfidence parameter
**Q:** Can I filter impact results by confidence?  
**A:** The impact tool accepts minConfidence parameter (0.0-1.0) to filter edges.  
**R:** IA-4 (minConfidence filters edges)  
**P:** P1  
**T:**
- Precondition: Symbol graph with edges of varying confidence
- Steps:
  1. Call impact with minConfidence=0.8
- Expected: Only edges with confidence >= 0.8 included

### TC-11: Detect changes returns affected flows
**Q:** Does detect_changes show which execution flows are affected?  
**A:** The detect_changes response includes an affectedFlows array listing flows that contain changed symbols.  
**R:** FD-7 (detect_changes maps git diff to affected flows)  
**P:** P1  
**T:**
- Precondition: Uncommitted changes to a file with symbols in a flow
- Steps:
  1. Call detect_changes tool
- Expected: Response includes affectedFlows array

### TC-12: Search enrichment includes symbol metadata
**Q:** Does search enrichment help me prioritize results?  
**A:** Search results for files with symbols include: symbols list, clusterLabel, flowCount.  
**R:** SP-1 (Search results include symbol-level context)  
**P:** P2  
**T:**
- Precondition: Symbol graph indexed, file has symbols
- Steps:
  1. Run search query matching a file with symbols
- Expected: Result includes symbols, clusterLabel, flowCount fields

---

## D3: Performance (Indexing Speed, Query Latency, Memory Usage)

### TC-13: Indexing speed meets baseline
**Q:** What is the indexing speed for TypeScript files?  
**A:** Indexing should process at least 50 files/second for typical TypeScript files.  
**R:** Design decision (Tree-sitter is fast)  
**P:** P1  
**T:**
- Precondition: 100 TypeScript files of average size
- Steps:
  1. Time full indexing operation
  2. Calculate files/second
- Expected: >= 50 files/second

### TC-14: Impact query latency acceptable
**Q:** What is the query latency for impact on a large graph?  
**A:** Impact query should complete in < 500ms for graphs with up to 10,000 symbols.  
**R:** Performance requirement  
**P:** P1  
**T:**
- Precondition: Symbol graph with 10,000 symbols
- Steps:
  1. Time impact query with maxDepth=5
- Expected: < 500ms

### TC-15: Memory usage during indexing bounded
**Q:** How much memory does indexing consume?  
**A:** Memory usage should not exceed 500MB for a 10,000-file codebase.  
**R:** Design risk mitigation  
**P:** P1  
**T:**
- Precondition: 10,000-file codebase
- Steps:
  1. Monitor memory during indexing
- Expected: Peak memory < 500MB

### TC-16: Incremental indexing is faster than full
**Q:** Does incremental indexing actually skip unchanged files?  
**A:** Incremental indexing of unchanged files should be 10x faster than full indexing.  
**R:** SG-7 (Incremental indexing skips unchanged files)  
**P:** P0  
**T:**
- Precondition: Fully indexed codebase
- Steps:
  1. Time full index
  2. Time incremental index (no changes)
- Expected: Incremental time < 10% of full time

### TC-17: Context query latency acceptable
**Q:** What is the query latency for context tool?  
**A:** Context query should complete in < 100ms.  
**R:** Performance requirement  
**P:** P2  
**T:**
- Precondition: Symbol graph indexed
- Steps:
  1. Time context query
- Expected: < 100ms

### TC-18: Database size growth reasonable
**Q:** What is the database size growth rate?  
**A:** Database should grow by approximately 150 bytes per symbol (100 for symbol + 50 for edges).  
**R:** Design estimate  
**P:** P2  
**T:**
- Precondition: Empty database
- Steps:
  1. Index 1000 symbols
  2. Measure database size increase
- Expected: ~150KB increase

---

## D4: Security (SQL Injection, Path Traversal, Command Injection)

### TC-19: SQL injection via symbol name prevented
**Q:** Can SQL injection occur via symbol names in queries?  
**A:** Symbol names are parameterized in all SQL queries, preventing injection.  
**R:** Security requirement  
**P:** P0  
**T:**
- Precondition: None
- Steps:
  1. Call context with name="'; DROP TABLE code_symbols; --"
- Expected: Query executes safely, no table dropped, error or empty result

### TC-20: Path traversal via file_path prevented
**Q:** Can path traversal occur via file_path parameter?  
**A:** File paths are validated to be within the workspace directory.  
**R:** Security requirement  
**P:** P0  
**T:**
- Precondition: None
- Steps:
  1. Call context with file_path="../../../etc/passwd"
- Expected: Request rejected or path normalized to workspace

### TC-21: Command injection in detect_changes prevented
**Q:** Can command injection occur in git operations?  
**A:** Git commands use parameterized execution, not shell interpolation.  
**R:** Security requirement  
**P:** P0  
**T:**
- Precondition: None
- Steps:
  1. Create file with name containing shell metacharacters
  2. Call detect_changes
- Expected: No command injection, safe execution

### TC-22: Project isolation maintained
**Q:** Is data properly isolated between different project workspaces?  
**A:** Each workspace has its own database file, no cross-workspace queries possible.  
**R:** Security requirement  
**P:** P0  
**T:**
- Precondition: Two separate workspaces indexed
- Steps:
  1. Query symbols from workspace A
  2. Verify no symbols from workspace B appear
- Expected: Complete isolation

### TC-23: No secrets logged during indexing
**Q:** Are there any secrets or credentials logged during indexing?  
**A:** Indexing logs file paths and symbol names only, never file contents.  
**R:** Security requirement  
**P:** P1  
**T:**
- Precondition: File containing API_KEY="secret123"
- Steps:
  1. Index the file
  2. Check all log output
- Expected: "secret123" never appears in logs

### TC-24: Tree-sitter cannot execute arbitrary code
**Q:** Can a malicious file cause arbitrary code execution via Tree-sitter?  
**A:** Tree-sitter only parses AST, does not execute code.  
**R:** Security requirement  
**P:** P1  
**T:**
- Precondition: Malicious file with eval() or __import__
- Steps:
  1. Index the file
- Expected: File parsed without executing any code

---

## D5: Data Integrity (Incremental Indexing, Edge Confidence, Flow Consistency)

### TC-25: Changed files are re-parsed correctly
**Q:** If I modify a file, are its symbols updated correctly?  
**A:** Changed files have all old symbols/edges deleted and new ones inserted.  
**R:** SG-8 (File changed since last index)  
**P:** P0  
**T:**
- Precondition: File indexed with function foo()
- Steps:
  1. Modify file to rename foo() to bar()
  2. Re-index
  3. Query symbols
- Expected: foo() gone, bar() present

### TC-26: Deleted files have symbols removed
**Q:** If I delete a file, are its symbols and edges cleaned up?  
**A:** Deleted files have all associated symbols and edges removed from the database.  
**R:** SG-9 (File deleted since last index)  
**P:** P0  
**T:**
- Precondition: File indexed with symbols
- Steps:
  1. Delete the file
  2. Re-index
  3. Query symbols for that file
- Expected: No symbols found for deleted file

### TC-27: CALLS edges have correct confidence
**Q:** Are CALLS edges created with appropriate confidence scores?  
**A:** CALLS edges have confidence >= 0.7, with higher scores for resolved calls.  
**R:** SG-4 (CALLS edges with confidence >= 0.7)  
**P:** P0  
**T:**
- Precondition: Function A calls function B (same file)
- Steps:
  1. Index the file
  2. Query edge from A to B
- Expected: Edge exists with confidence >= 0.7

### TC-28: EXTENDS edges have confidence 1.0
**Q:** Do EXTENDS edges have confidence 1.0 as specified?  
**A:** Class extension edges always have confidence 1.0 (AST-resolved).  
**R:** SG-5 (EXTENDS edges have confidence 1.0)  
**P:** P1  
**T:**
- Precondition: Class A extends Class B
- Steps:
  1. Index the file
  2. Query EXTENDS edge
- Expected: Edge exists with confidence = 1.0

### TC-29: Flow consistency after re-indexing
**Q:** Are flows consistent after incremental re-indexing?  
**A:** Flows are recalculated correctly when symbols change.  
**R:** FD-2 (BFS traces forward)  
**P:** P1  
**T:**
- Precondition: Flow A -> B -> C detected
- Steps:
  1. Modify B to call D instead of C
  2. Re-index
  3. Query flows
- Expected: Flow now shows A -> B -> D

### TC-30: Code symbols coexist with infrastructure symbols
**Q:** Can both code symbols and infrastructure symbols exist for the same file?  
**A:** Code symbols (functions) and infrastructure symbols (Redis keys) are stored in separate tables.  
**R:** SG-10 (Code symbols coexist with infra symbols)  
**P:** P2  
**T:**
- Precondition: File with function that calls redis.get("user:*")
- Steps:
  1. Index the file
  2. Query code_symbols table
  3. Query symbols table (infrastructure)
- Expected: Both function and redis_key present

---

## D6: Infrastructure (Tree-sitter Fallback, SQLite Recovery, Disk Space)

### TC-31: Tree-sitter failure degrades gracefully
**Q:** What happens if Tree-sitter native bindings fail to load?  
**A:** System logs warning and continues with regex-only parsing. Symbol graph features unavailable.  
**R:** SG-3 (Tree-sitter fails to load scenario)  
**P:** P0  
**T:**
- Precondition: Simulate Tree-sitter load failure
- Steps:
  1. Start server with Tree-sitter unavailable
  2. Attempt indexing
- Expected: Warning logged, regex parsing works, no crash

### TC-32: SQLite WAL mode handles concurrent reads
**Q:** Does SQLite WAL mode handle concurrent reads during indexing?  
**A:** Readers can query while indexing writes are in progress.  
**R:** Design decision (WAL mode)  
**P:** P0  
**T:**
- Precondition: Large codebase
- Steps:
  1. Start indexing
  2. Simultaneously run context queries
- Expected: Queries succeed during indexing

### TC-33: Disk space exhaustion handled
**Q:** What happens if disk space runs out during indexing?  
**A:** Indexing fails gracefully with clear error message, partial data may be rolled back.  
**R:** Infrastructure requirement  
**P:** P1  
**T:**
- Precondition: Limited disk space
- Steps:
  1. Attempt to index large codebase
- Expected: Clear error message, no corruption

### TC-34: Server recovers from kill during indexing
**Q:** Can the system handle being killed and restarted mid-indexing?  
**A:** On restart, system detects incomplete index and can resume or restart.  
**R:** Infrastructure requirement  
**P:** P1  
**T:**
- Precondition: Indexing in progress
- Steps:
  1. Kill server process
  2. Restart server
- Expected: No corruption, can re-index

### TC-35: Unsupported language files handled
**Q:** What happens when indexing files with unsupported languages?  
**A:** Unsupported files are skipped for symbol extraction, regex import parsing still works.  
**R:** SG-2 (Unsupported language file scenario)  
**P:** P2  
**T:**
- Precondition: .go or .rs file in workspace
- Steps:
  1. Index workspace
- Expected: File skipped for symbols, no error

### TC-36: Database corruption recovery
**Q:** What happens if SQLite database is corrupted?  
**A:** System detects corruption and can rebuild from scratch.  
**R:** Infrastructure requirement  
**P:** P2  
**T:**
- Precondition: Corrupted database file
- Steps:
  1. Start server
- Expected: Error detected, option to rebuild

---

## D7: Edge Cases (Empty Repos, Circular Deps, Huge Files, Unsupported Languages)

### TC-37: Empty repository handled
**Q:** What happens if I index an empty repository?  
**A:** Indexing completes successfully with zero symbols and edges.  
**R:** Edge case requirement  
**P:** P0  
**T:**
- Precondition: Empty git repository
- Steps:
  1. Index the repository
- Expected: Success, 0 symbols, 0 edges

### TC-38: Circular call dependencies handled
**Q:** What happens with circular call dependencies (A calls B calls C calls A)?  
**A:** BFS detects cycles and terminates, edges are created correctly.  
**R:** Design risk mitigation  
**P:** P0  
**T:**
- Precondition: Files with circular calls
- Steps:
  1. Index files
  2. Query impact for any symbol in cycle
- Expected: No infinite loop, results returned

### TC-39: Huge file handled
**Q:** What happens with a 100MB TypeScript file?  
**A:** File is parsed (may be slow), or skipped if exceeding size limit.  
**R:** Edge case requirement  
**P:** P1  
**T:**
- Precondition: Very large TypeScript file
- Steps:
  1. Index the file
- Expected: Either parsed successfully or skipped with warning

### TC-40: File with syntax errors handled
**Q:** What happens if I index a file with syntax errors?  
**A:** Tree-sitter provides partial AST, symbols extracted where possible.  
**R:** Edge case requirement  
**P:** P1  
**T:**
- Precondition: TypeScript file with syntax error
- Steps:
  1. Index the file
- Expected: Partial symbols extracted, no crash

### TC-41: External class extension handled
**Q:** What if a class extends a class from node_modules?  
**A:** EXTENDS edge created with lower confidence (external, unresolved).  
**R:** Edge case requirement  
**P:** P2  
**T:**
- Precondition: Class extends React.Component
- Steps:
  1. Index the file
  2. Query EXTENDS edge
- Expected: Edge exists, possibly with lower confidence or marked external

### TC-42: No git installed for detect_changes
**Q:** What happens if git is not installed when calling detect_changes?  
**A:** Clear error message indicating git is required.  
**R:** Edge case requirement  
**P:** P2  
**T:**
- Precondition: git not in PATH
- Steps:
  1. Call detect_changes
- Expected: Error message about git not found

---

## Test Case Summary

| Priority | Count | Percentage |
|----------|-------|------------|
| P0 | 17 | 40% |
| P1 | 15 | 36% |
| P2 | 10 | 24% |
| **Total** | **42** | 100% |

| Dimension | Count |
|-----------|-------|
| D1: UI/UX | 6 |
| D2: API | 6 |
| D3: Performance | 6 |
| D4: Security | 6 |
| D5: Data Integrity | 6 |
| D6: Infrastructure | 6 |
| D7: Edge Cases | 6 |
| **Total** | **42** |
