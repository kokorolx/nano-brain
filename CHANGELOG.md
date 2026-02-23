# Changelog

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
