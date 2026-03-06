## 1. Infrastructure Setup

- [ ] 1.1 Create `test/eval/` directory structure with `fixtures/` subdirectory
- [ ] 1.2 Create `src/eval/` directory for evaluation harness code
- [ ] 1.3 Add `npm run eval` script to package.json pointing to vitest eval config
- [ ] 1.4 Create vitest config for eval tests (separate from unit tests)

## 2. Ground Truth Types and Validation

- [ ] 2.1 Create `src/eval/types.ts` with GroundTruth, FixtureMetadata, and EvalResult interfaces
- [ ] 2.2 Create `src/eval/loader.ts` to load and validate fixture directories
- [ ] 2.3 Add JSON schema validation for ground-truth.json and fixture.json files
- [ ] 2.4 Create helper function to resolve "file:name" format to symbol IDs

## 3. Golden Fixture: ts-simple

- [ ] 3.1 Create `test/eval/fixtures/ts-simple/fixture.json` with metadata
- [ ] 3.2 Create `test/eval/fixtures/ts-simple/src/index.ts` with 5-10 functions and basic calls
- [ ] 3.3 Create `test/eval/fixtures/ts-simple/ground-truth.json` with manually verified symbols, edges, flows
- [ ] 3.4 Verify ts-simple fixture loads correctly with loader

## 4. Golden Fixture: ts-complex

- [ ] 4.1 Create `test/eval/fixtures/ts-complex/fixture.json` with metadata
- [ ] 4.2 Create `test/eval/fixtures/ts-complex/src/` with multiple files: index.ts, service.ts, types.ts, utils.ts
- [ ] 4.3 Add class inheritance (EXTENDS), interface implementation (IMPLEMENTS), re-exports
- [ ] 4.4 Add method chaining, callbacks, and cross-file calls
- [ ] 4.5 Create `test/eval/fixtures/ts-complex/ground-truth.json` with 20-30 symbols, 15-25 edges, 5-10 flows
- [ ] 4.6 Verify ts-complex fixture loads correctly with loader

## 5. Golden Fixture: py-mixed

- [ ] 5.1 Create `test/eval/fixtures/py-mixed/fixture.json` with metadata
- [ ] 5.2 Create `test/eval/fixtures/py-mixed/src/` with Python files: main.py, service.py, utils.py
- [ ] 5.3 Add class definitions, decorators, and method calls
- [ ] 5.4 Create `test/eval/fixtures/py-mixed/ground-truth.json` with 15-20 symbols, 10-15 edges, 3-5 flows
- [ ] 5.5 Verify py-mixed fixture loads correctly with loader

## 6. Evaluation Harness Core

- [ ] 6.1 Create `src/eval/harness.ts` with main evaluation runner function
- [ ] 6.2 Implement fixture indexing: create temp DB, run full pipeline (parse → symbols → edges → flows)
- [ ] 6.3 Implement symbol comparison with ±2 line tolerance
- [ ] 6.4 Implement edge comparison (source, target, type matching)
- [ ] 6.5 Implement flow comparison with 80% step match threshold
- [ ] 6.6 Calculate precision, recall, F1 per dimension

## 7. Confidence Calibration

- [ ] 7.1 Create `src/eval/calibration.ts` for confidence calibration measurement
- [ ] 7.2 Implement confidence bucketing (0.8-0.85, 0.85-0.9, 0.9-0.95, 0.95-1.0)
- [ ] 7.3 Calculate actual accuracy per bucket
- [ ] 7.4 Calculate calibration error per bucket and mean calibration error

## 8. Accuracy Reporting

- [ ] 8.1 Create `src/eval/report.ts` for report generation
- [ ] 8.2 Implement human-readable report format with per-fixture and aggregate metrics
- [ ] 8.3 Implement JSON report format with full structure
- [ ] 8.4 Add --json flag support to output JSON instead of human-readable

## 9. Regression Tracking

- [ ] 9.1 Implement --save flag to save results to `~/.nano-brain/eval-baselines/<timestamp>.json`
- [ ] 9.2 Implement loadLatestBaseline() to find most recent baseline
- [ ] 9.3 Implement --compare flag to compare against latest baseline
- [ ] 9.4 Implement comparison report showing delta and direction (↑/↓/≈)
- [ ] 9.5 Implement --fail-on-regression flag with exit code 1 on F1 drop > 0.05
- [ ] 9.6 Auto-enable --fail-on-regression when CI env var is set

## 10. Vitest Integration

- [ ] 10.1 Create `test/eval/accuracy.test.ts` as vitest entry point
- [ ] 10.2 Add test case per fixture that runs evaluation and asserts minimum thresholds
- [ ] 10.3 Add aggregate test that runs all fixtures and reports combined metrics
- [ ] 10.4 Ensure eval tests are excluded from regular `npm test` runs

## 11. Documentation and Cleanup

- [ ] 11.1 Add README section explaining accuracy evaluation and how to run it
- [ ] 11.2 Document ground truth JSON format and how to create new fixtures
- [ ] 11.3 Add example commands: `npm run eval`, `npm run eval -- --save`, `npm run eval -- --compare`
- [ ] 11.4 Run full evaluation and verify all fixtures pass with reasonable accuracy
