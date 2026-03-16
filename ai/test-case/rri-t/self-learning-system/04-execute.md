# RRI-T Phase 4: Real MCP Test Execution Results

**Date:** 2026-03-12
**Method:** Live MCP Streamable HTTP calls against real server on host (macOS)
**Versions tested:** rc.2, rc.3, rc.6
**Server:** http://host.docker.internal:3100

## Test Results

| TC | Test | Dimension | Priority | Result | Latency | Notes |
|----|------|-----------|----------|--------|---------|-------|
| R1 | memory_search returns results | D3: Performance | P0 | ✅ PASS | 253ms | BM25 search fast, returns relevant results |
| R2 | memory_write auto-categorizes | D1: Response Quality | P0 | ✅ PASS | 1036ms | "decided", "architecture" → `auto:architecture-decision, auto:pattern` |
| R3 | Empty content rejected | D2: API Interface | P1 | ✅ PASS | <100ms | Returns `Error: content must not be empty` (rc.3 fix) |
| R4 | memory_graph_query non-existent entity | D2: API Interface | P2 | ✅ PASS | 975ms | Returns `Entity not found: "Redis"` — clear error |
| R5 | memory_learning_status | D6: Infrastructure | P2 | ✅ PASS | 992ms | Shows telemetry (10 queries), bandits, proactive stats |
| R6 | memory_query hybrid search | D3: Performance | P0 | ✅ PASS | 1286ms | Returns relevant results, hybrid fusion works |
| R7 | SQL injection in content | D4: Security | P0 | ✅ PASS | <500ms | `'); DROP TABLE documents;--` stored safely |
| R8 | Vietnamese Unicode content | D7: Edge Cases | P1 | ✅ PASS | <500ms | "Quyết định kiến trúc" preserved correctly |
| R9 | memory_timeline | D2: API Interface | P1 | ✅ PASS | 1087ms | Returns chronological entries for "architecture" |
| R10 | memory_related | D2: API Interface | P1 | ❌ FAIL | >15s | Timeout — server event loop blocked by background work |
| R11 | access_count increments on /api/search | D5: Data Integrity | P1 | 🔒 BLOCKED | — | Server unresponsive during test window |
| R12 | Cross-workspace isolation | D4: Security | P0 | 🔒 BLOCKED | — | Server unresponsive during test window |

## Fixes Verified (rc.3+)

| Fix | Status | Evidence |
|-----|--------|----------|
| Empty content rejection | ✅ Verified | TC-R3: `""` returns error |
| Search timeout (5s Promise.race) | ✅ Verified | TC-R1: 253ms, TC-R6: 1286ms (was >30s on rc.2) |
| Auto-categorization | ✅ Verified | TC-R2: correct `auto:architecture-decision` tag |

## Bugs Found

### BUG-004: Server event loop blocks during background embedding/indexing (P0)
- **TCs:** R10, R11, R12
- **Symptom:** Server becomes completely unresponsive (even /health times out) for 10-30s+ periods
- **Root cause:** Background embedding batches and/or SQLite FTS indexing run synchronously on the main event loop
- **Impact:** All MCP tools, API endpoints, and health checks hang during these periods
- **Frequency:** Happens repeatedly, especially after writes trigger re-indexing
- **Fix needed:** Move heavy work to worker threads or use async batching with `setImmediate()` yields

### BUG-005: memory_related tool times out (P1)
- **TC:** R10
- **Symptom:** >15s timeout on `memory_related` call
- **Likely cause:** Combines search + entity graph lookup, compounds the event loop blocking issue
- **Fix:** Depends on BUG-004 fix; may also need its own timeout wrapper

## Performance Summary

| Tool | Latency (when server responsive) |
|------|----------------------------------|
| memory_search (BM25) | ~250ms ✅ |
| memory_write | ~1s ✅ |
| memory_query (hybrid) | ~1.3s ✅ |
| memory_graph_query | ~1s ✅ |
| memory_timeline | ~1s ✅ |
| memory_learning_status | ~1s ✅ |
| memory_related | >15s ❌ |
| /health (during bg work) | >10s ❌ |
