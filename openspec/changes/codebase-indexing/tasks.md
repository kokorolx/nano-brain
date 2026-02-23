## 1. Types and Configuration

- [x] 1.1 Add `CodebaseConfig` interface to `src/types.ts` with fields: `enabled: boolean`, `exclude?: string[]`, `extensions?: string[]`, `maxFileSize?: string`, `maxSize?: string`
- [x] 1.2 Add optional `codebase?: CodebaseConfig` field to `CollectionConfig` interface in `src/types.ts`
- [x] 1.3 Add `CodebaseIndexResult` interface to `src/types.ts` with fields: `filesScanned`, `filesIndexed`, `filesSkippedUnchanged`, `filesSkippedTooLarge`, `filesSkippedBudget`, `chunksCreated`, `storageUsedBytes`, `maxSizeBytes`
- [x] 1.4 Add `codebase` stats to `IndexHealth` interface: `codebase?: { enabled: boolean; documents: number; chunks: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number }`

## 2. Codebase Scanner Module

- [x] 2.1 Create `src/codebase.ts` with built-in default exclude patterns, project type marker file map
- [x] 2.2 Implement `detectProjectType(workspaceRoot: string): string[]` — check marker files, return merged extensions list, always include `.md`
- [x] 2.3 Implement `loadGitignorePatterns(workspaceRoot: string): string[]` — parse `.gitignore` from workspace root, return patterns array, return empty array if file missing
- [x] 2.4 Implement `mergeExcludePatterns(config: CodebaseConfig, workspaceRoot: string): string[]` — merge config excludes + .gitignore + built-in defaults into single array
- [x] 2.5 Implement `resolveExtensions(config: CodebaseConfig, workspaceRoot: string): string[]` — return config extensions if set, otherwise auto-detect from project type
- [x] 2.6 Implement `scanCodebaseFiles(workspaceRoot: string, config: CodebaseConfig): Promise<{ files: string[]; skippedTooLarge: number }>` — use fast-glob with resolved extensions as pattern and merged excludes as ignore, filter by maxFileSize (default 5MB), return absolute paths
- [x] 2.7 Implement `indexCodebase(store, workspaceRoot, config, projectHash, embedder?): Promise<CodebaseIndexResult>` — scan files, compute hashes, skip unchanged, chunk with `chunkSourceCode`, index via store, deactivate deleted files, embed new chunks, enforce maxSize budget

## 3. Source Code Chunker

- [x] 3.1 Add `findSourceCodeBreakPoints(content: string): BreakPoint[]` to `src/chunker.ts` — score structural boundaries: double blank lines (score 90), function/class/type definitions at line start (score 80), single blank lines (score 40), import/export blocks (score 60), regular line breaks (score 1)
- [x] 3.2 Add `chunkSourceCode(content: string, hash: string, filePath: string, workspaceRoot: string, options?: ChunkOptions): MemoryChunk[]` to `src/chunker.ts` — split using source code break points, prepend metadata header (`File:`, `Language:`, `Lines:`) to each chunk, use same target size (3600 chars) and overlap (540 chars) as markdown chunker
- [x] 3.3 Add `inferLanguage(filePath: string): string` helper — map file extension to language name (`.ts` → `typescript`, `.py` → `python`, `.go` → `go`, etc.)

## 4. Watcher Integration

- [x] 4.1 Add `codebaseConfig?: CodebaseConfig` and `workspaceRoot?: string` and `projectHash?: string` fields to `WatcherOptions` interface in `src/watcher.ts`
- [x] 4.2 In `setupWatcher()`, when `codebaseConfig?.enabled`, add workspace root as additional chokidar watch target with merged exclude patterns as `ignored` option
- [x] 4.3 In watcher file change handlers (`add`, `change`, `unlink`), check if file matches codebase extensions (not just `.md`) and trigger `handleFileChange` accordingly
- [x] 4.4 In `triggerReindex()`, after collection reindex loop, if codebase is enabled, call `indexCodebase()` for the workspace root

## 5. MCP Server Integration

- [x] 5.1 Register `memory_index_codebase` tool in `src/server.ts` — no required params, calls `indexCodebase()`, returns `CodebaseIndexResult` summary with storage usage. If codebase not enabled, return error message.
- [x] 5.2 Update `memory_status` handler in `src/server.ts` to include codebase stats section (enabled, document count, storage used/limit, resolved extensions, exclude count) when codebase is enabled
- [x] 5.3 Load codebase config from `CollectionConfig.codebase` at server startup and pass to watcher setup

## 6. Storage Budget

- [x] 6.1 Add `maxSize?: string` to `CodebaseConfig` (default 2GB)
- [x] 6.2 Add `getCollectionStorageSize(collection: string): number` to Store interface and implement in `src/store.ts`
- [x] 6.3 Enforce budget in `indexCodebase()` — track cumulative storage, skip files when over limit
- [x] 6.4 Report storage usage in `getCodebaseStats()` and `formatStatus()`

## 7. Tests

- [ ] 7.1 Add unit tests for `detectProjectType()` — Node.js, Python, Go, Rust, multi-marker, no-marker scenarios
- [ ] 7.2 Add unit tests for `loadGitignorePatterns()` — existing .gitignore, missing .gitignore, complex patterns
- [ ] 7.3 Add unit tests for `mergeExcludePatterns()` — all three sources, missing sources, deduplication
- [ ] 7.4 Add unit tests for `resolveExtensions()` — explicit config, auto-detect, fallback
- [ ] 7.5 Add unit tests for `chunkSourceCode()` — TypeScript file, Python file, small file (single chunk), large file (multiple chunks with overlap), metadata header format
- [ ] 7.6 Add unit tests for `findSourceCodeBreakPoints()` — function defs, class defs, blank lines, import blocks
- [ ] 7.7 Add unit tests for `inferLanguage()` — all supported extensions, unknown extension
- [ ] 7.8 Add unit tests for `scanCodebaseFiles()` — respects exclude patterns, respects extensions, skips files over maxFileSize
- [ ] 7.9 Add integration test for `indexCodebase()` — indexes files, skips unchanged, detects deleted, tags with projectHash, enforces budget
- [ ] 7.10 Add integration test for `memory_index_codebase` MCP tool — enabled case, disabled case
- [ ] 7.11 Add integration test for `getCollectionStorageSize()` — returns correct size for collection
