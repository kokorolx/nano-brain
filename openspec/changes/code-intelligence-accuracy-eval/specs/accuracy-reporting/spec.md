## ADDED Requirements

### Requirement: Human-readable accuracy report

The harness SHALL output a human-readable accuracy report to stdout.

#### Scenario: Report format
- **WHEN** evaluation completes
- **THEN** a formatted report MUST be printed showing per-fixture and aggregate metrics
- **THEN** the report MUST include precision, recall, and F1 for each dimension (symbols, edges, flows)
- **THEN** the report MUST include confidence calibration summary

#### Scenario: Report example format
- **WHEN** the report is printed
- **THEN** it MUST follow this structure:
```
Code Intelligence Accuracy Report
═══════════════════════════════════════════════════

Fixture: ts-simple
  Symbols:  P=0.95  R=0.90  F1=0.92  (19/20 TP, 1 FP, 2 FN)
  Edges:    P=0.88  R=0.85  F1=0.86  (7/8 TP, 1 FP, 1 FN)
  Flows:    P=1.00  R=0.50  F1=0.67  (1/1 TP, 0 FP, 1 FN)

Fixture: ts-complex
  ...

Aggregate (micro-averaged)
  Symbols:  P=0.93  R=0.88  F1=0.90
  Edges:    P=0.85  R=0.82  F1=0.83
  Flows:    P=0.90  R=0.75  F1=0.82

Confidence Calibration
  0.80-0.85: expected=0.825, actual=0.80, error=0.025
  0.85-0.90: expected=0.875, actual=0.88, error=0.005
  ...
  Mean calibration error: 0.015
```

### Requirement: JSON accuracy report

The harness SHALL output a JSON accuracy report when --json flag is provided.

#### Scenario: JSON output flag
- **WHEN** `npm run eval -- --json` is executed
- **THEN** output MUST be valid JSON instead of human-readable format

#### Scenario: JSON report structure
- **WHEN** JSON output is generated
- **THEN** it MUST include `fixtures` array with per-fixture metrics
- **THEN** it MUST include `aggregate` object with micro-averaged metrics
- **THEN** it MUST include `calibration` object with per-bucket and mean error
- **THEN** it MUST include `timestamp` ISO string

### Requirement: Baseline saving

The harness SHALL save evaluation results as baselines for regression tracking.

#### Scenario: Save baseline
- **WHEN** `npm run eval -- --save` is executed
- **THEN** results MUST be saved to `~/.nano-brain/eval-baselines/<timestamp>.json`
- **THEN** the saved file MUST contain the full JSON report structure

#### Scenario: Baseline directory creation
- **WHEN** saving a baseline and the directory does not exist
- **THEN** the `~/.nano-brain/eval-baselines/` directory MUST be created

### Requirement: Baseline comparison

The harness SHALL compare current results against the latest baseline.

#### Scenario: Compare with baseline
- **WHEN** `npm run eval -- --compare` is executed
- **THEN** the latest baseline from `~/.nano-brain/eval-baselines/` MUST be loaded
- **THEN** a comparison report MUST be printed showing delta for each metric

#### Scenario: Comparison report format
- **WHEN** comparison is printed
- **THEN** it MUST show baseline value, current value, and delta for each metric
- **THEN** it MUST indicate direction: ↑ improved, ↓ regressed, ≈ same (within 0.01)

#### Scenario: No baseline available
- **WHEN** --compare is used but no baseline exists
- **THEN** a warning MUST be printed: "No baseline found — run with --save first"

### Requirement: Regression detection

The harness SHALL detect significant accuracy regressions.

#### Scenario: Regression threshold
- **WHEN** comparing against baseline
- **THEN** a regression MUST be flagged if any F1 score drops by more than 0.05

#### Scenario: Regression exit code
- **WHEN** a regression is detected and --fail-on-regression flag is provided
- **THEN** the process MUST exit with code 1

#### Scenario: CI integration
- **WHEN** running in CI (CI environment variable is set)
- **THEN** --fail-on-regression MUST be enabled by default
