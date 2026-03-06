## ADDED Requirements

### Requirement: Tree-sitter AST parsing extracts code symbols
The system SHALL use Tree-sitter native bindings to parse source files and extract code symbols (functions, classes, methods, interfaces) for TypeScript, JavaScript, and Python files.

#### Scenario: TypeScript file with functions and classes
- **WHEN** a TypeScript file containing exported functions, classes, methods, and interfaces is indexed
- **THEN** the system extracts each symbol with its name, kind (function/class/method/interface), file path, start line, end line, and whether it is exported

#### Scenario: Python file with functions and classes
- **WHEN** a Python file containing functions (def), classes, and methods is indexed
- **THEN** the system extracts each symbol with its name, kind, file path, start line, end line, and whether it is exported (module-level)

#### Scenario: Unsupported language file
- **WHEN** a file with an unsupported language extension (e.g., .go, .rs) is indexed
- **THEN** the system skips Tree-sitter symbol extraction for that file and falls back to existing regex-based import parsing only

#### Scenario: Tree-sitter fails to load
- **WHEN** Tree-sitter native bindings fail to load at startup
- **THEN** the system logs a warning and continues operating with regex-only parsing. No symbol graph features are available but existing functionality is unaffected.

### Requirement: Symbol-level knowledge graph with typed edges
The system SHALL build a symbol-level knowledge graph stored in SQLite tables (`code_symbols`, `symbol_edges`) with typed edges: CALLS, IMPORTS, EXTENDS, IMPLEMENTS.

#### Scenario: Function calls another function
- **WHEN** function A contains a call expression to function B (resolved via import or same-file scope)
- **THEN** a CALLS edge is created from A to B with confidence >= 0.7

#### Scenario: Class extends another class
- **WHEN** class A extends class B
- **THEN** an EXTENDS edge is created from A to B with confidence 1.0

#### Scenario: Class implements an interface
- **WHEN** class A implements interface B
- **THEN** an IMPLEMENTS edge is created from A to B with confidence 1.0

#### Scenario: File imports a symbol
- **WHEN** file A imports symbol X from file B
- **THEN** an IMPORTS edge is created from the importing context to symbol X with confidence 0.9

### Requirement: Confidence scoring on all edges
The system SHALL assign a confidence score (0.0–1.0) to every symbol edge based on parsing certainty.

#### Scenario: Direct AST-resolved call
- **WHEN** a call expression is resolved to a specific symbol via AST analysis and import resolution
- **THEN** the edge confidence SHALL be >= 0.9

#### Scenario: Heuristic name-matched call
- **WHEN** a call expression matches a symbol by name but cannot be fully resolved via imports
- **THEN** the edge confidence SHALL be between 0.5 and 0.8

### Requirement: Incremental symbol indexing
The system SHALL support incremental indexing — only re-parsing files whose content has changed since the last index.

#### Scenario: File unchanged since last index
- **WHEN** a file's content hash matches the stored hash from the previous index
- **THEN** the system skips parsing that file and retains existing symbols and edges

#### Scenario: File changed since last index
- **WHEN** a file's content hash differs from the stored hash
- **THEN** the system deletes all symbols and edges for that file, re-parses it, and inserts new symbols and edges

#### Scenario: File deleted since last index
- **WHEN** a previously indexed file no longer exists on disk
- **THEN** the system deletes all symbols and edges associated with that file

### Requirement: Symbol graph coexists with existing infrastructure symbols
The system SHALL keep the existing infrastructure symbol extraction (Redis keys, MySQL tables, API endpoints, Bull queues) and store code structure symbols in separate tables. Both are queryable.

#### Scenario: File has both code symbols and infrastructure symbols
- **WHEN** a TypeScript file contains a function that calls `redis.get("user:*")` and also calls another function `validateUser()`
- **THEN** the system extracts both the infrastructure symbol (redis_key: "user:*") in the `symbols` table AND the code symbol (function) with its CALLS edge in the `code_symbols`/`symbol_edges` tables
