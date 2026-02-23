---
description: Show nano-brain memory health and statistics.
---

Run `memory_status` and present a clean summary.

Highlight: total docs, pending embeddings, collection breakdown, embedding server connectivity.

Suggest actions if:
- 0 codebase docs → "Run `/nano-brain-init`"
- Pending embeddings > 0 → "Processing in background"
- Embedding server unreachable → "Check Ollama: `ollama serve`"
