---
description: Initialize nano-brain persistent memory for the current workspace.
---

## Steps

**Try MCP first, fall back to CLI.**

### Option A: MCP tools available

1. Call `memory_status` tool to check current state
   - If codebase > 0 docs: already initialized, skip to step 4
   - If error "tool not found": use Option B

2. Call `memory_index_codebase` with `root` = current workspace path

3. Call `memory_update` to index sessions and curated notes

4. Call `memory_status` again and report results

### Option B: MCP tools NOT available (fallback)

Run via Bash:

```bash
npx nano-brain init --root=$(pwd)
```

This does everything: indexes codebase + harvests sessions + indexes collections + generates embeddings.

### Detection

Try `memory_status` first. If it errors with "tool not found" or "MCP server not found", use Option B.

## Output Format

```
nano-brain initialized:
- Codebase: X files
- Symbol graph: A symbols, B edges
- Sessions: Y documents
- Pending embeddings: Z (processing in background)
- Embedding server: connected / disconnected
```

If pending embeddings > 0, explain they process automatically when MCP server runs.
If embedding server disconnected, suggest checking config.yml embedding settings.
