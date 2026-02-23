## ADDED Requirements

### Requirement: Codebase configuration format
The system SHALL support a top-level `codebase` section in `config.yml` with the following fields: `enabled` (boolean), `exclude` (string array), `extensions` (string array), `maxFileSize` (string, human-readable size), and `maxSize` (string, human-readable size for storage budget). All fields except `enabled` SHALL be optional with sensible defaults. When `codebase.enabled` is `false` or the section is absent, no codebase indexing SHALL occur.

#### Scenario: Full codebase config provided
- **WHEN** config.yml contains `codebase: { enabled: true, exclude: ["node_modules", ".git"], extensions: [".ts", ".py"], maxFileSize: "50KB" }`
- **THEN** the system indexes only `.ts` and `.py` files, skipping `node_modules` and `.git` directories, and skipping files larger than 50KB

#### Scenario: Minimal codebase config (enabled only)
- **WHEN** config.yml contains `codebase: { enabled: true }` with no other fields
 **THEN** the system uses auto-detected extensions (from project type), built-in exclude defaults, and 5MB maxFileSize

#### Scenario: Codebase section absent
- **WHEN** config.yml has no `codebase` section
- **THEN** no codebase indexing occurs
- **THEN** no codebase-related file watching occurs

#### Scenario: Codebase explicitly disabled
- **WHEN** config.yml contains `codebase: { enabled: false }`
- **THEN** no codebase indexing occurs even if other codebase fields are present

### Requirement: Exclude pattern merging from three sources
The system SHALL merge exclude patterns from three sources in priority order: (1) `codebase.exclude` from config, (2) `.gitignore` file in the workspace root, and (3) built-in defaults. The built-in defaults SHALL include at minimum: `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `vendor`, `.next`, `.nuxt`, `target`, `*.min.js`, `*.map`, `*.lock`, `*.sum`. All three sources SHALL be combined (union) into a single exclude list passed to the file scanner.

#### Scenario: All three sources present
- **WHEN** config has `exclude: ["custom-dir"]`, `.gitignore` contains `coverage/`, and built-in defaults include `node_modules`
- **THEN** the effective exclude list includes `custom-dir`, `coverage/`, `node_modules`, and all other built-in defaults

#### Scenario: No .gitignore file
- **WHEN** the workspace root has no `.gitignore` file
- **THEN** only config excludes and built-in defaults are used
- **THEN** no error is thrown

#### Scenario: No config excludes
- **WHEN** `codebase.exclude` is not set in config
- **THEN** `.gitignore` patterns and built-in defaults are still applied

### Requirement: Source code chunking with structural hints
The system SHALL chunk source code files using line-based splitting with structural boundary detection. Primary split points SHALL be blank line sequences (2+ consecutive blank lines). Secondary split points SHALL be single blank lines between top-level constructs. Structural hints SHALL recognize common cross-language patterns: function definitions (`function`, `def`, `fn`, `func`), type definitions (`class`, `struct`, `interface`, `enum`, `type`), import blocks (`import`, `from`, `require`, `use`), and export statements (`export`). The target chunk size SHALL be 900 tokens (~3600 characters) with 15% overlap, matching the existing markdown chunker.

#### Scenario: TypeScript file with functions
- **WHEN** a TypeScript file contains three functions separated by blank lines, each ~300 tokens
- **THEN** the chunker produces one chunk containing all three functions (under 900 token target)

#### Scenario: Large Python file exceeding chunk target
- **WHEN** a Python file contains a class with 2000 tokens
- **THEN** the chunker splits at structural boundaries (method definitions) within the class
- **THEN** each resulting chunk is approximately 900 tokens with 15% overlap

#### Scenario: File with no structural boundaries
- **WHEN** a file contains continuous text with no blank lines or structural keywords
- **THEN** the chunker falls back to splitting at line boundaries near the 900 token target

#### Scenario: Overlap between chunks
- **WHEN** a source file is split into multiple chunks
- **THEN** adjacent chunks share approximately 15% overlapping content at their boundaries

### Requirement: File metadata header in indexed content
Each indexed chunk SHALL include a metadata header prepended to the content: `File: <relative-path>`, `Language: <language>`, `Lines: <start>-<end>`. The relative path SHALL be computed from the workspace root. The language SHALL be inferred from the file extension.

#### Scenario: TypeScript file chunk
- **WHEN** a chunk is created from lines 10-45 of `src/auth/login.ts`
- **THEN** the indexed content starts with `File: src/auth/login.ts\nLanguage: typescript\nLines: 10-45\n\n`

#### Scenario: Python file chunk
- **WHEN** a chunk is created from lines 1-30 of `utils/helpers.py`
- **THEN** the indexed content starts with `File: utils/helpers.py\nLanguage: python\nLines: 1-30\n\n`

### Requirement: Incremental indexing via content hash
The system SHALL use content-addressed hashing to avoid re-indexing unchanged files. On each scan, the system SHALL compute `sha256(fileContent)` for each source file, compare with the stored hash in the `documents` table, skip files with matching hashes, re-index files with mismatched hashes, and deactivate documents for files that no longer exist on disk.

#### Scenario: Unchanged file
- **WHEN** a source file has the same content as the last index run
- **THEN** the file is skipped (no re-chunking, no re-embedding)

#### Scenario: Modified file
- **WHEN** a source file has different content than the last index run
- **THEN** the old document is replaced with newly chunked and embedded content

#### Scenario: Deleted file
- **WHEN** a previously indexed source file no longer exists on disk
- **THEN** the corresponding document and its chunks/embeddings are deactivated or removed

### Requirement: Project type auto-detection for default extensions
When `codebase.extensions` is not configured, the system SHALL auto-detect the project type by checking for marker files in the workspace root and select appropriate default extensions. Detection rules SHALL include: `package.json` maps to `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`, `.html`; `pyproject.toml`, `setup.py`, or `requirements.txt` maps to `.py`, `.pyi`; `go.mod` maps to `.go`; `Cargo.toml` maps to `.rs`; `pom.xml` or `build.gradle` maps to `.java`, `.kt`; `Gemfile` maps to `.rb`. If no marker files are found, all common extensions SHALL be used as fallback. `.md` files SHALL always be included regardless of project type.

#### Scenario: Node.js project detected
- **WHEN** the workspace root contains `package.json` and `codebase.extensions` is not configured
- **THEN** the system indexes files with extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`, `.html`, `.md`

