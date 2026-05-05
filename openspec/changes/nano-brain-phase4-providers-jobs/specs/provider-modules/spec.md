## ADDED Requirements

### Requirement: Provider files are co-located under src/providers/
The files `embeddings.ts`, `reranker.ts`, `llm-provider.ts`, `vector-store.ts`, and `expansion.ts` SHALL be moved to `src/providers/`. Each original path SHALL have a 1-line barrel shim so existing import paths continue to resolve.

#### Scenario: Embeddings provider is importable from original path
- **WHEN** any file does `import { createEmbeddingProvider } from './embeddings.js'`
- **THEN** it SHALL resolve to the implementation in `src/providers/embeddings.ts` via the barrel shim

#### Scenario: All provider exports remain accessible
- **WHEN** `npx tsc --noEmit` is run after the move
- **THEN** there SHALL be zero new type errors caused by the provider file moves

#### Scenario: src/providers/ contains all provider integrations
- **WHEN** the phase is complete
- **THEN** `src/providers/` SHALL contain: `embeddings.ts`, `reranker.ts`, `llm-provider.ts`, `vector-store.ts`, `expansion.ts`, `qdrant.ts`, `sqlite-vec.ts`
