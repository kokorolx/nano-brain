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

### Session Workflow

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





## File Writing Rules (MANDATORY)

**NEVER write an entire file at once.** Always use chunk-by-chunk editing:

1. **Use the Edit tool** (find-and-replace) for all file modifications — insert, update, or delete content in targeted chunks
2. **Only use the Write tool** for brand-new files that don't exist yet, AND only if the file is small (< 50 lines)
3. **For new large files (50+ lines):** Write a skeleton first (headers/structure only), then use Edit to fill in each section chunk by chunk
4. **Why:** Writing entire files at once causes truncation, context window overflow, and silent data loss on large files

**Anti-patterns (NEVER do these):**
- `Write` tool to overwrite an existing file with full content
- `Write` tool to create a file with 100+ lines in one shot
- Regenerating an entire file to change a few lines

## Development Workflow

### OpenSpec-First (MANDATORY)

**Every feature, fix, or refactor MUST go through OpenSpec before implementation.**

1. **Propose** → `openspec new change "<name>"` → create proposal.md, design.md, specs, tasks.md
2. **Validate** → `openspec validate "<name>" --strict --no-interactive`
3. **Implement** → `/opsx-apply` or work through tasks.md
4. **Archive** → `openspec archive "<name>"` after merge

**No exceptions.** Do not skip straight to coding. The proposal captures *why*, the spec captures *what*, the design captures *how*, and tasks capture *the plan*. This applies to:
- New features (even small ones)
- Bug fixes that change behavior
- Refactors that touch multiple files

**Only skip OpenSpec for:** typo fixes, dependency bumps, or single-line config changes.
