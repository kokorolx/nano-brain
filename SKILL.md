# nano-brain

Persistent memory for AI coding agents. Hybrid search (BM25 + semantic + LLM reranking) across past sessions, codebase, notes, and daily logs.

## Slash Commands

| Command | When to Use |
|---------|-------------|
| `/nano-brain-init` | First time in a workspace — indexes codebase and sets up memory |
| `/nano-brain-status` | Check health: document counts, embedding progress, server status |
| `/nano-brain-reindex` | After git pull, branch switch, or major code changes |

## CLI Commands

All memory operations use the `npx nano-brain` CLI via the Bash tool.

### Search

| Command | Use When | Speed |
|---------|----------|-------|
| `npx nano-brain query "search terms"` | Best quality, complex questions (BM25 + vector + reranking) | Slower |
| `npx nano-brain search "search terms"` | Exact keyword: error messages, function names, specific terms | Fast |
| `npx nano-brain vsearch "search terms"` | Conceptual: "how does auth work", "payment flow" | Medium |

**Default: Use `npx nano-brain query`** — it gives best results for most questions.

**Search options:**
- `-n <limit>` — Max results (default: 10)
- `-c <collection>` — Filter by collection (codebase, sessions, memory)
- `--full` — Show full content of results
- `--json` — Output as JSON
- `--files` — Show file paths only
- `--min-score=<n>` — Minimum score threshold
- `--scope=all` — Search across all workspaces
- `--tags=<comma-separated>` — Filter by tags (AND logic)
- `--since=<date>` — Filter by date (ISO format)
- `--until=<date>` — Filter by date (ISO format)

### Retrieval

| Command | Use When |
|---------|----------|
| `npx nano-brain get <docid-or-path>` | Retrieve specific document by path or docid |
| `npx nano-brain get <id> --full` | Full content with all metadata |
| `npx nano-brain get <id> --from=<line> --lines=<n>` | Specific line range |

### Management

| Command | Use When |
|---------|----------|
| `npx nano-brain status` | Check index health, embedding progress |
| `npx nano-brain update` | Refresh all collection indexes |
| `npx nano-brain harvest` | Harvest past AI sessions into searchable markdown |
| `npx nano-brain embed` | Generate embeddings for unembedded chunks |
| `npx nano-brain init --root=<path>` | Re-index a workspace |
| `npx nano-brain write "content" [--supersedes=<path-or-docid>] [--tags=<tags>]` | Write to daily log |
| `npx nano-brain focus <filepath>` | Show file dependencies, dependents, centrality, cluster |
| `npx nano-brain graph-stats` | Show import graph statistics (nodes, edges, clusters, top centrality, cycles) |
| `npx nano-brain tags` | List all tags with counts |
| `npx nano-brain symbols [--type=<type>] [--pattern=<glob>] [--repo=<name>] [--operation=<op>]` | Query cross-repo symbols |
| `npx nano-brain impact --type=<type> --pattern=<pattern>` | Cross-repo impact analysis |

### Writing Notes

Use the `write` command to save notes with optional tags and supersede old information:

```bash
# Save a decision with tags
npx nano-brain write "Decision: Use Redis for session storage. Why: Better performance than DB." --tags=decision,redis

# Supersede old information
npx nano-brain write "Updated: Now using Redis Cluster" --supersedes=~/.nano-brain/memory/2026-03-01-redis.md --tags=decision,redis
```

Alternatively, create a markdown file directly and run `npx nano-brain update` to index it.

## When to Use Memory

**Before starting work:**
- Recall past decisions on similar features
- Find debugging insights from previous sessions
- Check existing patterns in codebase

**After completing work:**
- Save key architectural decisions
- Document non-obvious fixes
- Record domain knowledge for future sessions

## Collection Filtering

Add `-c <collection>` to narrow search scope:

| Collection | Contains |
|------------|----------|
| `codebase` | Source files from workspace |
| `sessions` | Past AI coding sessions |
| `memory` | Daily logs (tagged with workspace context) |

Omit `-c` to search everything (recommended for most queries).

## Memory vs Native Tools

| Task | Use |
|------|-----|
| Semantic search, past context, cross-session recall | **nano-brain** |
| Exact code patterns, AST structure, precise matches | **grep, ast-grep, glob** |

They complement each other. Use both.

## MCP Tools

Available via the nano-brain MCP server:

| Tool | Purpose |
|------|---------|
| `memory_focus` | File dependency neighborhood (dependencies, dependents, centrality, cluster) |
| `memory_graph_stats` | Import graph statistics (nodes, edges, clusters, top centrality, cycles) |
| `memory_tags` | List all tags with counts |
| `memory_symbols` | Query cross-repo symbols (Redis keys, API endpoints, DB tables, etc.) |
| `memory_impact` | Cross-repo impact analysis (writers vs readers, publishers vs subscribers) |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 0 codebase docs | Run `/nano-brain-init` |
| Embeddings stuck | Check Ollama running: `ollama serve` |
| Stale results | Run `/nano-brain-reindex` |
| New notes not searchable | Run `npx nano-brain update` |
