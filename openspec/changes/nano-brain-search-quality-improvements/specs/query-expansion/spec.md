# Query Expansion Spec

## Overview

Expand user queries with semantically related terms to improve search recall.

## ADDED Requirements

### Requirement: Expansion Module

The system MUST provide `src/expansion.ts` module that:
- Takes a user query string
- Returns expanded query with related terms
- Uses LLM to generate semantically related terms

#### Scenario: Expand query with LLM

Given a query "authentication"
When the expansion module processes it
Then it returns related terms like "auth", "login", "credentials"

### Requirement: Integration with Hybrid Search

The `hybridSearch()` function MUST:
- Call expansion module when `expansion.enabled` is true in config
- Use expanded terms for both FTS and vector search
- Weight expanded terms according to `expansion.weight` config

#### Scenario: Hybrid search uses expanded terms

Given expansion is enabled
When hybridSearch is called with query "auth"
Then both FTS and vector search use expanded terms

### Requirement: Caching

Expanded queries MUST be cached in `llm_cache` table:
- Cache key: hash of original query
- Cache type: 'expansion'
- TTL: Follow existing cache retention policy

#### Scenario: Cached expansion reused

Given a query was previously expanded
When the same query is searched again
Then the cached expansion is used without calling LLM

### Requirement: Configuration

Expansion MUST be configurable via `search.expansion` in config:

```yaml
search:
  expansion:
    enabled: true
    weight: 1.0
```

#### Scenario: Query expansion enabled

Given expansion is enabled in config
When user runs `memory_query` with query "authentication"
Then the search includes expanded terms like "auth", "login", "credentials"

#### Scenario: Query expansion disabled

Given expansion is disabled in config
When user runs `memory_query` with query "authentication"
Then only the original query term is used

## Notes

This spec is handled by another agent. Do not implement.