#### Scenario: Python project detected
- **WHEN** the workspace root contains `pyproject.toml` and `codebase.extensions` is not configured
- **THEN** the system indexes files with extensions: `.py`, `.pyi`, `.md`

#### Scenario: Multiple marker files present
- **WHEN** the workspace root contains both `package.json` and `pyproject.toml`
- **THEN** the system merges extensions from both project types

#### Scenario: No marker files found
- **WHEN** the workspace root contains no recognized marker files
- **THEN** the system uses all common extensions as fallback (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.rb`, `.md`)

#### Scenario: Explicit extensions override auto-detection
- **WHEN** `codebase.extensions` is set to `[".go", ".proto"]`
- **THEN** only `.go` and `.proto` files are indexed, regardless of detected project type

### Requirement: Codebase storage budget enforcement
The system SHALL support a `codebase.maxSize` field (default 2GB) that limits the total storage used by codebase-indexed content. During indexing, the system SHALL track cumulative storage and skip remaining files when the budget would be exceeded. The `memory_status` tool SHALL report current codebase storage usage versus the configured limit. The codebase storage budget SHALL be independent from the session storage budget (`storage.maxSize`).

#### Scenario: Indexing within budget
 **WHEN** codebase storage is at 500MB and `codebase.maxSize` is 2GB
 **THEN** files continue to be indexed normally

#### Scenario: Indexing exceeds budget
 **WHEN** codebase storage is at 1.9GB and the next file would push it over 2GB
 **THEN** the file is skipped
 **THEN** remaining files are skipped
 **THEN** the index result reports the number of files skipped due to budget

#### Scenario: Default budget
 **WHEN** `codebase.maxSize` is not configured
 **THEN** the default budget of 2GB is used

#### Scenario: Custom budget
 **WHEN** `codebase.maxSize` is set to `"500MB"`
 **THEN** indexing stops when codebase storage reaches 500MB

#### Scenario: Budget independent from session storage
 **WHEN** session `storage.maxSize` is 2GB and `codebase.maxSize` is 2GB
 **THEN** the system can use up to 4GB total (2GB sessions + 2GB codebase)
 **THEN** codebase budget enforcement does not trigger session eviction


### Requirement: Max file size guard
The system SHALL skip source files larger than `codebase.maxFileSize` (default 5MB). A debug-level log message SHALL be emitted for each skipped file indicating the file path and its size.

#### Scenario: File under size limit
 **WHEN** a source file is 3MB and `maxFileSize` is 5MB
- **THEN** the file is indexed normally

#### Scenario: File exceeding size limit
 **WHEN** a source file is 8MB and `maxFileSize` is 5MB
- **THEN** the file is skipped
- **THEN** a debug log is emitted: file path and size

#### Scenario: Custom maxFileSize
- **WHEN** `codebase.maxFileSize` is set to `"50KB"`
- **THEN** files larger than 50KB are skipped

### Requirement: Watcher integration for codebase files
When codebase indexing is enabled, the file watcher SHALL add the workspace directory as an additional watch target with the configured exclude patterns applied as ignored paths. Source file changes SHALL trigger the same dirty-flag and debounced reindex cycle used for collection files. The watcher SHALL only watch files matching the configured or auto-detected extensions.

#### Scenario: Source file modified
- **WHEN** a watched source file is saved with new content
- **THEN** the watcher detects the change
- **THEN** the file is re-indexed after the debounce period

#### Scenario: New source file created
- **WHEN** a new `.ts` file is created in the workspace (with codebase enabled for a Node.js project)
- **THEN** the watcher detects the new file
- **THEN** the file is indexed after the debounce period

#### Scenario: Excluded directory not watched
- **WHEN** a file changes inside `node_modules/`
- **THEN** the watcher does not detect the change
- **THEN** no reindex is triggered

### Requirement: Codebase documents tagged with workspace project hash
All documents indexed from codebase files SHALL be tagged with the current workspace's `projectHash` in the `project_hash` column. This ensures codebase search results are scoped to the current workspace by default.

#### Scenario: Codebase document indexed
- **WHEN** a source file is indexed with `currentProjectHash = "abc123def456"`
- **THEN** the resulting document has `project_hash = "abc123def456"`

#### Scenario: Codebase search scoped to workspace
- **WHEN** `memory_search` is called with default workspace scoping
- **THEN** codebase documents from the current workspace are included in results
- **THEN** codebase documents from other workspaces are excluded

### Requirement: Codebase collection identified in search results
Documents from the codebase collection SHALL be identifiable in search results via their collection name `"codebase"`. This allows agents to distinguish between session-based memory and source code results.

#### Scenario: Search returns codebase and session results
- **WHEN** a search query matches both a session document and a codebase document
- **THEN** the codebase result has `collection: "codebase"` in its metadata
- **THEN** the session result has a different collection identifier
