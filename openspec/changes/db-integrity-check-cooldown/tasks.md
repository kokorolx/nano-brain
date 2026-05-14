## 1. Core: stamp file helpers

- [ ] 1.1 Add `readStamp(dbPath: string): { ts: number; mtime: number } | null` in `src/db/corruption-recovery.ts` — reads `{dbPath}.checked`, parses `timestamp\tmtime`, returns null on any error
- [ ] 1.2 Add `writeStamp(dbPath: string, mtime: number): void` — writes `{Date.now()}\t{mtime}` to `{dbPath}.checked`, swallows write errors (non-fatal)
- [ ] 1.3 Add `getDbMtime(dbPath: string): number | null` — returns `fs.statSync(dbPath).mtimeMs`, returns null on error
- [ ] 1.4 Add `INTEGRITY_CHECK_COOLDOWN_MS` constant (default `30 * 60 * 1000`), overridable via `process.env.NANO_BRAIN_CHECK_COOLDOWN_MS`

## 2. Core: integrate stamp into checkAndRecoverDB

- [ ] 2.1 After the `checkedPaths.has()` early-return block, add stamp validation:
  - Read stamp and current DB mtime
  - If stamp valid (age < cooldown AND mtime matches) → open DB with applyPragmas, return `{ db, recovered: false }`
  - Otherwise → fall through to existing PRAGMA quick_check path
- [ ] 2.2 After successful PRAGMA quick_check (PASS branch): call `writeStamp(resolvedPath, currentMtime)` before the return
- [ ] 2.3 After recovery path (fresh DB created and verified): call `writeStamp(resolvedPath, freshMtime)` before the return
- [ ] 2.4 Export `clearStamp(dbPath: string): void` helper (deletes `{dbPath}.checked`) — needed for tests and for the corruption recovery path to clear stale stamp on detection

## 3. Tests in `test/sqlite-corruption-fix.test.ts`

- [ ] 3.1 **Stamp written after check**: call `checkAndRecoverDB`, verify `{dbPath}.checked` exists with correct mtime
- [ ] 3.2 **Stamp skips check**: call twice on same DB; second call should not run `PRAGMA quick_check` (spy on `db.pragma`)
- [ ] 3.3 **Stamp invalidated by mtime change**: after first check, update DB file mtime (`fs.utimesSync`), second call should re-run check
- [ ] 3.4 **Stamp invalidated by cooldown**: set `NANO_BRAIN_CHECK_COOLDOWN_MS=0`, second call runs full check
- [ ] 3.5 **Stamp written for fresh DB after recovery**: corrupt a DB, verify recovery runs, verify new stamp exists
- [ ] 3.6 **Stamp read failure is non-fatal**: write garbage to stamp file, verify `checkAndRecoverDB` still works (falls back to full check)
- [ ] 3.7 **Existing tests unchanged**: all existing 305 lines of tests still pass

## 4. Cleanup

- [ ] 4.1 Verify `rm` CLI command (`src/cli/commands/rm.ts`) also removes `{dbPath}.checked` when deleting a workspace DB
- [ ] 4.2 Update `NANO_BRAIN_HOME` env var docs comment in `src/cli/utils.ts` to mention stamp files
