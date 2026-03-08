# Changelog

## [2026.3.20] - 2026-03-08

### Fixed

- **Truncated file path in embedding logs**: `insertEmbeddingLocal` now logs the full file path instead of just the filename.

## [2026.3.19] - 2026-03-08

### Added

- **`reset` command**: `nano-brain reset --confirm` deletes ALL nano-brain data in one shot — SQLite databases, harvested session markdown files, and Qdrant `nano-brain` collection. Requires `--confirm` flag to prevent accidental data loss. `--dry-run` previews what would be deleted without deleting. Qdrant cleanup is best-effort (skipped if unreachable).

## [2026.3.18] - 2026-03-08

### Fixed

- **Session embedding token bomb**: All 4 embedding SQL queries (`getHashesNeedingEmbedding`, `getHashesNeedingEmbeddingByWorkspace`, `getNextHashNeedingEmbedding`, `getNextHashNeedingEmbeddingByWorkspace`) now exclude `d.collection != 'sessions'`. Prevents ~3.8M tokens of session documents from being sent to VoyageAI. Sessions are FTS-only — embedding them provides no value.
- **Empty session infinite retry loop**: Sessions with 0 messages or no text content are now immediately marked `skipped: true` in harvest state. Previously, the retry counter was reset every cycle because the re-harvest path overwrote state without preserving retries.

### Added

- **Incremental session harvesting**: Harvester tracks `messageCount` per session in harvest state. When a session has new messages, only the new messages are read (`parseParts`) and appended to the existing markdown file via `appendFileSync`. When message count is unchanged, the session is skipped entirely — no file I/O, no state change. First harvest still writes full markdown. Backward compatible with existing state (missing `messageCount` treated as 0, triggers one full re-harvest).
- **`messagesToMarkdown()` helper**: Extracted message formatting loop from `sessionToMarkdown` for use in incremental append path.

## [2026.3.16] - 2026-03-08

### Fixed

- **Embedding spin loop (critical)**: 296 empty-body documents (SHA-256 of empty string) were stuck in the pending embedding queue — fetched every cycle, producing 0 chunks, but never marked as embedded. Caused 2.9 million retry iterations per 8 hours and 214MB/day of log output. Fix: insert a sentinel row (`seq=-1`) in `content_vectors` for empty-body documents so they're permanently excluded from `getHashesNeedingEmbedding()`.
- **Harvester re-harvest loop**: Sessions with missing output files were re-harvested every 2 minutes indefinitely (4,325 triggers/day). Now tracks retry count per session in the harvest state file. After 3 failed attempts, the session is permanently skipped. State format upgraded from `Record<string, number>` to `Record<string, {mtime, retries?, skipped?}>` with backward-compatible migration.

### Added

- **Log levels**: `log()` now accepts an optional third parameter (`'error' | 'warn' | 'info' | 'debug'`, default `'info'`). Configurable threshold via `logging.level` in config.yml. Messages below the threshold are suppressed — at `level: info`, the 26,820 daily `[store]` debug lines are eliminated.
- **Log rotation**: Automatic rotation when a log file exceeds 50MB (renamed to `.1`). Files older than 7 days are deleted. Check interval throttled to once per 60 seconds to avoid stat overhead.
- **MCP response limits**: All unbounded MCP tool responses now have sensible defaults with `... and N more` truncation indicators:

  | Tool | Limit |
  |---|---|
  | `memory_get` | 200 lines (was unlimited — largest doc was 774KB / 24K lines) |
  | `memory_multi_get` | 30KB (was 50KB) |
  | `code_impact` | Max depth 3, max 50 entries |
  | `code_context` | 20 callers + 20 callees + 10 flows |
  | `memory_focus` | 30 deps + 30 dependents |
  | `memory_symbols` | 50 results |
  | `memory_impact` | 50 results |
  | `code_detect_changes` | 20 flows |

### Changed

- **Noisy store logs demoted to debug**: `insertEmbeddingLocal`, `insertEmbedding`, `searchFTS`, `searchVec`, and `searchVecAsync` now log at `debug` level instead of `info`.
- **npm package size reduced 75%**: Added `"files"` whitelist to package.json. Published package drops from 269 files / 1.7MB to 42 files / 496KB. Excludes test/, openspec/, site/, ai/, docs/.

## [2026.3.12] - 2026-03-08

### Added

