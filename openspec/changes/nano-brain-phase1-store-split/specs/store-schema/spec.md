## ADDED Requirements

### Requirement: Schema module owns all DDL and migration logic
The system SHALL extract all SQLite schema DDL, migration runners, pragma setup, and prepared statement initialization from `store.ts` into a dedicated `src/store/schema.ts` module.

#### Scenario: Schema is applied on new database
- **WHEN** `applySchema(db)` is called on a fresh SQLite connection
- **THEN** all 25+ tables, FTS virtual tables, triggers, and indexes are created without error

#### Scenario: Migrations run in order
- **WHEN** `runMigrations(db)` is called
- **THEN** all pending migrations (v0–v8+) execute in ascending version order and the DB version is updated

#### Scenario: Pragmas are applied before any queries
- **WHEN** `applyPragmas(db)` is called
- **THEN** WAL mode, foreign keys, busy timeout, and synchronous mode are set on the connection

#### Scenario: Prepared statements are initialized once
- **WHEN** `initStatements(db)` is called
- **THEN** all 50+ prepared statements are compiled and returned as a named map for use by other submodules

### Requirement: Schema module has no dependency on other store submodules
The `schema.ts` module SHALL import only from `types.ts`, Node stdlib, and `better-sqlite3`. It SHALL NOT import from `documents.ts`, `vectors.ts`, `graph.ts`, or `cache.ts`.

#### Scenario: Isolated import graph
- **WHEN** the TypeScript compiler resolves imports in `schema.ts`
- **THEN** no import path points to another `src/store/` submodule
