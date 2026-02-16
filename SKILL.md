# opencode-memory

Memory system for OpenCode with hybrid search across past sessions, curated memory, and daily logs.

## Available Tools

### memory_search
BM25 keyword search. Fast, exact matching.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection

### memory_vsearch
Semantic vector search using embeddings.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection

### memory_query
Full hybrid search with query expansion, RRF fusion, and LLM reranking. Best quality.
- query: Search query (required)
- limit: Max results (default: 10)
- collection: Filter by collection
- minScore: Minimum score threshold

### memory_get
Retrieve a document by path or docid.
- id: Document path or #docid (required)
- fromLine: Start line number
- maxLines: Number of lines to return

### memory_write
Write to daily log or MEMORY.md.
- content: Content to write (required)
- target: "daily" or "memory" (default: "daily")

### memory_status
Show index health, collections, and model status.

### memory_update
Trigger immediate reindex of all collections.

## Usage Patterns

**Recall past work:**
Use memory_search or memory_query to find relevant past sessions and decisions.

**Save important context:**
Use memory_write to save key decisions, patterns, or context for future sessions.

**Check what's indexed:**
Use memory_status to see collection health and model availability.