- **`rm` command**: `nano-brain rm <workspace>` completely removes a workspace and all its data — documents, embeddings, content, cache, file edges, symbols, code symbols, symbol edges, execution flows, and config entry. Accepts workspace identifier as absolute path (`rm /path/to/project`), hash prefix (`rm 0ac58c`), or workspace name (`rm my-app`).
- **`rm --list`**: Lists all known workspaces with name, hash, path, and document count.
- **`rm --dry-run`**: Previews row counts per table without deleting anything.
- **Post-removal verification**: After deletion, re-queries the database to confirm zero rows remain for the workspace. Shows warning if partial removal detected.
- **`store.removeWorkspace()`**: New store method that deletes from all 11 workspace-scoped tables (execution_flows, symbol_edges, code_symbols, symbols, file_edges, documents, content_vectors, vectors_vec, content, llm_cache, document_tags) in a single atomic transaction. Returns per-table deletion counts. Preserves shared content hashes used by other workspaces.
- **`removeWorkspaceConfig()`**: Removes workspace entry from `config.yml` after database cleanup.
- **12 new tests**: Coverage for `removeWorkspace()` (all tables cleaned, shared content preserved, orphaned content deleted, accurate counts), `resolveWorkspaceIdentifier()` (path/hash/name resolution, ambiguous/not-found errors), and `removeWorkspaceConfig()`.

## [2026.3.10] - 2026-03-08

### Added

- **SSE/HTTP transport**: `mcp --http --port=3100 --host=0.0.0.0` starts nano-brain as a remote MCP server over SSE. Enables running on the host while AI agents connect from Docker containers via `host.docker.internal`. Supports both SSE (`GET /sse`, `POST /messages`) and Streamable HTTP (`/mcp`) transports. Multiple concurrent clients supported — each gets its own MCP server instance sharing the same store.
- **`serve` command**: `npx nano-brain serve` starts the SSE server as a background daemon and exits. Includes `serve stop`, `serve status`, `--port=N`, and `--foreground` options. PID tracked at `~/.nano-brain/serve.pid`, logs at `~/.nano-brain/logs/server.log`.
- **`/health` endpoint**: Returns server status, uptime, and active session counts for SSE and Streamable HTTP clients.
- **`--host` flag for `mcp` command**: Control bind address (default `127.0.0.1`, use `0.0.0.0` for remote access).

### Notes

- **OpenCode config**: Use `"type": "remote"` with `"url": "http://host.docker.internal:3100/mcp"` for remote mode. The `"type": "sse"` config type is deprecated in OpenCode.

### Fixed

- **`--http` and `--port` flags ignored**: `handleMcp()` parsed these flags but never passed them to `startServer()`. Now correctly wired.

### Removed

- **`test/llm.test.ts`**: Removed dead test file for local GGUF models via `node-llama-cpp` — dependency was already removed, tests always failed.

## [2026.3.8] - 2026-03-08

### Fixed

- **Embedding 0 chunks infinite loop**: When `chunkMarkdown` returned 0 chunks (empty/whitespace-only body), the batch was counted as embedded but no `content_vectors` rows were inserted. Next iteration fetched the same docs, looping forever. Now skips empty-body docs and adds them to `failedHashes`.
- **Qdrant fire-and-forget desync**: `insertEmbedding` upserted to Qdrant via `.catch()` (fire-and-forget) then immediately wrote to `content_vectors`. If Qdrant failed, SQLite thought the doc was embedded but Qdrant didn't have it. Now awaits Qdrant `batchUpsert` before writing `content_vectors`.
- **Qdrant socket errors under load**: Individual per-chunk upserts created hundreds of concurrent HTTP requests, overwhelming the connection. Replaced with batched upserts (100 vectors/request) with retry + exponential backoff (up to 3 retries) for `UND_ERR_SOCKET`, `ECONNRESET`, and `ECONNREFUSED` errors.

### Added

- **Embed batch file logging**: Embed log now shows file names being processed: `[embed] Batch 3 docs, 10 chunks: package.json, tsconfig.json, README.md`.
- **`insertEmbeddingLocal`**: SQLite-only embedding record method for use when external vector store is handled separately.

## [2026.2.0] - 2026-03-05

### Added

