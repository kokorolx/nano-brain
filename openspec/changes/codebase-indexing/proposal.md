## Why

opencode-memory currently indexes only session transcripts, MEMORY.md, and daily logs — it has zero knowledge of the actual source code. When an agent queries `memory_query query="how does authentication work"`, it finds past *conversations* about auth but not the actual implementation. This forces agents to rely on grep (exact keywords only) and LSP (requires knowing symbol names upfront) for code discovery, which fails for semantic/conceptual queries across large codebases.

Indexing source code enables semantic search over the codebase — finding related code by meaning, not just keywords. This is the single highest-impact improvement for agent productivity in unfamiliar or large projects.

## What Changes

- Add support for a `codebase` collection type that indexes source code files from the current workspace
- Add `exclude` patterns to collection config (e.g., `node_modules`, `.git`, `dist`, `build`) to skip irrelevant directories
- Add language-aware chunking for source code files (not just markdown) — respecting function/class boundaries where possible
- Integrate with the existing file watcher for incremental re-indexing on file changes
- Tag codebase documents with the current workspace's `projectHash` for workspace-scoped search
- Auto-detect common exclude patterns based on project type (Node.js, Python, Go, etc.)

## Capabilities

### New Capabilities
- `codebase-collection`: Collection type for indexing source code with exclude patterns, language-aware chunking, and workspace tagging

### Modified Capabilities
- `mcp-server`: Add `memory_index_codebase` tool for on-demand codebase indexing, update `memory_status` to show codebase collection stats

## Impact

- **Config format**: New optional `exclude` field on collection config, new optional `codebase` section in config.yml
- **Chunker**: Needs to handle non-markdown files (`.ts`, `.py`, `.go`, `.rs`, `.java`, etc.) with language-aware splitting
- **Storage**: Codebase indexing will significantly increase document/chunk count — storage limits from v0.2.0 apply
- **Watcher**: Must watch workspace directory with exclude patterns, not just the output directory
- **Dependencies**: No new dependencies expected — fast-glob already supports ignore patterns
