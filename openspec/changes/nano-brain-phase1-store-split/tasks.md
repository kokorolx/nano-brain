## 1. Preparation

- [x] 1.1 Verify `tsconfig.json` `moduleResolution` supports folder index resolution (`bundler` or `node16`)
- [x] 1.2 Confirm `src/store.ts` is not listed in `package.json` `exports` field
- [x] 1.3 Check for any existing tests targeting `store.ts` directly
- [x] 1.4 Create `src/store/` directory

## 2. Extract schema.ts

- [x] 2.1 Move `applyPragmas()` function to `src/store/schema.ts`
- [x] 2.2 Move all `CREATE TABLE` / `CREATE VIRTUAL TABLE` / `CREATE INDEX` / `CREATE TRIGGER` DDL to `src/store/schema.ts` as `applySchema(db)`
- [x] 2.3 Move all migration functions (v0–v8+) and `runMigrations(db)` runner to `src/store/schema.ts`
- [x] 2.4 Move all prepared statement initialization to `src/store/schema.ts` as `initStatements(db)` returning a typed stmts map
- [x] 2.5 Run `tsc --noEmit` — zero errors in `schema.ts`

## 3. Extract vectors.ts

- [x] 3.1 Move `setVectorStore`, `getVectorStore`, `vectorStore` closure variable to `src/store/vectors.ts`
- [x] 3.2 Move `insertEmbedding`, `insertEmbeddingLocal`, `insertEmbeddingLocalBatch` to `src/store/vectors.ts`
- [x] 3.3 Move `searchVec`, `searchVecAsync` to `src/store/vectors.ts`
- [x] 3.4 Move `ensureVecTable`, `getHashesNeedingEmbedding`, `getNextHashNeedingEmbedding` to `src/store/vectors.ts`
- [x] 3.5 Move `cleanOrphanedEmbeddings`, `cleanupVectorsForHash`, `getSqliteVecCount` to `src/store/vectors.ts`
- [x] 3.6 Run `tsc --noEmit` — zero errors in `vectors.ts`

## 4. Extract graph.ts

- [x] 4.1 Move `insertFileEdge`, `getFileEdges`, `getFileDependents` to `src/store/graph.ts`
- [x] 4.2 Move `insertOrUpdateEntity`, `getMemoryEntities`, `deleteEntity` to `src/store/graph.ts`
- [x] 4.3 Move `insertEdge`, `getEntityEdges` (memory connections) to `src/store/graph.ts`
- [x] 4.4 Move `querySymbols`, `insertSymbol`, `getInfrastructureSymbols`, `getSymbolsForProject` to `src/store/graph.ts`
- [x] 4.5 Move `getGraphStats`, `getSymbolClusters`, `getDocumentCentrality`, `updateCentralityScores`, `findCycles` to `src/store/graph.ts`
- [x] 4.6 Move `getDocFlows`, `upsertDocFlow`, `getFlowsWithSteps`, `getFlowSteps` to `src/store/graph.ts`
- [x] 4.7 Run `tsc --noEmit` — zero errors in `graph.ts`

## 5. Extract cache.ts

- [x] 5.1 Move `getCachedResult`, `setCachedResult`, `getCacheStats`, `clearCache` to `src/store/cache.ts`
- [x] 5.2 Move `logSearchQuery`, `getTelemetryStats`, `recordTokenUsage` to `src/store/cache.ts`
- [x] 5.3 Move `getLastCorruptionRecovery`, `clearCorruptionRecovery` to `src/store/cache.ts`
- [x] 5.4 Move `enqueueConsolidation`, `getNextPendingJob`, `updateJobStatus`, `getRecentConsolidationLogs` to `src/store/cache.ts`
- [x] 5.5 Run `tsc --noEmit` — zero errors in `cache.ts`

## 6. Extract documents.ts

- [x] 6.1 Move `insertDocument`, `findDocument`, `getDocumentBody` to `src/store/documents.ts`
- [x] 6.2 Move `deactivateDocument`, `bulkDeactivateExcept`, `supersedeDocument`, `deleteDocumentsByPath`, `softDeleteEntities` to `src/store/documents.ts`
- [x] 6.3 Move `searchFTS`, `sanitizeFTS5Query` to `src/store/documents.ts`
- [x] 6.4 Move `registerWorkspacePrefix`, `toRelative`, `resolvePath`, `getWorkspaceRoot`, `getWorkspaceStats`, `removeWorkspace` to `src/store/documents.ts`
- [x] 6.5 Move `getCollectionStorageSize`, `openWorkspaceStore` to `src/store/documents.ts`
- [x] 6.6 Run `tsc --noEmit` — zero errors in `documents.ts`

## 7. Create barrel and wire createStore()

- [x] 7.1 Create `src/store/index.ts` with `createStore()` factory that delegates to all 5 submodules
- [x] 7.2 Re-export all previously public exports: `createStore`, `openWorkspaceStore`, `resolveWorkspaceDbPath`, `extractProjectHashFromPath`, `resolveProjectLabel`, `computeHash`, `indexDocument`, `migrateToRelativePaths`, `cleanupDuplicatePaths`, `getLastCorruptionRecovery`, `closeAllCachedStores`
- [x] 7.3 Delete `src/store.ts` (replaced by thin shim re-exporting from `./store/index.js`)
- [x] 7.4 Run `tsc --noEmit` on entire project — zero new errors (pre-existing bench.ts/treesitter.ts errors unchanged)

## 8. Verification

- [x] 8.1 Smoke-test CLI: `npx nano-brain status` returns correct output
- [x] 8.2 Smoke-test CLI: `npx nano-brain search "test"` returns results
- [x] 8.3 Smoke-test CLI: `npx nano-brain query "test"` returns results
- [ ] 8.4 Verify `setVectorStore` / `getVectorStore` work correctly (check Qdrant receives vectors on next embed cycle)
- [x] 8.5 No existing tests — pre-existing tsc errors in bench.ts/treesitter.ts documented (not introduced by this refactor)
- [x] 8.6 Confirm no file in `src/` imports directly from `./store/schema.ts`, `./store/vectors.ts`, etc. — all imports go through `./store.js` barrel
