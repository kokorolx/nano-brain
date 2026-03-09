## 1. Add constants and flag parsing

- [x] 1.1 Add `LOGS_DIR` constant: `path.join(NANO_BRAIN_HOME, 'logs')`
- [x] 1.2 Parse category flags in `handleReset`: `--databases`, `--sessions`, `--memory`, `--logs`, `--vectors`
- [x] 1.3 If no category flags given, select ALL categories (backward compat)

## 2. Implement selective deletion

- [x] 2.1 Add memory directory deletion when `--memory` flag or all selected
- [x] 2.2 Add logs directory deletion when `--logs` flag or all selected
- [x] 2.3 Wrap existing database deletion in `--databases` flag check
- [x] 2.4 Wrap existing sessions deletion in `--sessions` flag check
- [x] 2.5 Wrap existing Qdrant deletion in `--vectors` flag check

## 3. Update dry-run output

- [x] 3.1 Show which categories are selected in dry-run output
- [x] 3.2 Only show selected categories in preview

## 4. Update help text

- [x] 4.1 Add new flags to `showHelp()` reset command section

## 5. Add tests

- [x] 5.1 Test each flag individually
- [x] 5.2 Test combined flags
- [x] 5.3 Test no flags = all categories
- [x] 5.4 Test dry-run with flags
- [x] 5.5 Test backward compatibility

## 6. Verification

- [x] 6.1 Run `npx vitest run` — all tests pass (872 tests)
- [x] 6.2 Verify `nano-brain reset --databases --dry-run` shows only databases
- [x] 6.3 Verify `nano-brain reset --confirm` still deletes everything
