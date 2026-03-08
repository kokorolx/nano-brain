## 1. Add handleReset function

- [x] 1.1 In `src/index.ts`, add `async function handleReset(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void>` before the `main()` function.
- [x] 1.2 Parse flags: `--confirm` (required), `--dry-run` (optional). If `--confirm` is missing, print error and exit.
- [x] 1.3 Delete SQLite databases: read `path.dirname(globalOpts.dbPath)`, find all `*.sqlite` files, delete each. Print count.
- [x] 1.4 Delete harvested sessions: use `DEFAULT_OUTPUT_DIR` constant (same one used by harvester). `rmSync(dir, { recursive: true, force: true })`. Print status.
- [x] 1.5 Delete Qdrant collection: read `vector.url` from config (or default `http://localhost:6333`), use `resolveHostUrl()`, `fetch(DELETE /collections/nano-brain)`. Best-effort — catch errors and print warning.
- [x] 1.6 For `--dry-run`: list what would be deleted (file counts, directory path, Qdrant status) without deleting.
- [x] 1.7 Print summary: "✅ Reset complete."

## 2. Wire up command

- [x] 2.1 Add `case 'reset':` in the main command switch, calling `handleReset(globalOpts, commandArgs)`.
- [x] 2.2 Update `showHelp()` with reset command documentation.

## 3. Verification

- [x] 3.1 Run `lsp_diagnostics` on `src/index.ts` — zero errors.
- [x] 3.2 Verify `nano-brain reset` (without --confirm) prints error.
- [x] 3.3 Verify `nano-brain reset --dry-run` shows preview without deleting.
