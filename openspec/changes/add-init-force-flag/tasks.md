## 1. Store: clearWorkspace method

- [x] 1.1 Add `clearWorkspace(projectHash: string): { documentsDeleted: number; embeddingsDeleted: number }` to the `Store` interface in `src/types.ts`
- [x] 1.2 Implement `clearWorkspace` in `src/store.ts` using a transaction: collect workspace documents, delete FTS entries, delete embeddings/vectors for orphaned hashes, delete documents, delete orphaned content. Return counts.
- [x] 1.3 Add unit tests for `clearWorkspace` in `test/store.test.ts`: verify documents deleted, global docs preserved, other workspace docs preserved, shared content hashes preserved, orphaned content cleaned up, return counts correct.

## 2. CLI: --force flag parsing

- [x] 2.1 In `src/index.ts` `handleInit()`, add `--force` flag parsing in the argument loop (alongside existing `--root=`).
- [x] 2.2 After store creation and projectHash computation, add force logic: if `--force`, call `store.clearWorkspace(projectHash)` and print summary of what was cleared.
- [x] 2.3 Update the help text string in `src/index.ts` to document `--force` under the `init` command section.

## 3. Testing

- [x] 3.1 Add integration test: `init --force` clears workspace data and re-indexes cleanly (create docs, call clearWorkspace, verify docs gone, re-index, verify new docs present).
- [x] 3.2 Add integration test: `init --force` preserves global documents and other workspace documents.
- [x] 3.3 Run full test suite and verify no regressions.

## 4. Release

- [x] 4.1 Bump version in `package.json` to `2026.1.14`.
- [x] 4.2 Add changelog entry for `2026.1.14` documenting the `init --force` feature.
