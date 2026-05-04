## MODIFIED Requirements

### Requirement: Code intelligence command handlers are isolated in their own modules
The handlers `handleSymbols`, `handleImpact`, `handleCodeImpact`, `handleContext`, `handleDetectChanges`, `handleFocus`, and `handleGraphStats` SHALL each be located in their own file under `src/cli/commands/`. All behavior of these commands SHALL remain identical.

#### Scenario: Symbols command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain symbols`
- **THEN** the command SHALL execute with identical behavior to before the refactor

#### Scenario: Impact command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain impact`
- **THEN** the command SHALL execute with identical behavior to before the refactor

#### Scenario: Context command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain context`
- **THEN** the command SHALL execute with identical behavior to before the refactor

#### Scenario: Detect-changes command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain detect-changes`
- **THEN** the command SHALL execute with identical behavior to before the refactor

#### Scenario: Focus command executes correctly after module extraction
- **WHEN** a user runs `npx nano-brain focus`
- **THEN** the command SHALL execute with identical behavior to before the refactor
