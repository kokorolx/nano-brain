## ADDED Requirements

### Requirement: Golden fixture directory structure

Each golden fixture SHALL be a directory at `test/eval/fixtures/<fixture-name>/` containing:
- `src/` directory with source code files
- `ground-truth.json` with expected symbols, edges, and flows
- `fixture.json` with metadata (language, description)

#### Scenario: Valid fixture structure
- **WHEN** a golden fixture directory exists at `test/eval/fixtures/ts-simple/`
- **THEN** it MUST contain `src/` directory with at least one source file
- **THEN** it MUST contain `ground-truth.json` with valid JSON
- **THEN** it MUST contain `fixture.json` with `language` and `description` fields

### Requirement: Ground truth symbol format

Ground truth symbols SHALL specify name, kind, file path, start line, and exported status.

#### Scenario: Symbol definition in ground truth
- **WHEN** a symbol is defined in `ground-truth.json`
- **THEN** it MUST have `name` (string), `kind` (function|class|method|variable|interface|type), `filePath` (relative to src/), `startLine` (number), and `exported` (boolean)

#### Scenario: Symbol matching tolerance
- **WHEN** comparing pipeline output to ground truth symbols
- **THEN** line numbers MUST match within ±2 lines tolerance
- **THEN** name, kind, and filePath MUST match exactly

### Requirement: Ground truth edge format

Ground truth edges SHALL specify source symbol, target symbol, edge type, and optional confidence range.

#### Scenario: Edge definition in ground truth
- **WHEN** an edge is defined in `ground-truth.json`
- **THEN** it MUST have `source` and `target` in "file:name" format
- **THEN** it MUST have `edgeType` (CALLS|EXTENDS|IMPLEMENTS)
- **THEN** it MAY have `expectedConfidence` with `min` and `max` for CALLS edges

#### Scenario: Edge matching
- **WHEN** comparing pipeline output to ground truth edges
- **THEN** source, target, and edgeType MUST match exactly
- **THEN** if `expectedConfidence` is specified, actual confidence MUST be within range

### Requirement: Ground truth flow format

Ground truth flows SHALL specify label, flow type, entry symbol, terminal symbol, and expected steps.

#### Scenario: Flow definition in ground truth
- **WHEN** a flow is defined in `ground-truth.json`
- **THEN** it MUST have `label` (string), `flowType` (intra_community|cross_community)
- **THEN** it MUST have `entrySymbol` and `terminalSymbol` in "file:name" format
- **THEN** it MUST have `expectedSteps` as ordered array of "file:name" strings

#### Scenario: Flow matching
- **WHEN** comparing pipeline output to ground truth flows
- **THEN** entry and terminal symbols MUST match exactly
- **THEN** step sequences MUST match at least 80% of expected steps in order

### Requirement: TypeScript simple fixture (ts-simple)

A single-file TypeScript fixture SHALL exist with basic function calls for baseline accuracy testing.

#### Scenario: ts-simple fixture content
- **WHEN** the ts-simple fixture is loaded
- **THEN** it MUST contain 5-10 symbols
- **THEN** it MUST contain 3-5 CALLS edges
- **THEN** it MUST contain 1-2 flows
- **THEN** it MUST test basic symbol extraction and direct function calls

### Requirement: TypeScript complex fixture (ts-complex)

A multi-file TypeScript fixture SHALL exist with classes, inheritance, re-exports, and method chaining.

#### Scenario: ts-complex fixture content
- **WHEN** the ts-complex fixture is loaded
- **THEN** it MUST contain 20-30 symbols across multiple files
- **THEN** it MUST contain 15-25 edges including CALLS, EXTENDS, and IMPLEMENTS
- **THEN** it MUST contain 5-10 flows including cross_community flows
- **THEN** it MUST test cross-file resolution, inheritance, re-exports, and method chaining

### Requirement: Python fixture (py-mixed)

A Python fixture SHALL exist with classes, decorators, and dynamic patterns.

#### Scenario: py-mixed fixture content
- **WHEN** the py-mixed fixture is loaded
- **THEN** it MUST contain 15-20 symbols
- **THEN** it MUST contain 10-15 edges
- **THEN** it MUST contain 3-5 flows
- **THEN** it MUST test Python-specific patterns including decorators and class methods