- **File-based diagnostic logging**: Optional file logger controlled via `logging.enabled: true` in config or `NANO_BRAIN_LOG=1` env var. Logs to `~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log` with daily rotation. Zero CPU overhead when disabled (boolean guard). All 11 source modules instrumented with tagged log calls (server, watcher, store, search, embeddings, reranker, storage, collections, codebase, harvester, CLI).
- **CLI `logs` command**: `npx nano-brain logs` to view today's log, `logs -f` to tail in real-time, `logs path` to print log directory, `logs --date=YYYY-MM-DD` for specific dates, `logs <filepath>` for arbitrary log files, `logs --clear` to delete all logs.
- **Import graph with PageRank & clustering**: Codebase indexing now parses import/require statements (JS/TS, Python, Ruby/Rails) and builds a file dependency graph. PageRank centrality scores boost important files in search results. Louvain community detection identifies logical module clusters.
- **Memory supersede**: `memory_write` and CLI `write` accept `--supersedes` to mark old documents as outdated. Superseded documents receive a 0.3x score demotion in search (configurable).
- **Cross-workspace search**: `--scope=all` on search commands and `workspace: "all"` on MCP tools searches across all indexed workspaces with `projectHash` attribution.
- **Structured tags**: `--tags` on `write` and tag filtering on search commands. `memory_tags` tool and `tags` CLI list all tags with counts. AND logic for multi-tag filters.
- **Temporal queries**: `--since` and `--until` date filters on all search commands.
- **Configurable search tuning**: `search` section in config.yml for RRF k, top_k, blending weights, expansion/reranking toggles, centrality weight, and supersede demotion factor.
- **Focus & graph stats tools**: `memory_focus` shows file dependencies/dependents/centrality/cluster. `memory_graph_stats` shows graph overview with cycle detection.
- **Cross-repo symbol extraction**: Regex-based extraction of Redis keys, PubSub channels, MySQL tables, API endpoints, HTTP calls, and Bull/Sidekiq queues during codebase indexing. Template literals converted to wildcard patterns.
- **Symbol query & impact tools**: `memory_symbols` queries symbols with filters. `memory_impact` shows cross-repo impact (writers vs readers, publishers vs subscribers).
- **CLI `write` command**: `npx nano-brain write "content"` with `--supersedes` and `--tags` options.
- **CLI `focus` command**: `npx nano-brain focus <filepath>` for dependency analysis.
- **CLI `graph-stats` command**: `npx nano-brain graph-stats` for graph overview.
- **CLI `symbols` command**: `npx nano-brain symbols` with type/pattern/repo/operation filters.
- **CLI `impact` command**: `npx nano-brain impact` for cross-repo impact analysis.
- **CLI `tags` command**: `npx nano-brain tags` to list all tags.
- **~170 new tests**: Comprehensive coverage for all new features. Total: 630+ tests.

## [2026.1.21] - 2026-03-04

### Fixed

- **Voyage AI compatibility**: Removed unsupported `encoding_format` parameter and corrected `input_type` from "passage" to "document".
- **Batch embedding loop correctness**: Use `getHashesNeedingEmbedding()` instead of repeatedly re-fetching the same hash, preventing re-processing.
- **OpenAI-compatible batch limits**: Added sub-batching to stay under API token limits (200K chars/request) and capped embed batch chunk count at 200.

## [2026.1.20] - 2026-03-04

### Fixed

- **Embed/search commands not using config**: `nano-brain embed`, `vsearch`, and `query` were calling `createEmbeddingProvider()` without passing the config, always falling back to Ollama/local instead of using the configured provider.
- **Rate limiting for OpenAI-compatible providers**: Token bucket throttle at configurable RPM (default 40). Automatic retry with backoff on 429 responses. Configurable via `rpmLimit` in config.
- **Status/init health check for OpenAI provider**: `nano-brain status` and `init` no longer use the Ollama health check (`/api/tags`) for OpenAI-compatible providers. Now tests the actual embedding endpoint, showing correct ✅/❌ status.

## [2026.1.18] - 2026-03-04

### Added

- **`init --force --all`**: Clear ALL workspace databases at once, not just the current workspace. Useful when switching embedding providers (different dimensions require full re-embed).

## [2026.1.17] - 2026-03-04

### Added

- **OpenAI-compatible embedding provider**: Support any OpenAI-compatible embedding API (NVIDIA, GitHub Models, OpenAI, etc.) via `provider: openai` config. Requires `url`, `apiKey`, and `model`. Supports batch embedding, auto-detects dimensions from first response. Default provider remains Ollama.

## [2026.1.16] - 2026-03-04

### Fixed

