---
description: Rescan codebase and refresh all nano-brain indexes after branch switch or code changes.
---

## When to Use

- After `git checkout`, `git pull`, or branch switch
- After major code changes (new files, deleted files, refactors)
- When search results seem stale or missing recent changes
- When `code_context` / `code_impact` return "symbol not found"

## Steps

**Try MCP first, fall back to CLI.**

### Option A: MCP tools available

1. Call `memory_index_codebase` with `root` = current workspace path
2. Call `memory_update` to refresh session and note indexes
3. Call `memory_status` and report results

### Option B: MCP tools NOT available (fallback)

Run via Bash:

```bash
npx nano-brain reindex
```

If `reindex` command is not yet available (older version), use:

```bash
npx nano-brain init
```

Note: `init` is safe without `--force` — it preserves all existing data and only re-scans.

### Detection

Try `memory_status` first. If it errors with "tool not found" or "MCP server not found", use Option B.

## Output Format

```
Reindex complete:
- Codebase: X files (Y new, Z unchanged)
- Symbol graph: A symbols, B edges
- Pending embeddings: N
```

## Notes

- Reindexing is incremental — unchanged files are skipped
- Symbol graph (code_symbols, symbol_edges) is rebuilt for changed files
- New/changed files need embedding — happens in background
- If many pending embeddings, they process automatically over time
