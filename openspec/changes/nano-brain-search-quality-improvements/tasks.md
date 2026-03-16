# Tasks

## Feature 1: Tag Display (Agent: build)

### Phase 1: Type Updates
- [x] Add `tags?: string[]` field to `SearchResult` interface in `src/types.ts`

### Phase 2: Formatting Functions
- [x] Modify `formatSearchResults()` in `src/server.ts` to display tags after Score/Lines line
- [x] Modify `formatCompactResults()` in `src/server.ts` to display abbreviated tags inline
- [x] Add helper function `abbreviateTag(tag: string)` to shorten tag names for compact format
- [x] Add helper function `formatTagsCompact(tags: string[])` to handle truncation when >3 tags

### Phase 3: Search Handler Integration
- [x] Update `memory_search` handler to fetch tags for results before formatting
- [x] Update `memory_vsearch` handler to fetch tags for results before formatting
- [x] Update `memory_query` handler to fetch tags for results before formatting
- [x] Create helper function `attachTagsToResults(results, store)` to batch fetch tags

### Phase 4: Verification
- [x] Run `lsp_diagnostics` on `src/server.ts`
- [x] Run `lsp_diagnostics` on `src/types.ts`

## Feature 2: Query Expansion

- [x] Implement LLM-based QueryExpander in `src/expansion.ts`
- [x] Create `createLLMQueryExpander(llmProvider)` factory
- [x] Design expansion prompt (2-3 query variants, JSON response)
- [x] Handle LLM failures gracefully (return empty array)
- [x] Wire expander into server.ts SearchProviders
- [x] Caching already built in search.ts (getCachedResult/setCachedResult)
- [x] Add unit tests (test/expansion.test.ts — 8 tests)
- [x] lsp_diagnostics clean

## Feature 3: Backfill Categorization

- [x] Add `backfill-tags` CLI command in src/index.ts
- [x] Add `getUncategorizedDocuments()` store method
- [x] Implement batch processing with rate limiting
- [x] Add --batch-size, --dry-run, --collection options
- [x] Show progress output via cliOutput()
- [x] Add unit tests (test/backfill.test.ts — 10 tests)
- [x] lsp_diagnostics clean