- **Auto-detect model context length**: Embedding provider now queries Ollama `/api/show` to detect the model's actual context window and embedding dimensions at runtime. Removes hardcoded `OLLAMA_MAX_CHARS` constant — max chars computed dynamically as `(contextTokens - 128) * 2`.
- **Default model reverted to nomic-embed-text**: mxbai-embed-large only has 512-token context (not 8192), causing widespread embedding failures on real content. nomic-embed-text (2048 tokens, 768 dims) covers full chunks without loss.
- **handleEmbed infinite loop**: `handleEmbed` was passing raw document bodies to `embed()` without chunking, bypassing the chunking pipeline entirely. Replaced with `embedPendingCodebase()` call.
- **embedPendingCodebase infinite loop on total chunk failure**: When ALL chunks of a document failed embedding (e.g., token-dense minified code), the document was never marked as processed, causing `getNextHashNeedingEmbedding()` to return it forever. Now tracks failed hashes within the session and skips them.
- **Removed hardcoded truncation**: `OLLAMA_MAX_CHARS` constant and `truncateForOllama()` removed. Truncation now uses the provider's dynamically-detected `maxChars`.

## [2026.1.15] - 2026-03-04

### Added

- **Benchmark suite**: Dual-mode performance benchmarking for regression detection and real-world measurement.
  - **Vitest bench** (`npx vitest bench`): CI-safe synthetic benchmarks with 200 deterministic documents, seeded PRNG, and mock embeddings. Covers FTS search (simple + multi-term), vector search, hybrid search, cache hit/miss/write, and store operations (insertDocument, insertEmbedding, getIndexHealth).
  - **CLI bench** (`nano-brain bench`): Real-workspace benchmarks against the user's actual database with live Ollama embeddings. Supports `--suite=search|embed|cache|store` filtering, `--iterations=N` control, `--json` output, `--save` baseline persistence to `~/.nano-brain/benchmarks/`, and `--compare` delta reporting against saved baselines.
  - Graceful degradation: embedding and vector search benchmarks skip with warning when Ollama is unavailable.
- **Embedding pipeline upgrade** (**BREAKING** — triggers automatic re-embedding):
  - **Default model switched to mxbai-embed-large** (1024 dims vs 768). Higher quality embeddings with GPU-accelerated performance.
  - **Per-chunk embedding**: Each document chunk is embedded independently instead of one embedding per whole document, dramatically improving vector recall for large files.
  - **Query embedding cache**: Query embeddings cached in `llm_cache` table to eliminate repeated Ollama HTTP calls for identical queries.
  - **Parallel hybrid search**: FTS and vector search run concurrently with `Promise.all` instead of sequential loops, cutting hybrid search latency ~50%.
  - **Vector search snippets**: Vector search results now include populated snippet text by JOINing with the content table, enabling proper reranking.
  - **Raised embedding truncation limit**: `OLLAMA_MAX_CHARS` increased from 1800 to 6000 (nomic-embed-text supports 8192 tokens).
  - **Larger embedding batch size**: Batch size increased from 10 to 50 for faster indexing throughput.
- **Cache project-scoping**: LLM cache entries are now isolated per workspace.
  - Added `project_hash` and `type` columns to `llm_cache` table. Expansion and reranking caches are workspace-scoped; query embedding cache remains global (text→vector is project-independent).
  - **`cache clear`** CLI command: Clears cache for current workspace by default, `--all` for global wipe, `--type=embed|expand|rerank` for selective clearing.
  - **`cache stats`** CLI command: Shows cache entry counts by type and workspace.
  - Backward-compatible migration: existing entries get `project_hash='global'` and `type='general'`.

### Fixed

- 10 pre-existing test failures across 6 test files fixed. All 449 tests passing.

## [2026.1.14] - 2026-03-02

### Added

- **`init --force` flag**: Clears all indexed documents, embeddings, and content for the current workspace before re-initializing. Useful when the index is corrupted or you want a clean slate without affecting other workspaces.

## [2026.1.13] - 2026-02-28

### Fixed

- **Workspace-scoped session indexing**: Session documents were indexed with the current workspace's `projectHash` instead of extracting it from the session file's directory path (`sessions/{hash}/*.md`). This caused all sessions from every workspace to be tagged as belonging to the current workspace, defeating workspace-scoped search. Added `extractProjectHashFromPath()` utility and fixed all 4 indexing code paths (watcher, init, update, memory_update tool).

