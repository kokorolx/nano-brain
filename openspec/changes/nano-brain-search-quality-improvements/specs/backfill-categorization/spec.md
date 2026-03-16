# Backfill Categorization Spec

## Overview

Retroactively apply LLM categorization to existing documents that lack tags.

## ADDED Requirements

### Requirement: Backfill Command

The system MUST provide CLI command `npx nano-brain backfill-tags` that:
- Finds documents without LLM tags
- Applies LLM categorization to each
- Reports progress and results

#### Scenario: Backfill untagged documents

Given 100 documents exist without LLM tags
When user runs `npx nano-brain backfill-tags`
Then all 100 documents receive LLM-generated tags

### Requirement: Batch Processing

Backfill MUST process documents in batches:
- Default batch size: 50 documents
- Configurable via `--batch-size` flag
- Rate limiting to avoid LLM API throttling

#### Scenario: Batch processing with rate limiting

Given 200 documents need categorization
When backfill runs with batch-size 50
Then documents are processed in 4 batches with rate limiting between batches

### Requirement: Filtering

Backfill MUST support filtering:
- `--collection <name>`: Only process specific collection
- `--since <date>`: Only process documents modified after date
- `--dry-run`: Show what would be categorized without making changes

#### Scenario: Backfill with collection filter

Given documents exist in collections "memory" and "codebase"
When user runs `npx nano-brain backfill-tags --collection memory`
Then only documents in "memory" collection are processed

#### Scenario: Dry run mode

Given 50 documents exist without LLM tags
When user runs `npx nano-brain backfill-tags --dry-run`
Then output shows what would be categorized but no changes are made

### Requirement: Idempotency

Backfill MUST be idempotent:
- Skip documents that already have `llm:*` tags
- Safe to run multiple times

#### Scenario: Skip already tagged documents

Given a document already has `llm:debugging-insight` tag
When backfill runs
Then that document is skipped

## Notes

This spec is handled by another agent. Do not implement.
