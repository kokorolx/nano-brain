## Why

Search results currently lack visibility into document categorization (tags), making it difficult for users to understand why a result was returned and what type of content it represents. Additionally, query expansion is not yet implemented, limiting recall for conceptually related content. Finally, existing documents lack LLM-generated tags, reducing the effectiveness of tag-based filtering.

## What Changes

- **Tag Display in Search Output**: Show both auto-generated (`auto:*`) and LLM-generated (`llm:*`) tags in search results, enabling users to see document categorization at a glance
- **Query Expansion**: Implement semantic query expansion using LLM to improve recall by searching for conceptually related terms
- **Backfill Categorization**: Add a mechanism to retroactively categorize existing documents with LLM-generated tags

## Capabilities

### New Capabilities

- `tag-display`: Display document tags (auto:*, llm:*, user tags) in both verbose and compact search result formats
- `query-expansion`: Expand user queries with semantically related terms using LLM before searching
- `backfill-categorization`: Retroactively apply LLM categorization to existing documents that lack tags

### Modified Capabilities

(none)

## Impact

- **src/server.ts**: Modify `formatSearchResults()` and `formatCompactResults()` to include tags
- **src/types.ts**: Add optional `tags` field to `SearchResult` interface
- **src/search.ts**: Fetch tags for search results before returning
- **src/expansion.ts**: New module for query expansion logic (handled by other agent)
- **src/llm-categorizer.ts**: Backfill logic for existing documents (handled by other agent)
- **No breaking changes**: All changes are additive
- **No new dependencies**: Uses existing LLM infrastructure
