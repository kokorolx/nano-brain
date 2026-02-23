<!-- OPENCODE-MEMORY:START -->
<!-- Managed block - do not edit manually. Updated by: npx opencode-memory init -->

## Memory System (opencode-memory)

This project uses **opencode-memory** for persistent context across sessions.

### Quick Reference

| I want to... | Command |
|--------------|---------|
| Recall past work on a topic | `memory_query("topic")` |
| Find exact error/function name | `memory_search("exact term")` |
| Explore a concept semantically | `memory_vsearch("concept")` |
| Save a decision for future sessions | `memory_write("decision context")` |
| Check index health | `memory_status` |

### Session Workflow

**Start of session:** Check memory for relevant past context before exploring the codebase.
```
memory_query("what have we done regarding {current task topic}")
```

**End of session:** Save key decisions, patterns discovered, and debugging insights.
```
memory_write("## Summary\n- Decision: ...\n- Why: ...\n- Files: ...")
```

### When to Search Memory vs Codebase

- **"Have we done this before?"** → `memory_query` (searches past sessions)
- **"Where is this in the code?"** → grep / ast-grep (searches current files)
- **"How does this concept work here?"** → Both (memory for past context + grep for current code)

<!-- OPENCODE-MEMORY:END -->
