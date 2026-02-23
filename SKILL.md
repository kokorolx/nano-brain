# opencode-memory

Persistent memory system for OpenCode. Hybrid search across past sessions, codebase, curated notes, and daily logs.

## When to Use (Routing Rules)

### ALWAYS use memory BEFORE starting work when:

- **Resuming or continuing work** — "continue", "pick up where we left off", "what were we doing"
- **Referencing past decisions** — "we decided", "last time", "previously", "remember when"
- **Cross-session context** — "what did we do about X", "how did we solve Y before"
- **Unfamiliar codebase area** — search memory for past exploration sessions before re-exploring
- **Repeated patterns** — "same as before", "like we did for X", "follow the same approach"

### ALWAYS use memory AFTER completing work:

- **Save key decisions** — architecture choices, tradeoffs, rejected alternatives
- **Save implementation patterns** — reusable approaches discovered during work
- **Save debugging insights** — root causes, non-obvious fixes, gotchas
- **Save project context** — domain knowledge, business rules, conventions learned

### Trigger Phrases (auto-route to memory)

| Phrase | Action |
|--------|--------|
| "what did we...", "have we ever...", "did we already..." | `memory_query` → recall past work |
| "remember", "last time", "before", "previously" | `memory_query` → find past context |
| "save this", "remember this", "note that" | `memory_write` → persist to memory |
| "what's the status of memory", "is memory indexed" | `memory_status` → check health |
| Starting a new feature in a known area | `memory_query` → find past sessions in that area |
| Debugging a recurring issue | `memory_search` → find past fixes |

## Tool Selection Guide

### Which search tool to use:

| Scenario | Tool | Why |
|----------|------|-----|
| Exact function/variable name, error message | `memory_search` (BM25) | Fast exact keyword matching |
| Conceptual question ("how does X work") | `memory_vsearch` (semantic) | Understands meaning, not just keywords |
| Complex question, best quality needed | `memory_query` (hybrid) | BM25 + vector + LLM reranking |
| Retrieve a specific known document | `memory_get` | Direct fetch by path or docid |
| Save a decision or insight | `memory_write` | Persist to daily log or MEMORY.md |

### Search strategy for best results:

1. **Start with `memory_query`** for complex/conceptual questions (best quality)
2. **Use `memory_search`** for exact terms — function names, error codes, specific strings
3. **Use `memory_vsearch`** when you want semantic similarity without reranking overhead
4. **Combine with native tools** — memory excels at recall and semantic search; grep/ast-grep excel at precise code pattern matching

### Collection filtering:

- `collection: "codebase"` — search only indexed source files
- `collection: "sessions-{project}"` — search only past sessions for a specific project
- `collection: "curated"` — search only manually saved notes
- Omit `collection` — search everything (recommended default)

## Available Tools

### memory_search
BM25 keyword search. Fast, exact matching.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection

### memory_vsearch
Semantic vector search using embeddings.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection

### memory_query
Full hybrid search with query expansion, RRF fusion, and LLM reranking. Best quality.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection
- minScore: Minimum score threshold

### memory_get
Retrieve a document by path or docid.
- id: Document path or #docid (required)
- fromLine: Start line number
- maxLines: Number of lines to return

### memory_multi_get
Batch retrieve documents by glob pattern or comma-separated list.
- pattern: Glob pattern or comma-separated docids/paths (required)
- maxBytes: Maximum total bytes to return (default: 50000)

### memory_write
Write content to daily log or MEMORY.md.
- content: Content to write (required)
- target: "daily" for daily log, "memory" for MEMORY.md (default: "daily")

### memory_status
Show index health, collection info, and model status.

### memory_index_codebase
Index codebase files in the current workspace.
- root: Workspace root path (optional, defaults to current workspace)

### memory_update
Trigger immediate reindex of all collections.

## Integration with Agent Workflow

### As an orchestrator (Sisyphus):

```
# Before starting any non-trivial task, check memory:
memory_query("what have we done regarding {topic}")

# After completing significant work, save context:
memory_write("## {date} - {topic}\n- Decision: ...\n- Reason: ...\n- Files changed: ...")

# When delegating to subagents, include memory context:
task(category="...", load_skills=["opencode-memory"], prompt="... CONTEXT from memory: ...")
```

### As a subagent:

```
# If the task involves an area you're unfamiliar with:
memory_query("{area} implementation patterns")

# If debugging and the fix isn't obvious:
memory_search("{error message or symptom}")
```

## Memory vs Native Tools

| Capability | opencode-memory | Native (grep/glob/ast-grep) |
|-----------|----------------|---------------------------|
| Past session recall | ✅ Searches all past sessions | ❌ session_search is basic text match |
| Semantic understanding | ✅ "notification workflow" finds related concepts | ❌ Literal pattern matching only |
| Cross-project knowledge | ✅ Searches across all indexed workspaces | ❌ Scoped to current directory |
| Exact code patterns | ⚠️ BM25 works, but less precise | ✅ ast-grep, grep are superior |
| Structural code search | ❌ Not AST-aware | ✅ ast-grep matches code structure |
| Curated knowledge | ✅ MEMORY.md + daily logs | ❌ No equivalent |

**They are complementary.** Use memory for recall + semantics, native tools for precise code matching.

## First-Time Setup

If memory is not yet indexed for a workspace:

```
memory_status                              # Check current state
memory_index_codebase root="/path/to/ws"   # Index codebase files
memory_update                              # Trigger reindex of sessions + curated
memory_status                              # Verify completion
```
