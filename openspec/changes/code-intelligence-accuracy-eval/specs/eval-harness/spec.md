## ADDED Requirements

### Requirement: Evaluation harness runner

The evaluation harness SHALL run the full indexing pipeline on golden fixtures and compare output against ground truth.

#### Scenario: Running evaluation on a fixture
- **WHEN** `npm run eval` or `vitest run test/eval/` is executed
- **THEN** each golden fixture MUST be loaded and indexed in a temporary database
- **THEN** the full pipeline MUST run: parse → extract symbols → resolve edges → detect flows
- **THEN** output MUST be compared against ground truth

#### Scenario: Isolated fixture evaluation
- **WHEN** evaluating a fixture
- **THEN** a fresh temporary database MUST be created for each fixture
- **THEN** the database MUST be cleaned up after evaluation completes

### Requirement: Symbol accuracy measurement

The harness SHALL calculate precision, recall, and F1 for symbol extraction.

#### Scenario: Symbol true positive
- **WHEN** a symbol in pipeline output matches a ground truth symbol (name, kind, file, line ±2)
- **THEN** it MUST be counted as a true positive

#### Scenario: Symbol false positive
- **WHEN** a symbol in pipeline output has no matching ground truth symbol
- **THEN** it MUST be counted as a false positive

#### Scenario: Symbol false negative
- **WHEN** a ground truth symbol has no matching pipeline output symbol
- **THEN** it MUST be counted as a false negative

#### Scenario: Symbol metrics calculation
- **WHEN** symbol comparison completes
- **THEN** precision MUST be calculated as TP / (TP + FP)
- **THEN** recall MUST be calculated as TP / (TP + FN)
- **THEN** F1 MUST be calculated as 2 * (precision * recall) / (precision + recall)

### Requirement: Edge accuracy measurement

The harness SHALL calculate precision, recall, and F1 for edge resolution.

#### Scenario: Edge true positive
- **WHEN** an edge in pipeline output matches a ground truth edge (source, target, type)
- **THEN** it MUST be counted as a true positive

#### Scenario: Edge false positive
- **WHEN** an edge in pipeline output has no matching ground truth edge
- **THEN** it MUST be counted as a false positive

#### Scenario: Edge false negative
- **WHEN** a ground truth edge has no matching pipeline output edge
- **THEN** it MUST be counted as a false negative

#### Scenario: Edge metrics calculation
- **WHEN** edge comparison completes
- **THEN** precision, recall, and F1 MUST be calculated using standard formulas

### Requirement: Flow accuracy measurement

The harness SHALL calculate precision, recall, and F1 for flow detection.

#### Scenario: Flow true positive
- **WHEN** a flow in pipeline output matches a ground truth flow (entry, terminal, ≥80% step match)
- **THEN** it MUST be counted as a true positive

#### Scenario: Flow step matching
- **WHEN** comparing flow steps
- **THEN** steps MUST be compared in order
- **THEN** a flow MUST match if at least 80% of expected steps appear in the correct order

#### Scenario: Flow metrics calculation
- **WHEN** flow comparison completes
- **THEN** precision, recall, and F1 MUST be calculated using standard formulas

### Requirement: Confidence calibration measurement

The harness SHALL measure whether confidence scores are well-calibrated.

#### Scenario: Confidence bucketing
- **WHEN** measuring confidence calibration
- **THEN** CALLS edges MUST be grouped into buckets: 0.8-0.85, 0.85-0.9, 0.9-0.95, 0.95-1.0

#### Scenario: Calibration accuracy per bucket
- **WHEN** a confidence bucket is analyzed
- **THEN** actual accuracy MUST be calculated as (correct edges in bucket) / (total edges in bucket)
- **THEN** calibration error MUST be calculated as |bucket midpoint - actual accuracy|

#### Scenario: Aggregate calibration score
- **WHEN** all buckets are analyzed
- **THEN** mean calibration error MUST be reported across all buckets with sufficient samples (≥3 edges)

### Requirement: Aggregate metrics across fixtures

The harness SHALL calculate aggregate metrics across all fixtures.

#### Scenario: Aggregate calculation
- **WHEN** all fixtures have been evaluated
- **THEN** aggregate precision, recall, and F1 MUST be calculated per dimension
- **THEN** aggregation MUST use micro-averaging (sum all TP/FP/FN across fixtures)
