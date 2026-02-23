---
description: Initialize nano-brain persistent memory for the current workspace.
---

Run these MCP tools in order:

1. `memory_status` — check if already initialized (codebase docs > 0 means skip to step 4)
2. `memory_index_codebase` — index source files from workspace root
3. `memory_update` — reindex sessions and curated notes
4. `memory_status` — show final state

Report: document counts, pending embeddings, and whether AGENTS.md snippet exists.
If pending embeddings > 0, note they process in background.
