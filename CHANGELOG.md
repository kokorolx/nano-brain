# Changelog

All notable changes to nano-brain are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2026.8.19] — 2026-05-15

### Bug Fixes

- **Workspace guard** — server no longer creates a database for `--root` paths not declared in `config.workspaces`. Falls back to closest configured workspace via longest-prefix match, then first workspace. Prevents orphaned DB accumulation. Closes [#19](https://github.com/nano-step/nano-brain/issues/19).
- **CLI pre-resolution** — `cli/index.ts` no longer pre-resolves the DB path from `process.cwd()` for the `mcp` command, which was bypassing the workspace guard entirely.
- **CI: skip existing release** — `Publish Stable` workflow no longer fails when the GitHub release tag already exists. Closes [#22](https://github.com/nano-step/nano-brain/issues/22).
- **CI: peer deps** — use `--legacy-peer-deps` in GitHub Actions to resolve `tree-sitter` peer conflict.

### Infrastructure

- Added `develop` branch → `npm publish --tag beta` + GitHub pre-release on every push.
- Added `master` branch → `npm publish --tag latest` + GitHub release with auto-generated changelog.
- Added npm, CI, and license badges to README.
- CLAUDE.md: every npm publish must have a changelog; create GitHub issue before starting any task.

**Install:** `npm install nano-brain@2026.8.19` · `npx nano-brain@latest`

---

## [2026.6.2] — 2026-03-17

### Features — Memory Intelligence v2

- **Entity Pruning** — background job (6h interval) soft-deletes contradicted entities after 30 days and orphan entities after 90 days; hard-deletes after 30-day retention.
- **LLM Categorization** — async fire-and-forget assigns `llm:` category tags after every `memory_write`.
- **Preference Learning** — Thompson Sampling bandits track which content types the agent retrieves most; RRF blend weights adapt over time.
- **Schema v7** — `pruned_at` column on `memory_entities`.

### Features — Search Quality

- **Query Expansion** — LLM generates 2–3 query variants before search for better recall.
- **Tag Display** — `auto:` and `llm:` tags now visible in search results (verbose + compact modes).
- **Backfill CLI** — `nano-brain categorize-backfill` to LLM-categorize existing documents.
- Wave 7: recency boost for sessions/memory collections.
- Wave 6: length normalization penalty using `charLength`.
- Wave 5: temporal metadata (`createdAt`) in `SearchResult`.
- Wave 4: Qdrant `project_hash` payload filter and backfill.
- Wave 3: FTS workspace isolation (strict filter).
- Wave 2: fix `supersedeDocument` bug.
- Wave 1: `domain_type` and `last_reinforced_at` schema columns.

### Features — Token Reduction

- **MCP Response Caps** — hard limits on all unbounded tools: `memory_get` (200 lines), `code_impact` (depth 3, 50 entries), `code_context` (20 callers/callees).
- **Compact mode default** — search tools return compact format (~60% fewer tokens).
- Heading-aware chunking (900 tokens, 15% overlap).

### Infrastructure

- Replaced sqlite-vec with Qdrant as sole vector store.
- Added benchmark suite — data generator, runner, compare CLI.
- Consolidation decisions now reconciled automatically in the background.

**Install:** `npm install nano-brain@2026.6.2`

---

## Earlier releases

Full history available on [GitHub Releases](https://github.com/nano-step/nano-brain/releases).
