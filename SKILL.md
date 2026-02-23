# nano-brain

Persistent memory for AI coding agents. Hybrid search (BM25 + semantic + LLM reranking) across past sessions, codebase, notes, and daily logs.

## Slash Commands

| Command | When |
|---------|------|
| `/nano-brain-init` | First-time workspace setup |
| `/nano-brain-status` | Health check, embedding progress |
| `/nano-brain-reindex` | After branch switch, pull, or major changes |

## When to Use Memory

**Before work:** Recall past decisions, patterns, debugging insights, cross-session context.
**After work:** Save key decisions, architecture choices, non-obvious fixes, domain knowledge.

## Tool Selection

| Need | Tool |
|------|------|
| Exact keyword (error msg, function name) | `memory_search` |
| Conceptual ("how does auth work") | `memory_vsearch` |
| Best quality, complex question | `memory_query` |
| Retrieve specific doc | `memory_get` / `memory_multi_get` |
| Save insight or decision | `memory_write` |
| Check health | `memory_status` |
| Rescan source files | `memory_index_codebase` |
| Refresh all indexes | `memory_update` |

**Default:** Use `memory_query` — it combines BM25 + vector + reranking for best results.

## Collection Filtering

- `collection: "codebase"` — source files only
- `collection: "sessions"` — past AI sessions only
- `collection: "memory"` — curated notes only
- Omit — search everything (recommended)

## Memory vs Native Tools

Memory excels at **recall and semantics** — past sessions, conceptual search, cross-project knowledge.
Native tools (grep, ast-grep, glob) excel at **precise code patterns** — exact matches, AST structure.

**They are complementary.** Use both.
