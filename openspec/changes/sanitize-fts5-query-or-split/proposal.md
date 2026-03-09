## Why

Multi-word FTS5 searches currently wrap the full input as a single quoted phrase, which prevents per-term matching and reduces recall. Splitting into per-term OR keeps queries literal while matching expected FTS behavior.

## What Changes

- Sanitize FTS5 queries by splitting whitespace-delimited terms, escaping quotes per token, and joining with `OR`.
- Preserve single-token queries as a single quoted literal and keep empty/whitespace-only inputs empty.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `search-pipeline`: FTS5 query sanitization now treats multi-word input as OR-joined quoted terms instead of a single phrase.

## Impact

- Affects FTS5 query sanitization in `sanitizeFTS5Query` and related integration tests.
