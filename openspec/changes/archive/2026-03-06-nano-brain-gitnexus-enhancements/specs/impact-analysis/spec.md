## ADDED Requirements

### Requirement: Impact analysis computes blast radius for a symbol
The system SHALL provide an `impact` MCP tool that, given a symbol name and direction (upstream/downstream), returns all affected symbols grouped by traversal depth with confidence scores.

#### Scenario: Upstream impact of a function
- **WHEN** the user calls `impact` with target "validateUser" and direction "upstream"
- **THEN** the system returns all symbols that directly or transitively depend on validateUser, grouped by depth (depth 1 = direct callers, depth 2 = callers of callers, etc.), each with edge type and confidence

#### Scenario: Downstream impact of a class
- **WHEN** the user calls `impact` with target "AuthService" and direction "downstream"
- **THEN** the system returns all symbols that AuthService depends on (callees, imports, extended classes), grouped by depth

#### Scenario: Impact with max depth limit
- **WHEN** the user calls `impact` with maxDepth=2
- **THEN** the system only traverses up to 2 hops from the target symbol

#### Scenario: Impact with minimum confidence filter
- **WHEN** the user calls `impact` with minConfidence=0.8
- **THEN** the system only includes edges with confidence >= 0.8 in the traversal

### Requirement: Impact analysis returns risk assessment
The system SHALL include a risk level (LOW, MEDIUM, HIGH, CRITICAL) in impact results based on the number of affected symbols and their depth.

#### Scenario: Low risk change
- **WHEN** a symbol has 0-2 direct dependents and no affected flows
- **THEN** the risk level is LOW

#### Scenario: Critical risk change
- **WHEN** a symbol has 10+ direct dependents or affects 3+ execution flows
- **THEN** the risk level is CRITICAL

### Requirement: Impact analysis includes affected execution flows
The system SHALL include which execution flows (processes) are affected by a change to the target symbol.

#### Scenario: Symbol participates in multiple flows
- **WHEN** the target symbol participates in 2 execution flows (e.g., LoginFlow step 3, RegistrationFlow step 5)
- **THEN** the impact result lists both flows with the step position where the target appears
