## MODIFIED Requirements

### Requirement: Reindex command handler is isolated in its own module
The `handleReindex` function SHALL be located at `src/cli/commands/reindex.ts` rather than inline in `src/index.ts`. All behavior of the reindex command SHALL remain identical.

#### Scenario: Reindex command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain reindex`
- **THEN** the command SHALL execute with identical behavior to before the refactor, including workspace resolution, codebase indexing, and progress output
