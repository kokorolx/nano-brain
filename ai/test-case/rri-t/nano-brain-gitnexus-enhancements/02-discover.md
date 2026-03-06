# RRI-T Phase 2: DISCOVER

**Feature:** nano-brain-gitnexus-enhancements  
**Date:** 2026-03-06  
**Methodology:** Reverse Requirements Interview - Testing

---

## Persona Adaptation for Backend Library

Since nano-brain is a backend TypeScript library (MCP server + CLI), not a web app, the personas are adapted:

| Standard Persona | Adapted For Backend Library |
|------------------|----------------------------|
| End User | AI Agent (Cursor/Claude Code/OpenCode) using MCP tools |
| Business Analyst | Developer integrating nano-brain into their workflow |
| QA Destroyer | Adversarial tester finding edge cases and failure modes |
| DevOps Tester | Ops engineer concerned with performance and reliability |
| Security Auditor | Security reviewer checking for vulnerabilities |

---

## Persona 1: AI Agent (End User)

*"I'm an AI coding assistant using nano-brain's MCP tools to understand codebases and help developers."*

### Questions (17)

1. When I call the `context` tool with a function name, do I get a clear, structured response I can parse?
2. If multiple symbols match my query (e.g., "validate"), do I get a disambiguation list with enough info to choose?
3. What happens if I query a symbol that doesn't exist? Do I get a helpful error message?
4. When I call `impact` with direction "upstream", do I understand which symbols will break if I change the target?
5. Does the impact response clearly show the risk level (LOW/MEDIUM/HIGH/CRITICAL)?
6. Can I filter impact results by confidence to avoid false positives?
7. When I call `detect_changes`, do I get a clear mapping of git changes to affected flows?
8. If there are no uncommitted changes, does `detect_changes` return a clear "no changes" message?
9. Does the `context` response include infrastructure connections (Redis, MySQL) so I understand side effects?
10. Can I use `file_path` to disambiguate when I know which file I'm asking about?
11. Are execution flows labeled in a human-readable way I can present to the developer?
12. Does the search enrichment help me prioritize results by showing flow participation?
13. If Tree-sitter fails, do the tools still work with degraded functionality?
14. Are confidence scores included in edge data so I can assess reliability?
15. Does the `impact` tool show which execution flows are affected by a change?
16. Can I query symbols by kind (function, class, method) to narrow results?
17. Are error messages actionable, telling me what to do next?

---

## Persona 2: Developer Integrating nano-brain (Business Analyst)

*"I'm integrating nano-brain into my development workflow and need reliable, consistent APIs."*

### Questions (16)

1. Are the MCP tool input/output schemas documented and stable?
2. Does incremental indexing correctly update only changed files?
3. If I delete a file, are its symbols and edges properly cleaned up?
4. Can I rely on the symbol graph being consistent after partial indexing?
5. Are CALLS edges created with appropriate confidence scores?
6. Do EXTENDS and IMPLEMENTS edges have confidence 1.0 as specified?
7. Is the `code_symbols` table schema backward compatible with future updates?
8. Can I query the symbol graph directly via SQL if needed?
9. Does the search API remain backward compatible when symbol graph is unavailable?
10. Are flow labels deterministic (same input = same label)?
11. Does the `detect_changes` tool work correctly with staged vs unstaged changes?
12. Can I configure max depth and branching limits for flow detection?
13. Are symbol IDs stable across re-indexing (for caching purposes)?
14. Does the system handle circular dependencies without infinite loops?
15. Are edge types (CALLS, IMPORTS, EXTENDS, IMPLEMENTS) correctly distinguished?
16. Can I trust the risk assessment algorithm for production use?

---

## Persona 3: QA Destroyer (Adversarial Tester)

*"I break things. I find the edge cases that crash systems and corrupt data."*

### Questions (18)

