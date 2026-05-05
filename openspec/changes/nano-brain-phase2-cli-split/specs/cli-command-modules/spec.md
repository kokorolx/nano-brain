## ADDED Requirements

### Requirement: CLI commands are split into individual modules
Each of the 29 CLI command handlers SHALL reside in its own file at `src/cli/commands/<command>.ts`. Each file SHALL export exactly one `handle*` function as a named export.

#### Scenario: Command file exists for every CLI command
- **WHEN** the Phase 2 refactor is complete
- **THEN** there SHALL be 29 files under `src/cli/commands/`, one for each command: `init`, `update`, `embed`, `reindex`, `write`, `reset`, `rm`, `search`, `get`, `focus`, `context`, `symbols`, `impact`, `code-impact`, `graph-stats`, `detect-changes`, `collection`, `tags`, `harvest`, `wake-up`, `status`, `cache`, `mcp`, `logs`, `qdrant`, `docker`, `categorize-backfill`, `consolidate`, `learning`

#### Scenario: Each command file exports its handler function
- **WHEN** any file in `src/cli/commands/` is imported
- **THEN** it SHALL export exactly one named `handle*` function matching the command name pattern

### Requirement: Shared CLI utilities are extracted to a dedicated module
Utility functions used by multiple command handlers SHALL be extracted to `src/cli/utils.ts` and imported by command files that need them.

#### Scenario: Proxy utilities are available from utils module
- **WHEN** a command handler needs to proxy a request to the running server
- **THEN** it SHALL import `proxyGet`, `proxyPost`, `detectRunningServer` from `../utils.js`

#### Scenario: Container detection is available from utils module
- **WHEN** a command handler needs to determine if it is running in a container
- **THEN** it SHALL import `isRunningInContainer`, `getHttpHost`, `getHttpPort` from `../utils.js`

### Requirement: GlobalOptions type is defined in a dedicated types module
The `GlobalOptions` interface SHALL be defined in `src/cli/types.ts` and imported by all command files.

#### Scenario: GlobalOptions is importable from types module
- **WHEN** a command file is written
- **THEN** it SHALL import `GlobalOptions` from `../types.js`, not define it inline

### Requirement: src/index.ts becomes a barrel shim
`src/index.ts` SHALL be replaced with a minimal barrel re-export from `src/cli/index.ts`, identical in pattern to the Phase 1 `src/store.ts` shim.

#### Scenario: index.ts shim preserves existing import paths
- **WHEN** any external code does `import { main } from './index.js'`
- **THEN** it SHALL continue to work without modification

### Requirement: CLI binary entrypoint is unchanged
The `package.json` `"bin"` field SHALL continue to point to `dist/index.js`. No `package.json` changes are required.

#### Scenario: npx nano-brain commands continue to work after refactor
- **WHEN** a user runs any `npx nano-brain <command>` invocation
- **THEN** it SHALL behave identically to before the refactor

### Requirement: No circular imports are introduced
No file in `src/cli/commands/` SHALL import from `src/cli/index.ts`. The dependency direction SHALL be: `src/cli/index.ts` → `src/cli/commands/*.ts` → `src/cli/utils.ts` / `src/cli/types.ts` → `src/*.ts`.

#### Scenario: TypeScript compiler reports zero circular dependency errors
- **WHEN** `tsc --noEmit` is run after the refactor
- **THEN** it SHALL exit with code 0 and no errors
