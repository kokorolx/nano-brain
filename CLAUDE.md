# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**nano-brain** is a persistent memory and code intelligence MCP server for AI coding agents. It ingests AI sessions, notes, and codebases into a searchable index using hybrid search (BM25 + vector + RRF fusion + PageRank + neural reranking). The project is both a CLI tool and an MCP server consumed by agents like OpenCode/Claude Code.

## Commands

```bash
# Run tests (all)
npm test

# Watch mode
npm run test:watch

# Run a single test file
npx vitest run test/search.test.ts

# Run benchmarks
npm run bench

# Start MCP server (stdio, for agent integration)
node bin/cli.js mcp

# Start HTTP/SSE server (for Docker)
node bin/cli.js mcp --http --port=3100

# Docker deployment (nano-brain + Qdrant)
node bin/cli.js docker start
node bin/cli.js docker status

# Search CLI
node bin/cli.js query "your query"
node bin/cli.js context <symbol>     # Code intelligence
node bin/cli.js status               # Index health

# Build web UI
cd src/web && npm run build
```

**Test environment:** Vitest with `forks` pool, 8GB heap per test, 10s timeout. Tests must not rely on global state between runs.

## Architecture

### Hybrid Search Pipeline (`src/search.ts`)
The core search pipeline applies 6 ranking signals in order:
1. **BM25** via SQLite FTS5 (`documents_fts` table)
2. **Vector cosine similarity** via Qdrant (primary) or sqlite-vec (embedded fallback)
3. **RRF fusion** (k=60) blending BM25 and vector scores
4. **PageRank centrality boost** from the file dependency graph
5. **Supersede demotion** for stale/replaced documents
6. **VoyageAI neural reranking** (`rerank-2.5-lite`) as final pass

The search parameters are tuned via Thompson Sampling bandits (`src/bandits.ts`).

### Storage Layer (`src/store/`)
All persistence is SQLite (`better-sqlite3`, WAL mode). The 18-table schema includes:
- `documents` / `chunks` / `content` — content-addressed storage with heading-aware chunking (900 tokens, 15% overlap)
- `documents_fts` — SQLite FTS5 full-text index
- `symbols` / `call_edges` / `file_deps` / `flows` — code intelligence graph
- `entities` / `relationships` — LLM-extracted knowledge graph
- `telemetry` / `bandit_variants` / `category_preferences` — self-learning data

Each workspace gets its own SQLite database under `~/.nano-brain/`.

### Code Intelligence (`src/treesitter.ts`, `src/symbols.ts`, `src/symbol-graph.ts`)
Tree-sitter AST parsing for TypeScript, JavaScript, and Python. Symbol extraction feeds a call graph (caller → callee) and file dependency graph. Impact analysis and call flow detection (`src/flow-detection.ts`) are derived from these graphs. **When extending language support, add bindings here.**

### MCP Server (`src/mcp/`)
22+ tools registered via `@modelcontextprotocol/sdk`. Supports stdio, HTTP, and SSE transports. Tool categories: memory search/write, code intelligence, graph traversal, indexing. The HTTP server (`src/http/`) is hand-rolled — no Express.

### Background Jobs (`src/jobs/`)
9 jobs run on Node.js timers:
- File reindex (5 min), session harvest (2 min), embedding (60s adaptive)
- Consolidation via LLM (1 hour), importance scoring (30 min), entity pruning (6h soft / 7d hard)
- Sequence analysis (30 min), learning cycle (10 min)

Job configuration lives in `~/.nano-brain/config.yml` under `intervals:`.

### Data Ingestion
- **Session harvester** (`src/harvester.ts`): converts OpenCode JSON sessions → markdown observations
- **File watcher** (`src/watcher.ts`): chokidar-based incremental reindex on file changes
- **Codebase indexer** (`src/codebase.ts`): orchestrates symbol extraction + chunking + embedding

### Self-Learning (`src/bandits.ts`, `src/preference-model.ts`)
Thompson Sampling tunes RRF blend weights and reranking thresholds based on search telemetry. Category preference weights adapt to which content types the user retrieves most. This runs in the background — do not break the telemetry event pipeline in `src/event-store.ts`.

## Key Conventions

- **No external HTTP framework**: HTTP server uses raw Node.js `http` module. Do not introduce Express or similar.
- **SQLite is always local**: Qdrant is used for production vectors; sqlite-vec was deprecated. For new vector operations, target Qdrant.
- **Content addressing**: Documents are deduplicated by SHA-256 hash. The `content` table stores raw content; `documents` stores metadata.
- **Workspace isolation**: Every project indexes into a separate SQLite DB keyed by workspace path. Cross-workspace search is opt-in.
- **Configuration via YAML + Zod**: All config goes through `~/.nano-brain/config.yml`, validated by Zod schemas. See `config.default.yml` for the full schema.
- **CLI entrypoint**: `bin/cli.js` is a thin wrapper that runs `dist/cli/index.js` if it exists, otherwise falls back to `tsx src/cli/index.ts`. Do not require a build step for development.
- **Incremental updates everywhere**: Hash-based dirty detection prevents redundant re-processing. Preserve this invariant when adding new index types.

## Git & PR Conventions

- **No agent footers in commits or PRs**: Do not add `Co-Authored-By`, `🤖 Generated with`, or any agent attribution lines to commit messages or PR descriptions.
- **Every npm publish must have a changelog**: Whether beta or latest, always create a GitHub release with release notes before or immediately after publishing. Release notes must describe what changed, which files, and why.
- **Create a GitHub issue before starting any task**: For every bug, feature, or request from the user, create a GitHub issue with full context (problem, expected behavior, files to change, acceptance criteria) before writing any code.

## Testing Patterns

Integration tests spin up real SQLite databases in temp directories. The `test/fixtures/` directory contains corpora for benchmark evaluation. RRI-T tests follow a 5-phase methodology (PREPARE → DISCOVER → STRUCTURE → EXECUTE → ANALYZE) — see `SKILL.md` for details.

When adding new MCP tools, add corresponding tests in `test/mcp-*.test.ts` and verify with a real MCP client connection (see `test/api-client.test.ts` for the pattern).
