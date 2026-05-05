## ADDED Requirements

### Requirement: Background job files are co-located under src/jobs/
The files `watcher.ts`, `consolidation.ts`, and `consolidation-worker.ts` SHALL be moved to `src/jobs/`. Each original path SHALL have a 1-line barrel shim so existing import paths continue to resolve.

#### Scenario: Watcher is importable from original path
- **WHEN** any file does `import { startWatcher } from './watcher.js'`
- **THEN** it SHALL resolve to the implementation in `src/jobs/watcher.ts` via the barrel shim

#### Scenario: All job exports remain accessible
- **WHEN** `npx tsc --noEmit` is run after the move
- **THEN** there SHALL be zero new type errors caused by the job file moves

#### Scenario: src/jobs/ contains all background workers
- **WHEN** the phase is complete
- **THEN** `src/jobs/` SHALL contain: `watcher.ts`, `consolidation.ts`, `consolidation-worker.ts`
