## Why

nano-brain's memory consolidation system (`ConsolidationAgent`) is fully scaffolded — interface, prompt builder, response parser, watcher timer, CLI command, MCP tool — but entirely stubbed. It cannot run because there is no LLM provider implementation, `getUnconsolidatedMemories()` returns an empty array, and `applyConsolidation()` only logs. The gitlab-duo-proxy is now deployed at `gl-proxy.thnkandgrow.com` with 11 models available via OpenAI-compatible API, making it the ideal backend to activate consolidation.

## What Changes

- New `GitlabDuoLLMProvider` class implementing the existing `LLMProvider` interface, calling the gitlab-duo-proxy OpenAI-compatible endpoint (`/v1/chat/completions`)
- `createLLMProvider(config)` factory function for config-driven instantiation
- `getUnconsolidatedMemories()` implemented to query the store for recent un-consolidated documents in the `memory` collection
- `applyConsolidation()` implemented to persist consolidation results into the existing `consolidations` table
- CLI `consolidate` command wired to create a real provider and run a consolidation cycle
- MCP `memory_consolidate` tool wired to create a real provider and run on demand
- Config support: `consolidation.enabled`, `consolidation.endpoint`, `consolidation.model`, `consolidation.apiKey`

## Capabilities

### New Capabilities
- `llm-provider`: OpenAI-compatible LLM provider that calls gitlab-duo-proxy for chat completions
- `consolidation-pipeline`: End-to-end consolidation pipeline — query unconsolidated memories, send to LLM, persist results

### Modified Capabilities

## Impact

- `src/llm-provider.ts` — new file (~80 lines)
- `src/consolidation.ts` — implement 2 stubbed methods
- `src/index.ts` — wire CLI consolidate command (~15 lines changed)
- `src/server.ts` — wire MCP memory_consolidate tool (~20 lines changed)
- No new dependencies (uses native `fetch`)
- No schema migration (uses existing `consolidations` table)
