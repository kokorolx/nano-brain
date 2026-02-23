## Context

opencode-memory indexes markdown documents (sessions, MEMORY.md, daily logs) into SQLite with FTS5 + sqlite-vec for hybrid search. The existing pipeline is:

1. **Collections** define directories + glob patterns to scan (`config.yml`)
2. **Watcher** monitors collections via chokidar, triggers reindex on changes
3. **Chunker** splits markdown by headings/paragraphs (target 900 tokens, 15% overlap)
4. **Store** indexes chunks into FTS5 + content-addressed embeddings
5. **Search** queries FTS5 (BM25) and/or sqlite-vec (cosine), fuses with RRF

Current limitations:
- The chunker only understands markdown structure (headings, code fences, lists)
- Collections use `pattern: "**/*.md"` — no exclude support
- The watcher watches collection output dirs, not arbitrary workspace directories
- No concept of "codebase" as a distinct collection type

The MCP server runs per-workspace with `PWD` set to the workspace root. `currentProjectHash = sha256(cwd).substring(0, 12)` is already computed at startup.

## Goals / Non-Goals

**Goals:**
- Index source code files from the current workspace into the existing search pipeline
- Support configurable exclude patterns to skip `node_modules`, `.git`, `dist`, etc.
- Chunk source code files intelligently — respecting function/class boundaries where feasible, falling back to line-based splitting
- Reuse the existing watcher infrastructure for incremental updates
- Tag all codebase documents with `currentProjectHash` for workspace-scoped search
- Provide sensible defaults so it works with zero config for common project types
- Keep it opt-in — codebase indexing only happens when configured

**Non-Goals:**
- AST-level parsing of every language (too complex, too many dependencies)
- Indexing binary files, images, or compiled output
- Real-time indexing on every keystroke (debounced file watcher is sufficient)
- Replacing LSP or grep — this complements them with semantic search
- Cross-workspace codebase search (each workspace indexes its own code)
- Indexing external dependencies (node_modules, vendor, etc.)

## Decisions

### D1: Codebase as a special auto-configured collection

**Decision**: When `codebase: { enabled: true }` is set in config.yml (or auto-detected), create a virtual collection named `codebase` pointing at `process.cwd()` with source code glob patterns and exclude rules. This collection is NOT stored in the `collections:` section — it's a separate top-level config.

**Why**: Codebase indexing is fundamentally different from document collections — it targets the workspace root (dynamic per-server instance), needs exclude patterns, and uses different chunking. Keeping it separate avoids polluting the general collection config.

**Config format**:
```yaml
codebase:
  enabled: true
  exclude:
    - node_modules
    - .git
    - dist
    - build
    - .next
    - __pycache__
    - "*.min.js"
    - "*.map"
  extensions:
    - .ts
    - .tsx
    - .js
    - .jsx
    - .py
    - .go
    - .rs
    - .java
    - .rb
    - .md
  maxFileSize: 5MB     # Skip files larger than this
```

**Alternative considered**: Add codebase as a regular collection entry. Rejected because the path is dynamic (PWD), exclude patterns don't exist on regular collections, and it would confuse the existing collection management CLI.

### D2: Exclude patterns via .gitignore + config

**Decision**: Merge exclude patterns from three sources (in priority order):
1. **Config `codebase.exclude`** — explicit user overrides
2. **`.gitignore`** — project-specific ignores (already maintained by developers)
3. **Built-in defaults** — `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `vendor`, `.next`, `.nuxt`, `target`, `*.min.js`, `*.map`, `*.lock`, `*.sum`

**Why**: `.gitignore` already captures 90% of what should be excluded. Adding it as a source means zero-config works for most projects. The built-in defaults catch common cases even without a `.gitignore`.

**Implementation**: Use fast-glob's `ignore` option which already supports gitignore-style patterns. Parse `.gitignore` at startup and merge with config excludes.

### D3: Source code chunking — line-based with structural hints

**Decision**: Create a `chunkSourceCode()` function that splits by structural boundaries:
1. **Primary split**: Blank line sequences (2+ consecutive blank lines = strong break)
2. **Secondary split**: Single blank lines between top-level constructs
3. **Structural hints**: Recognize common patterns across languages:
   - `function`, `def`, `fn`, `func` — function definitions
   - `class`, `struct`, `interface`, `enum`, `type` — type definitions
   - `import`, `from`, `require`, `use` — import blocks
   - `export` — export statements
4. **Fallback**: If no structural breaks found within target chunk size, split at line boundaries
5. **Same target size**: 900 tokens (~3600 chars), 15% overlap — matching markdown chunker

**Why**: Full AST parsing requires language-specific parsers (tree-sitter, etc.) which adds heavy dependencies. Line-based splitting with structural hints gives 80% of the benefit at 10% of the complexity. The patterns above work across TypeScript, Python, Go, Rust, Java, Ruby, and most C-family languages.

**Alternative considered**: tree-sitter for AST-aware chunking. Rejected for v1 — adds ~50MB of native dependencies, complex build, and only marginally better than structural hints for search purposes. Can be added later as an enhancement.

### D4: File-level metadata in document title

**Decision**: Store the relative file path as the document `title` and include a metadata header in the indexed content:
```
File: src/auth/login.ts
Language: typescript
Lines: 1-45

