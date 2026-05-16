# Changelog

All notable changes to nano-brain are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [2026.8.19] — 2026-05-16

### Features
- feat(graph): auto-zoom to selected node + neighbors on focus mode
- feat(graph): focus mode on node click + fix node overlap (#37)
- feat(obsidian,db): excludeFolders, frontmatter tags, db:clean --list-only (closes #34)
- feat(obsidian): Obsidian vault integration + fix entity API limit 100→2000 (closes #34)
- feat(kg): scheduled entity extraction job for memory documents (closes #30)
- feat(docs): extend Three.js neural graph to full-page background on all docs pages (closes #28)
- feat(docs): Three.js neural graph animation in hero — nodes + edges + pulse (closes #27)
- feat(docs): custom hover tooltips on MCP tools grid (closes #26)
- feat(docs): CHANGELOG.md + changelog page renders it via marked.js (closes #24)
- feat(docs): add setup guide page — Docker, config, Ollama, MCP connect, verify steps
- feat: add GitHub Pages site — landing, features, changelog, docs (closes #23)

### Bug Fixes
- fix(graph): allow dragging focused nodes — add pointerEvents:none to dimmed dots
- fix(graph): hide edge labels ('call') when edges dimmed in focus mode
- fix(graph): hide edge labels when edges are dimmed in focus mode
- fix(graph): Symbol Call Graph — default individual mode + fix cluster edge filter (closes #38)
- fix(graph): collapse unrelated nodes to dots on focus — no label overlap
- fix(watcher): address Gemini review — streaming body, yaml parser, async fs, ready event
- fix(db): eliminate SQLite corruption root causes — readonly check + RESTART checkpoint
- fix(db): add db:clean command and bootstrap orphan/corruption guards (closes #32, #33)
- fix(kg): raise entity API limit 100→2000 so all entities appear in graph
- fix(kg): start extraction cycle 30s after startup instead of 30min
- fix(kg): startup reindex + fast drain for entity extraction queue
- fix(ci,web): web deps install in CI + fix graph node overlap
- fix(web): favicon 404, search mark rendering, missing CI web build (closes #29)
- fix(docs): Three.js — use r128 UMD CDN, fix overflow, fix init timing
- fix(docs): npx nano-brain mcp + add ai-sandbox-wrapper container setup section (closes #25)
- fix(pages): redirect root index.html → docs/index.html
- fix(docs): correct codebase facts — 30 tools, 32 CLI, 11-stage pipeline, 5 languages, accurate MCP config
- fix(ci): skip GitHub release creation if tag already exists (closes #22)
- fix(ci): skip npm publish if version already exists on registry
- fix(ci): use --legacy-peer-deps for npm ci (tree-sitter peer conflict)

### Documentation
- docs: add npm, CI, license badges to README (closes #21)
- docs(claude): add rule to create GitHub issue before starting any task

### Other
- chore: fix homepage URL to GitHub Pages docs site
- chore: add repository, homepage, and bugs URLs to package.json
- chore: update CHANGELOG.md for v2026.8.19 [skip ci]

**Install:** `npm install nano-brain@2026.8.19` · `npx nano-brain@latest`

---

## [2026.8.19] — 2026-05-16

### Features
- feat(graph): auto-zoom to selected node + neighbors on focus mode
- feat(graph): focus mode on node click + fix node overlap (#37)
- feat(obsidian,db): excludeFolders, frontmatter tags, db:clean --list-only (closes #34)
- feat(obsidian): Obsidian vault integration + fix entity API limit 100→2000 (closes #34)
- feat(kg): scheduled entity extraction job for memory documents (closes #30)
- feat(docs): extend Three.js neural graph to full-page background on all docs pages (closes #28)
- feat(docs): Three.js neural graph animation in hero — nodes + edges + pulse (closes #27)
- feat(docs): custom hover tooltips on MCP tools grid (closes #26)
- feat(docs): CHANGELOG.md + changelog page renders it via marked.js (closes #24)
- feat(docs): add setup guide page — Docker, config, Ollama, MCP connect, verify steps
- feat: add GitHub Pages site — landing, features, changelog, docs (closes #23)

### Bug Fixes
- fix(graph): allow dragging focused nodes — add pointerEvents:none to dimmed dots
- fix(graph): hide edge labels ('call') when edges dimmed in focus mode
- fix(graph): hide edge labels when edges are dimmed in focus mode
- fix(graph): Symbol Call Graph — default individual mode + fix cluster edge filter (closes #38)
- fix(graph): collapse unrelated nodes to dots on focus — no label overlap
- fix(watcher): address Gemini review — streaming body, yaml parser, async fs, ready event
- fix(db): eliminate SQLite corruption root causes — readonly check + RESTART checkpoint
- fix(db): add db:clean command and bootstrap orphan/corruption guards (closes #32, #33)
- fix(kg): raise entity API limit 100→2000 so all entities appear in graph
- fix(kg): start extraction cycle 30s after startup instead of 30min
- fix(kg): startup reindex + fast drain for entity extraction queue
- fix(ci,web): web deps install in CI + fix graph node overlap
- fix(web): favicon 404, search mark rendering, missing CI web build (closes #29)
- fix(docs): Three.js — use r128 UMD CDN, fix overflow, fix init timing
- fix(docs): npx nano-brain mcp + add ai-sandbox-wrapper container setup section (closes #25)
- fix(pages): redirect root index.html → docs/index.html
- fix(docs): correct codebase facts — 30 tools, 32 CLI, 11-stage pipeline, 5 languages, accurate MCP config
- fix(ci): skip GitHub release creation if tag already exists (closes #22)
- fix(ci): skip npm publish if version already exists on registry
- fix(ci): use --legacy-peer-deps for npm ci (tree-sitter peer conflict)

### Documentation
- docs: add npm, CI, license badges to README (closes #21)
- docs(claude): add rule to create GitHub issue before starting any task

**Install:** `npm install nano-brain@2026.8.19` · `npx nano-brain@latest`

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
