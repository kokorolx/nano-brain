# nano-brain

Persistent memory and code intelligence for AI coding agents.

## What It Does

An MCP server that gives AI coding agents persistent memory across sessions. Indexes markdown documents, past sessions, daily logs, and codebase symbols into a searchable SQLite database with FTS5 and vector embeddings. Provides 17 MCP tools for search, retrieval, code intelligence, and memory management using a hybrid search pipeline with RRF fusion and VoyageAI neural reranking.

## Key Features

- **Hybrid search pipeline** — BM25 + vector + RRF fusion + VoyageAI neural reranking with 6 ranking signals
- **Code intelligence** — symbol graph, call flow detection, impact analysis, change detection via Tree-sitter AST
- **Automatic data ingestion** — session harvesting (2min poll), file watching (chokidar), codebase indexing
- **Multi-workspace isolation** — per-workspace SQLite databases, cross-workspace search with `--scope=all`
- **Flexible embedding providers** — VoyageAI, Ollama, OpenAI-compatible
- **Dual vector stores** — Qdrant (production) or sqlite-vec (embedded)
- **Privacy-first** — 100% local processing option, your code never leaves your machine
- **MCP + CLI** — stdio/HTTP/SSE transports for local or containerized environments

Inspired by [QMD](https://github.com/tobi/qmd) and [OpenClaw](https://github.com/openclaw/openclaw).

## Architecture

```
User Query
    │
    ▼
┌─────────────────┐
│ Query Expansion  │ ← (currently stubbed, planned)
│ (optional)       │   generates 2-3 query variants
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│ BM25   │ │ Vector   │
│ (FTS5) │ │ (Qdrant  │
│        │ │  or      │
│        │ │ sqlite-  │
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
│ PageRank Boost  │ ← Centrality from file dependency graph
│                 │   weight: 0.1 (default)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Supersede       │ ← 0.3× demotion for replaced documents
│ Demotion        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Neural Reranking│ ← VoyageAI rerank-2.5-lite
│ (optional)      │
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

## Search Pipeline (3 Tiers)

**`memory_search`** — BM25 only (fast, exact keyword matching)

**`memory_vsearch`** — Vector only (semantic similarity via embeddings)

**`memory_query`** — Full hybrid pipeline with 6 ranking signals:

1. **BM25 full-text scoring** — SQLite FTS5 with porter stemming
2. **Vector cosine similarity** — Qdrant or sqlite-vec embeddings
3. **RRF fusion** — k=60, original query weighted 2×
4. **PageRank centrality boost** — from file dependency graph (weight: 0.1)
5. **Supersede demotion** — 0.3× penalty for replaced documents
6. **VoyageAI neural reranking** — rerank-2.5-lite with position-aware blending:
   - Top 3 results: 75% RRF / 25% rerank
   - Ranks 4-10: 60% RRF / 40% rerank
   - Ranks 11+: 40% RRF / 60% rerank

Query expansion generates 2-3 query variants before search. The pipeline supports it, but no expansion provider is currently active.

## Code Intelligence

Built on Tree-sitter AST parsing for TypeScript, JavaScript, and Python:

**`code_context`** — 360° view of a code symbol:
- Direct callers and callees
- Transitive call flows (upstream/downstream)
- File location, definition, and references
- Centrality score (PageRank) and cluster membership

**`code_impact`** — Change impact analysis:
- Upstream dependencies (what calls this?)
- Downstream dependencies (what does this call?)
- BFS traversal with configurable depth
- Risk assessment for refactoring

**`code_detect_changes`** — Map git diff to affected symbols:
- Parses `git diff` output
- Identifies modified symbols via Tree-sitter
- Returns symbol names, types, and file locations
- Scope: `staged`, `unstaged`, or `all`

**`memory_focus`** — File dependency context:
- Import/export graph for a file
- Centrality score (PageRank)
- Cluster membership (Louvain algorithm)
- Direct dependencies and dependents

**`memory_graph_stats`** — Dependency graph overview:
- Total files, symbols, edges
- Cycle detection
- Clustering coefficient
- Top central files

**Symbol tracking** — Cross-repo symbol queries:
- Redis keys, PubSub channels
- MySQL tables, columns
- API endpoints (Express, FastAPI)
- Bull/BullMQ queues
- GraphQL types, queries, mutations

## Data Ingestion

All data sources are indexed automatically:

**Session harvesting** — Converts OpenCode JSON sessions into searchable markdown:
- Polls `~/.opencode/sessions/` every 2 minutes
- Extracts user queries, assistant responses, tool calls
- Incremental append (hash-based deduplication)

**File watching** — Monitors collections for changes:
- Chokidar watches configured directories
- Dirty-flag tracking for incremental updates
- Reindexes every 5 minutes if changes detected

**Codebase indexing** — Tree-sitter AST → symbol graph:
- Parses TS/JS/Python files
- Extracts functions, classes, methods, variables
- Builds call graph (caller → callee edges)
- Computes PageRank centrality
- Detects clusters via Louvain algorithm
- Identifies call flows (entry points → leaf functions)

**Incremental behavior**:
- Hash-based file skipping (SHA-256 content addressing)
- Adaptive embedding backoff (exponential retry)
- Batch processing for large codebases

## Chunking Strategy

Heading-aware markdown chunking that respects document structure:

- **Target size:** 900 tokens (~3600 characters)
- **Overlap:** 15% between chunks (~540 characters)
- **Respects boundaries:** Code fences, headings, paragraphs
- **Break point scoring:** h1=100, h2=90, h3=80, code-fence=80, hr=60, blank-line=40
- **Content-addressed storage:** SHA-256 hash deduplication

## Storage & Infrastructure

**SQLite** (via better-sqlite3):
- `documents` — metadata, content, embeddings
- `chunks` — heading-aware markdown chunks (900 tokens, 15% overlap)
- `fts_index` — FTS5 virtual table with porter stemming
- `vec_index` — sqlite-vec extension (cosine distance)
- `symbols` — code symbols (functions, classes, variables)
- `call_edges` — caller → callee relationships
- `file_deps` — import/export graph
- `clusters` — Louvain clustering results
- `flows` — detected call flows (entry → leaf)

**Qdrant** (optional, production vector store):
- Managed via `qdrant up/down/status/migrate/verify/activate/cleanup` commands
- Docker-based deployment
- Automatic migration from sqlite-vec
- Verification and cleanup tools

**Embedding providers**:
- **VoyageAI** — voyage-code-3 (1024 dims, code-optimized)
- **Ollama** — local models (nomic-embed-text, etc.)
- **OpenAI-compatible** — Azure, LM Studio, custom endpoints

**Reranking**:
- **VoyageAI** — rerank-2.5-lite (neural reranking)

**Storage management**:
- Per-workspace SQLite databases (isolated)
- Content-addressed storage (SHA-256 deduplication)
- Retention policies (maxSize budget, auto-cleanup)
- Disk space checks before indexing

## MCP Tools (17 Total)

### Search & Retrieval

| Tool | Description |
|------|-------------|
| `memory_search` | BM25 keyword search (fast, exact matching) |
| `memory_vsearch` | Semantic vector search (embeddings) |
| `memory_query` | Full hybrid search (BM25 + vector + RRF + reranking) |
| `memory_get` | Retrieve document by path or docid (#abc123) |
| `memory_multi_get` | Batch retrieve by glob pattern |

### Memory Management

| Tool | Description |
|------|-------------|
| `memory_write` | Write to daily log (supports tags, supersedes) |
| `memory_tags` | List all tags with document counts |
| `memory_status` | Index health, collections, model status, graph stats |
| `memory_update` | Trigger reindex of all collections |

### Code Intelligence

| Tool | Description |
|------|-------------|
| `code_context` | 360° view of a code symbol (callers, callees, flows, centrality) |
| `code_impact` | Change impact analysis (upstream/downstream BFS) |
| `code_detect_changes` | Map git diff to affected symbols (staged/unstaged/all) |
| `memory_index_codebase` | Index codebase files in current workspace (Tree-sitter AST) |

### Dependency Graph

| Tool | Description |
|------|-------------|
| `memory_focus` | File dependency context (imports/exports, centrality, cluster) |
| `memory_graph_stats` | Dependency graph overview (files, symbols, edges, cycles) |
| `memory_symbols` | Cross-repo symbol query (Redis, MySQL, API endpoints, queues) |
| `memory_impact` | Cross-repo impact analysis (writers vs readers) |

## Installation & Quick Start

```bash
# Install globally
npm install -g nano-brain

# Initialize (creates config, indexes codebase, generates embeddings)
npx nano-brain init --root=/path/to/your/project

# Check everything is working
npx nano-brain status
```

### MCP Configuration

Add to your AI agent's MCP config (e.g., `~/.config/opencode/opencode.json`):

**Local mode (stdio):**
```json
{
  "mcp": {
    "nano-brain": {
      "type": "local",
      "command": ["npx", "nano-brain", "mcp"],
      "enabled": true
    }
  }
}
```

**Remote mode (HTTP/SSE, for Docker/containers):**
```json
{
  "mcp": {
    "nano-brain": {
      "type": "remote",
      "url": "http://host.docker.internal:3100/mcp",
      "enabled": true
    }
  }
}
```

Start the remote server:
```bash
npx nano-brain serve              # Background daemon (port 3100)
npx nano-brain serve --foreground # Foreground (for debugging)
npx nano-brain serve status       # Check if running
npx nano-brain serve stop         # Stop daemon
```

## Configuration

Create `~/.nano-brain/config.yml` (auto-generated by `init`):

```yaml
# Collections (directories to index)
collections:
  memory:
    path: ~/.nano-brain/memory
    pattern: "**/*.md"
    update: auto
  sessions:
    path: ~/.nano-brain/sessions
    pattern: "**/*.md"
    update: auto

# Vector store (qdrant or sqlite-vec)
vector:
  provider: qdrant
  url: http://localhost:6333
  collection: nano_brain
  # OR: provider: sqlite-vec (embedded, no external service)

# Embedding provider
embedding:
  provider: openai                    # 'ollama' or 'openai' (OpenAI-compatible)
  url: https://api.voyageai.com       # VoyageAI, Azure, LM Studio, etc.
  model: voyage-code-3
  apiKey: ${VOYAGE_API_KEY}
  # OR: provider: ollama, url: http://localhost:11434, model: nomic-embed-text

# Reranker (uses embedding.apiKey if not set separately)
reranker:
  model: rerank-2.5-lite
  # apiKey: ${VOYAGE_API_KEY}  # optional, falls back to embedding.apiKey

# Codebase indexing
codebase:
  enabled: true
  languages: [typescript, javascript, python]
  exclude: [node_modules, dist, build, .git]
  maxFileSize: 1048576  # 1MB

# File watcher
watcher:
  enabled: true
  debounce: 300         # ms
  reindexInterval: 300  # seconds (5 minutes)

# Search configuration
search:
  rrf_k: 60
  top_k: 30
  expansion:
    enabled: true
    weight: 1
  reranking:
    enabled: true
  blending:
    top3:
      rrf: 0.75
      rerank: 0.25
    mid:
      rrf: 0.60
      rerank: 0.40
    tail:
      rrf: 0.40
      rerank: 0.60
  centrality_weight: 0.1
  supersede_demotion: 0.3

# Polling intervals
intervals:
  sessionHarvest: 120   # seconds (2 minutes)
  healthCheck: 60       # seconds

# Storage management
storage:
  maxSize: 10737418240  # 10GB
  retention:
    sessions: 90        # days
    logs: 30            # days

# Workspaces
workspaces:
  isolation: true       # Per-workspace SQLite databases
  defaultScope: current # or 'all' for cross-workspace search

# Logging
logging:
  level: info           # debug, info, warn, error
  file: ~/.nano-brain/logs/nano-brain.log
  maxSize: 10485760     # 10MB
  maxFiles: 5
```

**Data directory layout (`~/.nano-brain/`):**
```
~/.nano-brain/
├── config.yml    # Configuration
├── data/         # SQLite databases (per-workspace)
├── memory/       # Curated notes
├── sessions/     # Harvested sessions
└── logs/         # Application logs
```

## CLI Commands (24 Total)

### Setup & Initialization

```bash
nano-brain init               # Full initialization (config, index, embed, AGENTS.md)
nano-brain init --root=/path  # Initialize for specific project
nano-brain status             # Show index health, collections, model status
```

### MCP Server

```bash
nano-brain mcp                                      # Start MCP server (stdio)
nano-brain mcp --http --port=3100 --host=0.0.0.0   # Start MCP server (HTTP/SSE)
```

### Remote Server (Daemon)

```bash
nano-brain serve              # Start SSE server as background daemon (port 3100)
nano-brain serve status       # Check if server is running
nano-brain serve stop         # Stop the daemon
nano-brain serve --foreground # Run in foreground (for debugging)
nano-brain serve --port=8080  # Custom port
```

### Search

```bash
nano-brain search "query"           # BM25 keyword search
nano-brain vsearch "query"          # Vector semantic search
nano-brain query "query"            # Hybrid search (BM25 + vector + reranking)
nano-brain query "query" --tags=bug,fix  # Filter by tags
nano-brain query "query" --scope=all     # Cross-workspace search
```

### Memory Management

```bash
nano-brain write "content"          # Write to daily log
nano-brain write "content" --tags=decision,architecture
nano-brain write "content" --supersedes=abc123  # Mark as replacement
nano-brain get <path>               # Retrieve document by path
nano-brain get "#abc123"            # Retrieve by docid
nano-brain tags                     # List all tags with counts
```

### Index Management

```bash
nano-brain update               # Reindex all collections
nano-brain index-codebase       # Index codebase in current workspace
nano-brain reset --confirm      # Reset all data (requires confirmation)
nano-brain reset --dry-run      # Preview what would be deleted
```

### Collections

```bash
nano-brain collection add <name> <path>     # Add collection
nano-brain collection remove <name>         # Remove collection
nano-brain collection list                  # List collections
```

### Workspace Management

```bash
nano-brain rm --list                        # List all workspaces
nano-brain rm <workspace> --dry-run         # Preview what would be deleted
nano-brain rm <workspace>                   # Remove workspace and all its data
# <workspace> can be: absolute path, hash prefix, or workspace name
```

### Qdrant Management

```bash
nano-brain qdrant up            # Start Qdrant Docker container
nano-brain qdrant down          # Stop Qdrant container
nano-brain qdrant status        # Check Qdrant status
nano-brain qdrant migrate       # Migrate from sqlite-vec to Qdrant
nano-brain qdrant verify        # Verify Qdrant data integrity
nano-brain qdrant activate      # Switch to Qdrant (update config)
nano-brain qdrant cleanup       # Remove orphaned vectors
```

### Cache Management

```bash
nano-brain cache clear          # Clear all caches
nano-brain cache clear --type=embeddings  # Clear specific cache type
nano-brain cache stats          # Show cache statistics
```

### Benchmarking

```bash
nano-brain bench                # Run default benchmark suite
nano-brain bench --suite=search # Run specific suite
nano-brain bench --iterations=100 --json --save
nano-brain bench --compare=baseline.json  # Compare with baseline
```

### Logging

```bash
nano-brain logs                 # Show recent logs (last 50 lines)
nano-brain logs -f              # Tail logs in real-time
nano-brain logs -n 100          # Show last 100 lines
nano-brain logs --date=2026-03-01  # Show log for specific date
nano-brain logs --clear         # Delete all log files
nano-brain logs path            # Print log directory path
```

## Project Structure

```
src/
├── index.ts          # CLI entry point
├── server.ts         # MCP server (17 tools, stdio/HTTP/SSE)
├── store.ts          # SQLite storage (FTS5 + sqlite-vec)
├── storage.ts        # Storage management (retention, disk space)
├── vector-store.ts   # Vector store abstraction (Qdrant + sqlite-vec)
├── search.ts         # Hybrid search pipeline (RRF, reranking, blending)
├── chunker.ts        # Heading-aware markdown chunking
├── collections.ts    # YAML config, collection scanning
├── embeddings.ts     # Embedding providers (VoyageAI, Ollama, OpenAI-compatible)
├── reranker.ts       # VoyageAI reranker
├── expansion.ts      # Query expansion (interface only, no active provider)
├── harvester.ts      # OpenCode session → markdown converter
├── watcher.ts        # File watcher (chokidar, dirty flags)
├── codebase.ts       # Codebase indexing orchestrator
├── treesitter.ts     # Tree-sitter AST parsing
├── symbols.ts        # Symbol extraction (functions, classes, variables)
├── graph.ts          # File dependency graph (imports/exports)
├── symbol-graph.ts   # Symbol call graph (caller → callee)
├── flow-detection.ts # Call flow detection (entry → leaf)
├── types.ts          # TypeScript interfaces
└── providers/        # Vector store implementations
    ├── qdrant.ts     # Qdrant vector store
    └── sqlite-vec.ts # sqlite-vec vector store
bin/
└── cli.js            # CLI wrapper

test/
└── *.test.ts         # 760+ tests (vitest)
SKILL.md              # AI agent routing instructions (auto-loaded by OpenCode)
AGENTS_SNIPPET.md     # Optional project-level AGENTS.md managed block
```

## Tech Stack

- **TypeScript + Node.js** (via tsx)
- **better-sqlite3** + **sqlite-vec** for embedded storage
- **Qdrant** for production vector store (optional)
- **Tree-sitter** for AST parsing (TS, JS, Python)
- **@modelcontextprotocol/sdk** for MCP server (stdio/HTTP/SSE transports)
- **chokidar** for file watching
- **vitest** for testing (760+ tests)

## Embedding & Reranking Providers

**Embeddings:**
- **VoyageAI** — voyage-code-3 (1024 dims, code-optimized, recommended)
- **Ollama** — nomic-embed-text, mxbai-embed-large, etc. (local, free)
- **OpenAI-compatible** — Azure OpenAI, LM Studio, custom endpoints

**Reranking:**
- **VoyageAI** — rerank-2.5-lite (neural reranking, recommended)

**Query Expansion:**
- Pipeline support exists but no active provider. The interface is ready for future integration.

## How nano-brain Compares

| | nano-brain | Mem0 / OpenMemory | Zep / Graphiti | OMEGA | Letta (MemGPT) | Claude Native |
|---|---|---|---|---|---|---|
| **Search** | Hybrid (BM25 + vector + 6 ranking signals) | Vector only | Graph traversal + vector | Semantic + BM25 | Agent-managed | Text file read |
| **Storage** | SQLite + Qdrant (optional) | PostgreSQL + Qdrant | Neo4j | SQLite | PostgreSQL / SQLite | Flat text files |
| **MCP Tools** | 17 | 4-9 | 9-10 | 12 | 7 | 0 |
| **Code Intelligence** | Yes (Tree-sitter AST, symbol graph, impact analysis) | No | No | No | No | No |
| **Codebase Indexing** | Yes (AST → symbols → call graph → flows) | No | No | No | No | No |
| **Session Recall** | Yes (auto-harvests past sessions) | No | No | No | No | Limited (CLAUDE.md) |
| **Query Expansion** | Pipeline ready (no active provider) | No | No | No | No | No |
| **Neural Reranking** | Yes (VoyageAI rerank-2.5-lite) | No | No | No | No | No |
| **Local-First** | Yes (Ollama + sqlite-vec) | Requires OpenAI API key | Requires Docker + Neo4j | Yes | Yes | Yes |
| **Cloud Option** | Yes (VoyageAI, OpenAI-compatible) | Cloud API (OpenAI) | Cloud API | Local ONNX | Cloud API | None |
| **Privacy** | 100% local option available | Cloud API calls | Cloud or self-host | 100% local | Self-host or cloud | Local files |
| **Dependencies** | SQLite + embedding API (+ optional Qdrant) | Docker + PostgreSQL + Qdrant + OpenAI key | Docker + Neo4j | SQLite + ONNX | PostgreSQL | None |
| **Pricing** | Free (open source, MIT) | Free tier / Pro $249/mo | Free self-host / Cloud $25-475/mo | Free (Apache-2.0) | Free (Apache-2.0) | Free (with Claude) |
| **GitHub Stars** | New | ~47K | ~23K | ~25 | ~21K | N/A |

### Where nano-brain shines

- **6-signal hybrid search** — BM25 + vector + RRF + PageRank + supersede + neural reranking in a single pipeline
- **Code intelligence** — Tree-sitter AST parsing, symbol graph, call flow detection, impact analysis
- **Codebase indexing** — index your source files with structural boundary detection, not just conversations
- **Session recall** — automatically harvests and indexes past AI coding sessions
- **Flexible deployment** — 100% local (Ollama + sqlite-vec) or cloud (VoyageAI + Qdrant)
- **Privacy-first** — local processing option, your code never leaves your machine

### Consider alternatives if

- You need a knowledge graph with temporal reasoning (Zep/Graphiti)
- You want a full agent framework, not just memory (Letta)
- You need cloud-hosted memory shared across teams (Mem0 Cloud)
- You only need basic session notes (Claude native memory)

## AI Agent Integration

nano-brain ships with a SKILL.md that teaches AI agents when and how to use memory tools. When loaded as an OpenCode skill, agents automatically:

- **Check memory before starting work** — recall past decisions, patterns, and context
- **Save context after completing work** — persist key decisions and debugging insights
- **Route queries to the right search tool** — BM25 for exact terms, vector for concepts, hybrid for best quality
- **Use code intelligence** — understand symbol relationships, assess change impact, detect affected code

### SKILL.md (Auto-loaded)

The skill file at `SKILL.md` provides routing rules, trigger phrases, tool selection guides, and integration patterns. It's automatically loaded when any agent references the `nano-brain` skill.

### AGENTS_SNIPPET.md (Optional, project-level)

For project-level integration, `AGENTS_SNIPPET.md` provides a managed block that can be injected into a project's `AGENTS.md`:

```bash
npx nano-brain init --root=/path/to/project
```

This adds a managed block to your project's `AGENTS.md` with quick reference tables for CLI commands and MCP tools (if available).

See [SKILL.md](./SKILL.md) for full routing rules and [AGENTS_SNIPPET.md](./AGENTS_SNIPPET.md) for the project-level snippet.

## Self-Learning Configuration

nano-brain includes an adaptive self-learning system that improves search quality over time.

### Quick Start

Add to your `config.yml`:

```yaml
telemetry:
  enabled: true          # Log search queries and feedback (default: true)
  retention_days: 90     # How long to keep telemetry data

learning:
  enabled: true          # Enable adaptive search tuning
  update_interval_ms: 600000  # Cold-path update interval (10 min)

consolidation:
  enabled: true          # Enable memory consolidation
  interval_ms: 3600000   # Consolidation interval (60 min)
  model: gpt-4o-mini     # LLM model for consolidation
  endpoint: https://api.openai.com/v1  # OpenAI-compatible endpoint
  apiKey: sk-...         # API key

importance:
  enabled: true          # Enable importance scoring
  weight: 0.1            # Importance boost weight
  decay_half_life_days: 30

intents:
  enabled: true          # Enable query intent classification
```

### How It Works

1. **Telemetry**: Every search query is logged with results and timing. When you expand a result, it's recorded as positive feedback.
2. **Thompson Sampling**: Search parameters (rrf_k, centrality_weight) are automatically tuned using multi-armed bandits based on expand feedback.
3. **Consolidation**: Periodically, an LLM reviews recent memories and finds connections, generating consolidated insights.
4. **Importance Scoring**: Documents accessed frequently get boosted in search results. Unused documents decay over time.
5. **Intent Classification**: Queries are classified by intent (lookup, explanation, architecture, recall) and routed to optimized search configs.

### CLI Commands

- `nano-brain learning rollback [version_id]` — View or rollback to a previous config version
- `nano-brain consolidate` — Trigger a manual consolidation cycle

### MCP Tools

- `memory_consolidate` — Trigger consolidation manually
- `memory_importance` — View document importance scores
- `memory_status` — View learning system status (telemetry records, bandit variants, config version)

## License

MIT
