## ADDED Requirements

### Requirement: Track category access frequency
The system SHALL track expand_rate per category from existing telemetry data (query logs with expand actions).

#### Scenario: Expand action tracked
- **WHEN** user expands a search result
- **AND** result has category tags
- **THEN** expand count for those categories is incremented

### Requirement: Compute category weights from expand rate
The system SHALL compute category weights as expand_rate / baseline_expand_rate, clamped to preferences.weight_min (0.5) and preferences.weight_max (2.0).

#### Scenario: High expand rate category
- **WHEN** category has 20% expand rate
- **AND** baseline is 10%
- **THEN** weight is 2.0 (20/10 = 2.0, within bounds)

#### Scenario: Low expand rate category
- **WHEN** category has 2% expand rate
- **AND** baseline is 10%
- **THEN** weight is 0.5 (2/10 = 0.2, clamped to min 0.5)

#### Scenario: Weight clamping at maximum
- **WHEN** category has 50% expand rate
- **AND** baseline is 10%
- **THEN** weight is 2.0 (50/10 = 5.0, clamped to max 2.0)

### Requirement: Store weights in workspace_profiles
The system SHALL store categoryWeights as JSON field in existing workspace_profiles table.

#### Scenario: Weights persisted
- **WHEN** preference learning cycle completes
- **THEN** categoryWeights JSON is updated in workspace_profiles for that workspace

### Requirement: Apply weights in hybrid search scoring
The system SHALL multiply search scores by category weight after usage boost and before supersede demotion.

#### Scenario: Boosted category result
- **WHEN** search result has category with weight 1.5
- **AND** base score is 0.8
- **THEN** score becomes 1.2 (0.8 * 1.5)

#### Scenario: Demoted category result
- **WHEN** search result has category with weight 0.6
- **AND** base score is 0.8
- **THEN** score becomes 0.48 (0.8 * 0.6)

### Requirement: Update weights in watcher learning cycle
The system SHALL update preference weights during existing watcher.ts learning cycle (every 10 minutes).

#### Scenario: Weights updated periodically
- **WHEN** watcher learning cycle runs
- **AND** preferences.enabled = true
- **THEN** category weights are recomputed from recent telemetry

### Requirement: Cold start threshold
The system SHALL use neutral weights (1.0) for all categories until preferences.min_queries (default 20) queries are accumulated.

#### Scenario: Below cold start threshold
- **WHEN** workspace has 15 queries
- **AND** min_queries is 20
- **THEN** all category weights are 1.0

#### Scenario: Above cold start threshold
- **WHEN** workspace has 25 queries
- **AND** min_queries is 20
- **THEN** category weights are computed from telemetry

### Requirement: Per-workspace isolation
The system SHALL compute and apply preference weights per workspace, matching existing workspace isolation pattern.

#### Scenario: Workspace A preferences
- **WHEN** search runs in workspace A
- **THEN** workspace A's categoryWeights are applied

#### Scenario: Workspace B preferences
- **WHEN** search runs in workspace B
- **THEN** workspace B's categoryWeights are applied (independent of A)

### Requirement: Preference configuration
The system SHALL support preferences configuration with defaults:
- enabled: true
- min_queries: 20
- weight_min: 0.5
- weight_max: 2.0
- baseline_expand_rate: 0.1

#### Scenario: Default configuration applied
- **WHEN** no preferences config is provided
- **THEN** system uses default values for all preference settings