## [2026.1.12] - 2026-02-24

### Fixed

- **Session harvesting on Linux/Docker**: Harvester hardcoded `~/.opencode/storage` (macOS path). On Linux, OpenCode follows XDG and stores sessions at `~/.local/share/opencode/storage`. Added `resolveOpenCodeStorageDir()` that checks XDG path first and falls back to `~/.opencode/storage`, so harvesting now works on both platforms.

### Changed

- **Expanded built-in codebase exclude patterns**: `BUILTIN_EXCLUDE_PATTERNS` grew from 12 to 55 patterns covering all major ecosystems — prevents accidental indexing of large generated directories that cause OOM and DB bloat:
  - **JS/TS**: `.pnpm-store`, `.yarn`, `bower_components`, `out`, `.svelte-kit`, `.astro`, `.remix`, `.turbo`, `.vercel`, `.cache`, `.parcel-cache`, `.vite`, `storybook-static`, `*.min.css`, `*.tsbuildinfo`, `.eslintcache`
  - **Python**: `.venv`, `venv`, `env`, `.conda`, `*.egg-info`, `.mypy_cache`, `.ruff_cache`, `.pytest_cache`, `htmlcov`, `.tox`
  - **Java/JVM**: `.gradle`, `.mvn`, `*.class`, `*.jar`, `*.war`
  - **Ruby**: `gems`, `.bundle`
  - **PHP**: `storage/framework`, `bootstrap/cache`
  - **Mobile**: `Pods`, `*.xcworkspace`, `DerivedData`, `generated`
  - **DevOps**: `.terraform`, `terraform.tfstate*`
  - **Logs/tmp**: `logs`, `log`, `tmp`, `temp`, `*.log`
  - **Test coverage**: `coverage`, `.nyc_output`, `lcov-report`
  - **Version control**: `.svn`, `.hg`

## [2026.1.11] - 2026-02-24

### Fixed

- **MCP singleton guard**: Multiple nano-brain MCP server instances would pile up (OpenCode respawns MCP servers on reconnect), causing SQLite lock contention and Ollama timeout errors. New PID-based singleton guard ensures only one instance runs — new instances kill the previous one, and old instances detect they've been superseded and exit gracefully.
- **Ollama auto-reconnect**: If Ollama is unreachable at MCP server startup, the server falls back to local GGUF embeddings and now retries Ollama every 60 seconds. When Ollama becomes available, the embedding provider is hot-swapped without restart.

## [2026.1.10] - 2026-02-24

### Fixed

- **Ollama timeout issues in Docker**: Increased health check timeout from 3s to 10s to handle Docker networking latency. Added 30s timeout to `embed()` and 60s timeout to `embedBatch()` — previously these had no timeout and could hang indefinitely.

## [2026.1.9] - 2026-02-24

### Changed

- **Consolidated all data paths under `~/.nano-brain/`**: DB, models, config, sessions, and memory now all live under `~/.nano-brain/` instead of scattered across `~/.cache/nano-brain/` and `~/.config/nano-brain/`. This fixes data loss in Docker containers where `~/.cache` was an ephemeral anonymous volume.
- **New directory layout**:
  ```
  ~/.nano-brain/
  ├── config.yml    # Configuration (was ~/.config/nano-brain/config.yml)
  ├── data/         # SQLite databases (was ~/.cache/nano-brain/)
  ├── models/       # Embedding models (was ~/.cache/nano-brain/models/)
  ├── memory/       # Curated notes
  └── sessions/     # Harvested sessions
  ```
- **Cleanup command**: After upgrading, remove old paths with `rm -rf ~/.cache/nano-brain ~/.config/nano-brain`

## [2026.1.8] - 2026-02-24

### Fixed

- **`init` no longer hangs on large collections**: Init now only indexes core collections (memory, sessions) and defers other collections to the MCP watcher. Previously, scanning a large project collection (e.g., thousands of source files) would block init indefinitely.
- **`init` caps embedding at 50 documents**: Embeds first 50 docs for quick startup, reports remaining count, and defers the rest to the MCP server's background embedding interval. Previously tried to embed all documents synchronously.
- **Per-collection progress logging**: Init now shows per-collection file counts and new/skipped stats.

## [2026.1.7] - 2026-02-24

### Fixed

