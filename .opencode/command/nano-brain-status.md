---
description: Show nano-brain memory health and statistics.
---

## Steps

**Try MCP first, fall back to CLI.**

### Option A: MCP tools available

1. Call `memory_status` tool
2. Present results (see format below)

### Option B: MCP tools NOT available (fallback)

Run via Bash:

```bash
npx nano-brain status
```

### Detection

Try `memory_status` first. If it errors with "tool not found" or "MCP server not found", use Option B.

## Output Format

```
nano-brain Status
─────────────────
Documents: X total
  - codebase: A files
  - sessions: B documents
  - memory: C notes

Embeddings: Y embedded, Z pending
Server: connected (model) / disconnected
```

## Suggested Actions

Based on status, suggest ONE relevant action:

| Condition | Suggestion |
|-----------|------------|
| codebase = 0 | "Run `/nano-brain-init` to index this workspace" |
| pending > 100 | "Embeddings processing in background. Check again in a few minutes." |
| server disconnected | "Check config.yml embedding settings" |
| all good | "Memory system healthy." |
