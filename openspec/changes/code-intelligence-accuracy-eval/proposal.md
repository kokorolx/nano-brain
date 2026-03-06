## Why

We built code intelligence tools (Tree-sitter AST parsing, symbol graph, flow detection, impact analysis, search enrichment) with 99 unit tests that verify individual functions work correctly. However, we have NO end-to-end accuracy evaluation. We cannot answer: "Does the full pipeline produce CORRECT results?" We need to measure precision, recall, and F1 scores across accuracy dimensions: symbol extraction, edge resolution, flow detection, impact analysis, and confidence calibration.

## What Changes

- Add golden fixture codebases with manually-defined ground truth (every correct symbol, edge, and flow as JSON)
- Create evaluation harness that runs full indexing pipeline on golden fixtures and compares output vs ground truth
- Implement accuracy metrics: precision (of things found, how many are correct), recall (of correct things, how many were found), F1 score per dimension
- Add confidence calibration measurement (verify 0.8 confidence means ~80% correct)
- Enable regression tracking with JSON baselines and cross-run comparison (similar to existing bench.ts --save/--compare pattern)

## Capabilities

### New Capabilities

- `golden-fixtures`: Ground truth fixture codebases with known-correct symbol graphs, edges, and flows for TypeScript and Python
- `eval-harness`: Evaluation runner that measures precision/recall/F1 by comparing pipeline output against golden fixtures
- `accuracy-reporting`: Human-readable and JSON accuracy reports with regression comparison across runs

### Modified Capabilities

## Impact

- New test fixtures in `test/eval/fixtures/` with realistic TypeScript/Python codebases
- New evaluation code in `src/eval/` or `test/eval/`
- Integration with existing bench infrastructure (`src/bench.ts`, `test/bench/fixtures.ts`)
- CI integration for accuracy regression detection
- Affected source files: src/treesitter.ts, src/symbol-graph.ts, src/flow-detection.ts, src/server.ts, src/search.ts (as evaluation targets)
