## Context

FTS5 query sanitization currently wraps the full trimmed input as a single quoted phrase. This prevents per-term matching for multi-word queries and reduces recall for expected search behavior.

## Goals / Non-Goals

**Goals:**
- Split multi-word queries into individual quoted terms joined by `OR`.
- Keep single-token queries as a single quoted term and preserve empty inputs.

**Non-Goals:**
- Adding phrase query support or advanced FTS5 syntax parsing.
- Changing search ranking or other search pipeline behavior.

## Decisions

- Split on whitespace via `/\s+/`, filter empty tokens, escape quotes per token, and join with ` OR ` to preserve literal matching.
- Avoid a full query parser to keep the change minimal and performance-friendly.

## Risks / Trade-offs

- Splitting removes implicit phrase matching for multi-word input; acceptable for literal-term search and aligns with the spec update.
