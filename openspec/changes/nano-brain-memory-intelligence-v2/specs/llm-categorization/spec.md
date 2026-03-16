## ADDED Requirements

### Requirement: Async LLM categorization after memory write
The system SHALL invoke LLM categorization asynchronously (fire-and-forget) after keyword categorization completes in memory_write handler.

#### Scenario: LLM categorization triggered
- **WHEN** memory_write completes keyword categorization
- **AND** categorization.llm_enabled = true
- **THEN** async LLM call is fired without awaiting result

#### Scenario: LLM disabled
- **WHEN** memory_write completes
- **AND** categorization.llm_enabled = false
- **THEN** no LLM categorization is attempted

### Requirement: LLM returns categories with confidence scores
The system SHALL parse LLM response as JSON with categories array containing name and confidence (0.0-1.0) for each category.

#### Scenario: Valid LLM response
- **WHEN** LLM returns {"categories": [{"name": "debugging-insight", "confidence": 0.85}]}
- **THEN** system extracts category "debugging-insight" with confidence 0.85

#### Scenario: Invalid JSON response
- **WHEN** LLM returns malformed JSON
- **THEN** system logs error and keeps existing keyword tags

### Requirement: Confidence threshold filters low-confidence categories
The system SHALL reject categories with confidence below categorization.confidence_threshold (default 0.6).

#### Scenario: Category above threshold
- **WHEN** LLM returns category with confidence 0.75
- **AND** threshold is 0.6
- **THEN** category is accepted and tag is added

#### Scenario: Category below threshold
- **WHEN** LLM returns category with confidence 0.45
- **AND** threshold is 0.6
- **THEN** category is rejected and no tag is added

### Requirement: LLM tags use llm prefix
The system SHALL prefix LLM-assigned category tags with "llm:" to distinguish from keyword-based "auto:" tags.

#### Scenario: LLM tag format
- **WHEN** LLM assigns category "architecture-decision"
- **THEN** tag "llm:architecture-decision" is added to memory

### Requirement: Multiple categories accepted
The system SHALL add all above-threshold categories as separate llm: tags when LLM returns multiple categories.

#### Scenario: Multiple categories above threshold
- **WHEN** LLM returns [{"name": "debugging-insight", "confidence": 0.9}, {"name": "tool-config", "confidence": 0.7}]
- **AND** threshold is 0.6
- **THEN** both "llm:debugging-insight" and "llm:tool-config" tags are added

#### Scenario: Mixed confidence categories
- **WHEN** LLM returns [{"name": "debugging-insight", "confidence": 0.9}, {"name": "pattern", "confidence": 0.4}]
- **AND** threshold is 0.6
- **THEN** only "llm:debugging-insight" is added ("pattern" rejected at 0.4)

### Requirement: Fixed category set
The system SHALL only accept categories from the fixed set: architecture-decision, debugging-insight, tool-config, pattern, preference, context, workflow.

#### Scenario: Valid category accepted
- **WHEN** LLM returns category "debugging-insight"
- **THEN** category is accepted

#### Scenario: Unknown category rejected
- **WHEN** LLM returns category "random-category"
- **THEN** category is rejected and not added as tag

### Requirement: Content truncation for LLM
The system SHALL truncate memory content to categorization.max_content_length (default 2000) characters before sending to LLM.

#### Scenario: Long content truncated
- **WHEN** memory content is 5000 characters
- **AND** max_content_length is 2000
- **THEN** only first 2000 characters are sent to LLM

### Requirement: Reuse existing LLMProvider
The system SHALL use the LLMProvider configured in consolidation settings (same endpoint, model, apiKey).

#### Scenario: LLM provider from consolidation config
- **WHEN** LLM categorization runs
- **THEN** it uses consolidation.llm.endpoint, consolidation.llm.model, consolidation.llm.apiKey

#### Scenario: No LLM provider configured
- **WHEN** categorization.llm_enabled = true
- **AND** consolidation.llm is not configured
- **THEN** LLM categorization is skipped with warning log

### Requirement: Graceful failure handling
The system SHALL keep keyword tags and log error on LLM failure without retry.

#### Scenario: LLM timeout
- **WHEN** LLM call times out
- **THEN** error is logged and keyword tags remain unchanged

#### Scenario: LLM API error
- **WHEN** LLM returns 500 error
- **THEN** error is logged and keyword tags remain unchanged

### Requirement: Categorization configuration
The system SHALL support categorization configuration with defaults:
- llm_enabled: true (requires consolidation.llm config)
- confidence_threshold: 0.6
- max_content_length: 2000

#### Scenario: Default configuration applied
- **WHEN** no categorization config is provided
- **THEN** system uses default values for all categorization settings
