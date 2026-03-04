---
description: Initialize nano-brain persistent memory for the current workspace.
---

## Prerequisites

nano-brain MCP server must be configured in opencode.json. If `memory_status` tool is not available, tell user to add nano-brain to their MCP config first.

## Steps

1. Call `memory_status` tool to check current state
   - If codebase > 0 docs: already initialized, skip to step 4
   - If error "tool not found": MCP not configured, stop and instruct user

2. Call `memory_index_codebase` with `root` = current workspace path
   - This indexes source files (respects .gitignore)

3. Call `memory_update` to index sessions and curated notes

4. Call `memory_status` again and report:
   - Total documents indexed
   - Pending embeddings count
   - Embedding server status (connected/disconnected)

## Output Format

```
nano-brain initialized:
- Codebase: X files
- Sessions: Y documents  
- Pending embeddings: Z (processing in background)
- Embedding server: ✅ connected / ❌ disconnected
```

If pending embeddings > 0, explain they process automatically when MCP server runs.
If embedding server disconnected, suggest: "Start Ollama: `ollama serve`"