- **CLI per-workspace DB resolution**: CLI commands (`status`, `search`, `init`, etc.) now resolve the same per-workspace database as the MCP server (`{dirName}-{hash}.sqlite`). Previously CLI always read `default.sqlite`, showing stale data from the old global DB.
- **"Chunks" → "Embedded" label**: Status output renamed misleading "Chunks" count (which counted `content_vectors` rows) to "Embedded" — accurately reflecting what it measures.

## [2026.1.6] - 2026-02-24

### Added

- **Per-workspace codebase config**: Global config now supports a `workspaces` map, allowing different codebase settings (enabled, extensions, exclude) per project. `init --root=/path` creates a workspace entry with codebase enabled by default.
- **`getWorkspaceConfig()` resolver**: Resolution order: workspace map → top-level `codebase` fallback → default (enabled). Existing configs with top-level `codebase` continue working without migration.
- **`setWorkspaceConfig()` helper**: Programmatic API for adding/updating workspace entries in config.

### Changed

- **`init` writes workspace entries**: Instead of a single global `codebase` field, `handleInit()` now adds per-workspace entries to the `workspaces` map. Multiple `init --root=` calls for different projects coexist.
- **Server resolves workspace config**: `startServer()` uses `getWorkspaceConfig()` to resolve codebase config for the current workspace instead of reading the top-level `codebase` field.

## [2026.1.4] - 2026-02-23

### Added

- **Slash commands**: 3 OpenCode slash commands shipped in `commands/` dir — `/nano-brain-init` (first-time setup), `/nano-brain-status` (health check), `/nano-brain-reindex` (rescan after branch switch). Installed to both global and project `.opencode/command/` during `init`.
- **Slash command auto-install in `init`**: `handleInit()` copies slash command `.md` files from the package's `commands/` directory to global (`~/.config/opencode/.opencode/command/`) and project-level (`.opencode/command/`) directories.

### Changed

- **SKILL.md rewritten**: Cut from 153 lines to 45. Concise tool selection table, slash command reference, collection filtering, complementary tools note. No redundant parameter docs.

## [2026.1.3] - 2026-02-23

### Added

- **`init` command**: Full self-initializing setup via `npx nano-brain init --root=/path`. Creates config with auto-detected Ollama URL, indexes codebase, harvests sessions, indexes collections, generates embeddings, and injects AGENTS.md snippet. One command to go from zero to fully operational.
- **Ollama embedding support**: Configurable embedding provider in `~/.config/nano-brain/config.yml`. Supports Ollama API with auto-detected URL (localhost:11434 natively, host.docker.internal:11434 in Docker). User-overridable model and URL.
- **Embedding server health in `status`**: `npx nano-brain status` and MCP `memory_status` tool now show embedding server connectivity, model availability, and available models.
- **`checkOllamaHealth()` utility**: Probes Ollama API for connectivity and model availability, used by both `init` and `status`.

### Fixed

- **ESM `require()` bug in Docker detection**: `detectOllamaUrl()` used `require('fs')` inside an ESM module, which silently failed and always returned localhost even inside Docker. Fixed by using ESM `import { accessSync, readFileSync } from 'fs'`.
- **sqlite-vec `INSERT OR REPLACE` bug**: sqlite-vec virtual tables don't support `INSERT OR REPLACE` — they treat it as plain `INSERT`, causing `UNIQUE constraint failed` errors on re-embedding. Fixed with DELETE-then-INSERT pattern.
- **`init` never generated embeddings**: `handleInit()` indexed documents but never created an embedding provider or called `embedPendingCodebase()`. Documents stayed permanently "pending". Fixed by adding embedding step after indexing.

## [2026.1.0] - 2026-02-23

### Added

- **AI agent routing instructions (SKILL.md)**: Enhanced SKILL.md with trigger phrases, when-to-use rules, tool selection guide, collection filtering, and integration patterns for orchestrator and subagent workflows. Agents now auto-route to memory for recall, past decisions, cross-session context, and repeated patterns.
- **AGENTS_SNIPPET.md**: Optional managed block for project-level AGENTS.md installation. Provides quick reference table, session workflow (start/end), and memory vs codebase search guidance. Designed for `npx nano-brain init` injection.
- **`memory_index_codebase` documented**: Added to SKILL.md, README, and site API reference.
- **`workspace` parameter documented**: Added to search tool docs showing workspace scoping.

## [0.3.0] - 2026-02-23

### Added

