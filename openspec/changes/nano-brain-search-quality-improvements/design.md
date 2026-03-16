## Context

nano-brain is an MCP server providing persistent memory and code intelligence for AI coding agents. Search results currently return document metadata (path, score, snippet) but not the categorization tags that help users understand document types. The system already has:
- `document_tags` table storing tags per document
- `store.getDocumentTags(documentId)` method to retrieve tags
- Auto-categorization (`auto:*` tags) applied during indexing
- LLM categorization (`llm:*` tags) infrastructure in place

## Goals / Non-Goals

**Goals:**
- Display tags in search results (both verbose and compact formats)
- Implement query expansion for improved recall
- Backfill existing documents with LLM-generated tags

**Non-Goals:**
- Changing the tag storage schema
- Modifying auto-categorization logic
- Adding new tag types beyond existing prefixes

## Decisions

### 1. Tag Display Format

**Decision**: Show tags on a separate line in verbose format, inline in compact format.

**Verbose format:**
```
### 1. Document Title (abc123)
**Path:** path/to/file | **Score:** 0.850 | **Lines:** 1-50
**Tags:** auto:debugging-insight, llm:debugging-insight
```

**Compact format:**
```
1. [0.850] Title (abc123) — path:1 [symbols] [auto:debug, llm:debug] | snippet...
```

**Rationale**: Verbose format has room for full tag names; compact format needs abbreviation to stay on one line.

**Alternatives considered:**
- Embedding tags in title line — rejected, too cluttered
- Separate tags section at end — rejected, loses per-result context

### 2. Tag Fetching Strategy

**Decision**: Fetch tags in the search handlers after getting results, before formatting.

**Rationale**: 
- Keeps store search methods focused on retrieval
- Tags are only needed for display, not ranking
- Minimal performance impact (single query per result batch)

**Alternatives considered:**
- Join tags in SQL query — rejected, complicates existing search queries
- Add tags to SearchResult in store — rejected, not all callers need tags

### 3. SearchResult Type Extension

**Decision**: Add optional `tags?: string[]` field to `SearchResult` interface.

**Rationale**: Optional field maintains backward compatibility with existing code that doesn't use tags.

## Risks / Trade-offs

**[Risk] Performance overhead from tag fetching** → Mitigation: Batch fetch tags for all results in single query, not N+1 queries.

**[Risk] Compact format line length** → Mitigation: Truncate tag list if >3 tags, show count instead.

**[Risk] Missing tags for old documents** → Mitigation: Backfill categorization feature addresses this.