[actual file content]
```

**Why**: The metadata header helps the embedding model understand what it's looking at. The relative path as title makes search results immediately actionable (agent knows which file to open).

### D5: Incremental indexing via content hash

**Decision**: Reuse the existing content-addressed storage. On each scan:
1. Compute `sha256(fileContent)` for each source file
2. Compare with stored hash in `documents` table
3. Skip unchanged files (hash match)
4. Re-index changed files (hash mismatch)
5. Deactivate deleted files (in DB but not on disk)

**Why**: The store already does content-addressed dedup via `computeHash()`. This is the same pattern used for markdown documents. No new infrastructure needed.

### D6: Watcher integration — reuse existing chokidar setup

**Decision**: Add the workspace directory as an additional watch target in the existing watcher, with the exclude patterns applied as chokidar `ignored` options. Source file changes trigger the same dirty-flag → debounce → reindex cycle.

**Why**: The watcher already handles debouncing, dirty flags, and reindex scheduling. Adding another watch target is simpler than creating a separate watcher.

### D7: Auto-detection of project type for default extensions

**Decision**: At startup, detect project type by checking for marker files:
- `package.json` → Node.js: `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`, `.html`
- `pyproject.toml` / `setup.py` / `requirements.txt` → Python: `.py`, `.pyi`
- `go.mod` → Go: `.go`
- `Cargo.toml` → Rust: `.rs`
- `pom.xml` / `build.gradle` → Java/Kotlin: `.java`, `.kt`
- `Gemfile` → Ruby: `.rb`
- Fallback: all common extensions

Always include `.md` files from the workspace (README, docs).

**Why**: Avoids indexing irrelevant file types. A Python project doesn't need `.ts` files indexed. Auto-detection means zero-config for common setups.

### D8: Max file size guard

**Decision**: Skip files larger than `maxFileSize` (default 5MB). Log a warning for skipped files.

**Why**: Large generated files (bundles, minified code, data files) waste storage and produce poor search results. 5MB covers virtually all hand-written source files while still guarding against huge generated artifacts.

## Risks / Trade-offs

**[Risk] Large codebases produce many chunks** → Storage limits from v0.2.0 (maxSize, retention) apply. Codebase chunks count toward the total. For very large monorepos, users may need to increase maxSize or narrow extensions.

**[Risk] Stale index after branch switch** → `git checkout` changes many files at once. The watcher will detect changes and reindex, but there's a window where the index is stale. Acceptable — the reindex debounce (2s) is fast enough.

**[Risk] Embedding all source code is expensive** → Embedding 1000 files × 5 chunks each = 5000 embeddings. At ~50ms per embedding, that's ~4 minutes for initial index. Subsequent updates are incremental (only changed files). This is acceptable for a background process.

**[Risk] Structural hints miss language-specific constructs** → The line-based chunker won't perfectly split every language. Some chunks may cut mid-function. This is acceptable for search — the overlap ensures context is preserved, and semantic search is tolerant of imperfect boundaries.

**[Risk] .gitignore parsing edge cases** → Complex .gitignore patterns (negation, nested) may not parse perfectly with fast-glob. Mitigation: the built-in defaults catch the most important exclusions regardless.

## Open Questions

- Should codebase indexing be enabled by default (auto-detect) or require explicit `codebase: { enabled: true }`? Leaning toward explicit opt-in for v1 to avoid surprising users with increased storage usage.
- Should there be a `memory_index_codebase` MCP tool for on-demand full reindex, or is the watcher sufficient? Leaning toward adding the tool for the initial index trigger.
