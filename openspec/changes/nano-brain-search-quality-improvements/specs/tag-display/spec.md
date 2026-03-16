# Tag Display Spec

## Overview

Display document tags in search results to help users understand document categorization.

## ADDED Requirements

### Requirement: Verbose Format Tag Display

Search results in verbose format (compact=false) MUST display tags after the Score/Lines line:

```
### 1. Document Title (abc123)
**Path:** path/to/file | **Score:** 0.850 | **Lines:** 1-50
**Tags:** auto:debugging-insight, llm:debugging-insight
**Symbols:** functionName, className
```

- Tags line MUST only appear if document has tags
- Tags MUST be comma-separated
- Tags MUST preserve their full prefix (auto:, llm:, or no prefix for user tags)

#### Scenario: Verbose search with tags

Given a document with tags `auto:debugging-insight` and `llm:debugging-insight`
When user runs `memory_search` with `compact=false`
Then the result includes a `**Tags:**` line showing both tags

### Requirement: Compact Format Tag Display

Search results in compact format (compact=true) MUST display abbreviated tags inline:

```
1. [0.850] Title (abc123) — path:1 [symbols] [auto:debug, llm:debug] | snippet...
```

- Tags MUST appear in square brackets after symbols (or after path if no symbols)
- Tag names MUST be abbreviated: `auto:debugging-insight` → `auto:debug`
- If more than 3 tags, show first 2 and count: `[auto:debug, llm:debug +2]`
- Tags section MUST be omitted if document has no tags

#### Scenario: Compact search with tags

Given a document with tags `auto:debugging-insight` and `llm:debugging-insight`
When user runs `memory_search` with `compact=true`
Then the result line includes `[auto:debug, llm:debug]` inline

### Requirement: SearchResult Type

The `SearchResult` interface MUST include an optional `tags` field:

```typescript
interface SearchResult {
  // ... existing fields
  tags?: string[];
}
```

#### Scenario: SearchResult includes tags field

Given the SearchResult type definition
When a search result is created
Then it MAY include a `tags` array of strings

### Requirement: Tag Fetching

Search handlers (memory_search, memory_vsearch, memory_query) MUST:
1. Fetch tags for each result using `store.getDocumentTags(docId)`
2. Attach tags to SearchResult before formatting
3. Handle missing tags gracefully (empty array or undefined)

#### Scenario: Search result without tags

Given a document with no tags
When user runs `memory_search`
Then no tags line or section is displayed for that result
