---
description: Rescan codebase and refresh all nano-brain indexes after branch switch or code changes.
---

Run these MCP tools:

1. `memory_index_codebase` — rescan source files (detects new, changed, and deleted files via content hash)
2. `memory_update` — refresh session and note indexes
3. `memory_status` — show updated counts and pending embeddings

Use after: branch switch, pull, major code changes, or when search results seem stale.