- **Codebase indexing**: Opt-in source code indexing via `codebase: { enabled: true }` in config.yml. Indexes source files from the current workspace into the search pipeline for semantic code search.
- **Source code chunker**: Line-based chunking with structural boundary detection (function/class/type definitions, import blocks). Same 900-token target and 15% overlap as markdown chunker. Metadata headers (`File:`, `Language:`, `Lines:`) prepended to each chunk.
- **Project type auto-detection**: Detects project type from marker files (package.json, pyproject.toml, go.mod, Cargo.toml, etc.) and selects appropriate file extensions to index. Falls back to all common extensions.
- **Exclude pattern merging**: Combines exclude patterns from three sources: config `codebase.exclude`, `.gitignore`, and built-in defaults (node_modules, .git, dist, build, etc.).
- **Codebase storage budget**: Independent `codebase.maxSize` (default 2GB) limits codebase storage separately from session storage. Indexing stops when budget is exceeded. Storage usage reported in `memory_status`.
- **Max file size guard**: Skips files larger than `codebase.maxFileSize` (default 5MB) to avoid indexing generated/minified files.
- **`memory_index_codebase` MCP tool**: On-demand full codebase scan and index with summary stats (files scanned, indexed, skipped, storage usage).
- **Codebase stats in `memory_status`**: Shows enabled state, document count, storage used/limit, resolved extensions, and exclude pattern count.
- **Watcher integration**: File watcher monitors workspace directory for source code changes with exclude patterns, triggering incremental reindex.
- **`getCollectionStorageSize()`**: New Store method to query per-collection storage usage.
- **118 new tests**: `codebase.test.ts` (68 tests), `codebase-chunker.test.ts` (50 tests). Total: 428 tests.

### Changed

- Increased vitest worker heap size to 8GB to prevent OOM during test runs with large test suites.

## [0.2.0] - 2026-02-23

### Added

- **Workspace scoping**: Search results are now scoped to the current workspace by default. Each workspace is identified by a SHA-256 hash of its directory path, matching the harvester convention. Cross-workspace search is available via `workspace: "all"` parameter.
- **Storage limits**: Configurable `maxSize` (default 2GB), `retention` (default 90d), and `minFreeDisk` (default 100MB) in `config.yml` under a `storage` section. Human-readable values like `500MB`, `30d`, `1y` are supported.
- **Disk safety guard**: Checks available disk space via `fs.statfsSync()` before writes. Skips harvest/reindex/embed when disk is critically low.
- **Retention-based eviction**: Automatically deletes harvested session markdown older than the retention period during each harvest cycle.
- **Size-based eviction**: If total storage exceeds `maxSize` after retention eviction, deletes oldest sessions until under limit. Original OpenCode session JSON is never touched.
- **Orphan embedding cleanup**: Removes embedding vectors for deleted documents every 10 harvest cycles.
- **Incremental harvesting**: Tracks session file mtimes in `.harvest-state.json` to skip unchanged files, reducing harvest time from O(all) to O(changed).
- **`workspace` parameter** on `memory_search`, `memory_vsearch`, and `memory_query` MCP tools. Omit for current workspace, `"all"` for cross-workspace.
- **Per-workspace stats** in `memory_status` output showing document counts per workspace hash.
- **45 new tests**: `workspace.test.ts` (18), `storage.test.ts` (27), plus integration tests in `server.test.ts` and `watcher.test.ts`. Total: 310 tests.

### Changed

- Switched embedding model from EmbeddingGemma-300M (384d) to **nomic-embed-text-v1.5** (768d) for better search quality.
- Switched reranker from Qwen3-Reranker-0.6B to **bge-reranker-v2-m3** (8192 context) for improved reranking.
- Updated prompt format to nomic `search_query:`/`search_document:` convention.
- `documents` table now has a `project_hash` column with automatic migration and backfill on first startup.

### Fixed

- Crash when session JSON has undefined `slug` field (now falls back to session id).

## [0.1.0] - 2026-02-16

### Added

- Initial release with hybrid search (BM25 + vector + LLM reranking).
- 8 MCP tools: `memory_search`, `memory_vsearch`, `memory_query`, `memory_get`, `memory_multi_get`, `memory_write`, `memory_status`, `memory_update`.
- SQLite storage with FTS5 and sqlite-vec.
- Heading-aware markdown chunking.
- YAML-configured collections with auto-indexing via chokidar.
- OpenCode session harvesting (JSON to markdown).
- GGUF model inference via node-llama-cpp.
