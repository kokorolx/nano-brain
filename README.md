# opencode-memory

Persistent memory system for OpenCode. Hybrid search (BM25 + vector + LLM reranking) across past sessions, codebase, curated notes, and daily logs.

## What It Does

An MCP server that gives OpenCode persistent memory across sessions. Indexes markdown documents, past sessions, and daily logs into a searchable SQLite database with FTS5 and vector embeddings. Provides 10 MCP tools for search, retrieval, and memory management using a sophisticated hybrid search pipeline with query expansion, RRF fusion, and neural reranking.

Inspired by [QMD](https://github.com/tobi/qmd).

## Architecture

```
User Query
    │
    ▼
┌─────────────────┐
│ Query Expansion  │ ← qmd-query-expansion-1.7B (GGUF)
│ (optional)       │   generates 2-3 query variants
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│ BM25   │ │ Vector   │
│ (FTS5) │ │(sqlite-  │
│        │ │  vec)    │
└───┬────┘ └────┬─────┘
    │           │
    ▼           ▼
┌─────────────────┐
│  RRF Fusion     │ ← k=60, original query 2× weight
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LLM Reranking  │ ← bge-reranker-v2-m3 (GGUF)
│  (optional)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Position-Aware  │ ← top 3: 75/25, 4-10: 60/40, 11+: 40/60
│ Blending        │   (RRF weight / rerank weight)
└────────┬────────┘
         │
         ▼
    Final Results
```

## How It Works

### Storage Layer

- **SQLite** via better-sqlite3 for document metadata and content
- **FTS5** virtual table with porter stemming for BM25 full-text search
- **sqlite-vec** extension for vector similarity search (cosine distance)
- **Content-addressed storage** using SHA-256 hash deduplication

### Chunking

Heading-aware markdown chunking that respects document structure:

- **Target size:** 900 tokens (~3600 characters)
- **Overlap:** 15% between chunks (~540 characters)
- **Respects boundaries:** Code fences, headings, paragraphs
- **Break point scoring:** h1=100, h2=90, h3=80, code-fence=80, hr=60, blank-line=40

### Search Pipeline (3 Tiers)

**`memory_search`** — BM25 only (fast, exact keyword matching)

**`memory_vsearch`** — Vector only (semantic similarity via embeddings)

**`memory_query`** — Full hybrid pipeline:
1. Query expansion generates 2-3 variants (optional)
2. Parallel BM25 + vector search
3. RRF fusion (k=60, original query weighted 2×)
4. LLM reranking with bge-reranker-v2-m3 (optional)
5. Position-aware blending:
   - Top 3 results: 75% RRF / 25% rerank
   - Ranks 4-10: 60% RRF / 40% rerank
   - Ranks 11+: 40% RRF / 60% rerank

### Collections

- **YAML-configured** directories of markdown files
- **Auto-indexing** via chokidar file watcher
- **Incremental updates** using dirty-flag tracking
- **Session harvesting** converts OpenCode JSON sessions into searchable markdown

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search` | BM25 keyword search (fast) |
| `memory_vsearch` | Semantic vector search |
| `memory_query` | Full hybrid search with expansion + reranking |
| `memory_get` | Retrieve document by path or docid (#abc123) |
| `memory_multi_get` | Batch retrieve by glob pattern |
| `memory_write` | Write to daily log or MEMORY.md |
| `memory_status` | Index health, collections, model status |
| `memory_index_codebase` | Index codebase files in current workspace |
| `memory_update` | Trigger reindex of all collections |

## Installation

```bash
# Clone and install
git clone <repo-url>
cd opencode-memory
npm install
```

Add to OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "opencode-memory": {
      "type": "local",
      "command": ["node", "/path/to/opencode-memory/bin/cli.js", "mcp"],
      "enabled": true
    }
  }
}
```

## Configuration

Create `~/.config/opencode-memory/config.yml`:

```yaml
collections:
  memory:
    path: ~/.opencode-memory
    pattern: "**/*.md"
    update: auto
  
  project-docs:
    path: /path/to/project/docs
    pattern: "**/*.md"
    update: auto
  
  sessions:
    path: ~/.local/share/opencode/sessions
    pattern: "**/*.json"
    update: auto
```

**Collection options:**
- `path` — Directory to index
- `pattern` — Glob pattern for files
- `update` — `auto` (watch for changes) or `manual`

## CLI Usage

```bash
# MCP server
opencode-memory mcp              # Start MCP server (stdio)
opencode-memory mcp --http       # Start MCP server (HTTP, port 8282)

# Index management
opencode-memory status           # Show index health
opencode-memory update           # Reindex all collections

# Search
opencode-memory search "query"   # BM25 search
opencode-memory vsearch "query"  # Vector search
opencode-memory query "query"    # Hybrid search

# Collections
opencode-memory collection add <name> <path>     # Add collection
opencode-memory collection remove <name>         # Remove collection
opencode-memory collection list                  # List collections
```

## Project Structure

```
src/
├── index.ts          # CLI entry point
├── server.ts         # MCP server (10 tools, stdio/HTTP)
├── store.ts          # SQLite storage (FTS5 + sqlite-vec)
├── search.ts         # Hybrid search pipeline (RRF, reranking, blending)
├── chunker.ts        # Heading-aware markdown chunking
├── collections.ts    # YAML config, collection scanning
├── embeddings.ts     # GGUF embedding model (nomic-embed-text-v1.5)
├── reranker.ts       # GGUF reranker model (bge-reranker-v2-m3)
├── expansion.ts      # GGUF query expansion (qmd-query-expansion-1.7B)
├── harvester.ts      # OpenCode session → markdown converter
├── watcher.ts        # File watcher (chokidar, dirty flags)
└── types.ts          # TypeScript interfaces
bin/
└── cli.js            # CLI wrapper

test/
└── *.test.ts         # 428 tests (vitest)
SKILL.md              # AI agent routing instructions (auto-loaded by OpenCode)
AGENTS_SNIPPET.md     # Optional project-level AGENTS.md managed block
```

## Tech Stack

- **TypeScript + Node.js** (via tsx)
- **better-sqlite3** + **sqlite-vec** for storage
- **@modelcontextprotocol/sdk** for MCP server
- **node-llama-cpp** for GGUF model inference
- **chokidar** for file watching
- **vitest** for testing (428 tests)

## Models

All models are GGUF format, loaded on-demand:

- **Embeddings:** nomic-embed-text-v1.5 (~270MB)
- **Reranker:** bge-reranker-v2-m3 (~1.1GB)
- **Query Expansion:** qmd-query-expansion-1.7B (~1GB)

Models are downloaded automatically on first use to `~/.cache/opencode-memory/models/`.

## AI Agent Integration

opencode-memory ships with a SKILL.md that teaches AI agents when and how to use memory tools. When loaded as an OpenCode skill, agents automatically:

- **Check memory before starting work** — recall past decisions, patterns, and context
- **Save context after completing work** — persist key decisions and debugging insights
- **Route queries to the right search tool** — BM25 for exact terms, vector for concepts, hybrid for best quality

### SKILL.md (Auto-loaded)

The skill file at `SKILL.md` provides routing rules, trigger phrases, tool selection guides, and integration patterns. It's automatically loaded when any agent references the `opencode-memory` skill.

### AGENTS_SNIPPET.md (Optional, project-level)

For project-level integration, `AGENTS_SNIPPET.md` provides a managed block that can be injected into a project's `AGENTS.md`:

```bash
# Future: npx opencode-memory init
# For now: copy the managed block from AGENTS_SNIPPET.md into your project's AGENTS.md
```

See [SKILL.md](./SKILL.md) for full routing rules and [AGENTS_SNIPPET.md](./AGENTS_SNIPPET.md) for the project-level snippet.

## License

MIT
