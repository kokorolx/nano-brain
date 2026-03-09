## 1. Implementation

- [x] 1.1 Update `sanitizeFTS5Query` to split tokens and join with OR
- [x] 1.2 Update integration tests for new sanitization behavior

## 2. Verification

- [x] 2.1 Run `npx vitest run test/integration.test.ts`
- [x] 2.2 Run LSP diagnostics on `src/store.ts`