1. What happens if I index a file with syntax errors?
2. What if a function name contains SQL injection characters like `'; DROP TABLE`?
3. What if a file path contains path traversal sequences like `../../../etc/passwd`?
4. What happens with a 100MB TypeScript file with 10,000 functions?
5. What if I have circular call dependencies (A calls B calls C calls A)?
6. What if I index an empty repository with no source files?
7. What if Tree-sitter native bindings fail to load at runtime?
8. What happens if SQLite database is corrupted mid-indexing?
9. What if I run concurrent indexing operations on the same workspace?
10. What if a file has no exports but only internal functions?
11. What if a class extends a class from node_modules (external)?
12. What if I query `impact` with maxDepth=1000?
13. What if I query `context` with an empty string as the symbol name?
14. What happens if git is not installed when calling `detect_changes`?
15. What if the workspace has 50,000 files?
16. What if a Python file uses dynamic imports (`__import__`)?
17. What if a TypeScript file uses `eval()` to call functions?
18. What if I delete the SQLite database while the server is running?

---

## Persona 4: DevOps Tester (Ops Engineer)

*"I care about performance, reliability, and operational characteristics."*

### Questions (15)

1. How much memory does indexing a 10,000-file codebase consume?
2. What's the indexing speed (files/second) for TypeScript files?
3. Does SQLite WAL mode handle concurrent reads during indexing?
4. What happens if disk space runs out during indexing?
5. How long does server startup take with a large symbol graph?
6. Are Tree-sitter native bindings compatible with all Node.js versions?
7. What's the query latency for `impact` on a graph with 50,000 symbols?
8. Does the system recover gracefully from SQLite lock timeouts?
9. Can I monitor indexing progress programmatically?
10. What's the database size growth rate per 1,000 symbols?
11. Does incremental indexing actually skip unchanged files (verified by timing)?
12. Are there any memory leaks during long-running indexing sessions?
13. What's the CPU usage pattern during BFS flow detection?
14. Can the system handle being killed and restarted mid-indexing?
15. Are there any file descriptor leaks with Tree-sitter parsing?

---

## Persona 5: Security Auditor

*"I look for vulnerabilities that could be exploited in production."*

### Questions (16)

1. Can SQL injection occur via symbol names in queries?
2. Can path traversal occur via `file_path` parameter in `context` tool?
3. Can command injection occur in `detect_changes` git operations?
4. Is data properly isolated between different project workspaces?
5. Are there any secrets or credentials logged during indexing?
6. Can a malicious file cause arbitrary code execution via Tree-sitter?
7. Are SQLite queries parameterized to prevent injection?
8. Can an attacker craft a file that causes denial of service?
9. Is the MCP transport (stdio) secure against injection?
10. Are file paths validated before being used in queries?
11. Can symbol names be used to inject malicious content into responses?
12. Is there any risk of information leakage across workspaces?
13. Are git commands executed with proper escaping?
14. Can a crafted Python file exploit the Tree-sitter parser?
15. Are there any TOCTOU (time-of-check-time-of-use) vulnerabilities?
16. Is the confidence scoring algorithm resistant to manipulation?

---

## Question Summary

| Persona | Question Count |
|---------|----------------|
| AI Agent (End User) | 17 |
| Developer (Business Analyst) | 16 |
| QA Destroyer | 18 |
| DevOps Tester | 15 |
| Security Auditor | 16 |
| **Total** | **82** |

---

## Key Themes Identified

### Theme 1: Tool Response Quality
- Clear, structured responses
- Actionable error messages
- Disambiguation UX
- Human-readable labels

### Theme 2: Data Integrity
- Incremental indexing correctness
- Edge confidence accuracy
- Flow consistency
- Cleanup on file deletion

### Theme 3: Edge Cases
- Malformed inputs
- Huge codebases
- Circular dependencies
- Empty repositories
- Concurrent operations

### Theme 4: Performance
- Memory usage
- Indexing speed
- Query latency
- Startup time

### Theme 5: Security
- SQL injection
- Path traversal
- Command injection
- Project isolation
- Data leakage
