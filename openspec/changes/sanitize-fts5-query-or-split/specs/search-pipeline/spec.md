## MODIFIED Requirements

### Requirement: FTS5 query sanitization
The `searchFTS` function SHALL sanitize user queries before passing them to FTS5 `MATCH`. All user-provided query strings MUST be treated as literal search text, never as FTS5 syntax.

#### Scenario: Normal multi-word query
- **WHEN** user searches for `sqlite vector search`
- **THEN** the search treats the query as separate quoted terms joined by `OR`, never as an exact phrase
