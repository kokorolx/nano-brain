<!-- OPENCODE-MEMORY:START -->
<!-- Managed block - do not edit manually. Updated by: npx nano-brain init -->

## Memory System (nano-brain)

This project uses **nano-brain** for persistent context across sessions.

### Quick Reference

All commands use the CLI via Bash tool:

| I want to... | Command |
|--------------|---------|
| Recall past work on a topic | `npx nano-brain query "topic"` |
| Find exact error/function name | `npx nano-brain search "exact term"` |
| Explore a concept semantically | `npx nano-brain vsearch "concept"` |
| Save a decision for future sessions | Create file in `~/.nano-brain/memory/`, then `npx nano-brain update` |
| Check index health | `npx nano-brain status` |
| Write a note with tags | `npx nano-brain write "content" --tags=decision,auth` |
| Supersede old info | `npx nano-brain write "new info" --supersedes=<path>` |
| See file dependencies | `npx nano-brain focus src/server.ts` |
| Find cross-repo Redis usage | `npx nano-brain symbols --type=redis_key --pattern="sinv:*"` |
| Analyze cross-repo impact | `npx nano-brain impact --type=redis_key --pattern="sinv:*:compressed"` |
| Search across all workspaces | `npx nano-brain query "topic" --scope=all` |
| Filter by tags | `npx nano-brain query "topic" --tags=decision` |

### Session Workflow

**Start of session:** Check memory for relevant past context before exploring the codebase.
```
npx nano-brain query "what have we done regarding {current task topic}"
```

**End of session:** Save key decisions, patterns discovered, and debugging insights.
```bash
cat > ~/.nano-brain/memory/$(date +%Y-%m-%d)-summary.md << 'EOF'
## Summary
- Decision: ...
- Why: ...
- Files: ...
EOF
npx nano-brain update
```

### When to Search Memory vs Codebase

- **"Have we done this before?"** → `npx nano-brain query` (searches past sessions)
- **"Where is this in the code?"** → grep / ast-grep (searches current files)
- **"How does this concept work here?"** → Both (memory for past context + grep for current code)

<!-- OPENCODE-MEMORY:END -->
