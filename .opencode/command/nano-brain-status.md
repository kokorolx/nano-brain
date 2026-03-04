---
description: Show nano-brain memory health and statistics.
---

## Steps

1. Call `memory_status` tool

2. Present results in this format:

```
nano-brain Status
─────────────────
Documents: X total
  - codebase: A files
  - sessions: B documents
  - memory: C notes

Embeddings: Y embedded, Z pending
Server: ✅ connected (model) / ❌ disconnected
```

## Suggested Actions

Based on status, suggest ONE relevant action:

| Condition | Suggestion |
|-----------|------------|
| codebase = 0 | "Run `/nano-brain-init` to index this workspace" |
| pending > 100 | "Embeddings processing in background. Check again in a few minutes." |
| server disconnected | "Start Ollama: `ollama serve`" |
| all good | "Memory system healthy. Use `memory_query` to search." |
