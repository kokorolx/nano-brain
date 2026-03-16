## ADDED Requirements

### Requirement: Query unconsolidated memories from store
`getUnconsolidatedMemories()` SHALL query the store for documents that have not yet been consolidated.

#### Scenario: Documents available for consolidation
- **WHEN** there are documents in the `memory` collection with `active = 1` and `superseded_by IS NULL` that are not referenced in any `consolidations.source_ids`
- **THEN** the method SHALL return them as `UnconsolidatedMemory[]` with `id`, `title`, `path`, `hash`, and `body` fields, ordered by `modified_at DESC`, limited to `maxMemoriesPerCycle`

#### Scenario: All documents already consolidated
- **WHEN** every active memory document ID appears in at least one `consolidations.source_ids` entry
- **THEN** the method SHALL return an empty array

#### Scenario: Mixed collections
- **WHEN** documents exist in `memory`, `codebase`, and `sessions` collections
- **THEN** the method SHALL only return documents from the `memory` collection

### Requirement: Persist consolidation results
`applyConsolidation()` SHALL insert consolidation results into the `consolidations` table.

#### Scenario: Successful consolidation
- **WHEN** a `ConsolidationResult` has `overallConfidence >= confidenceThreshold`
- **THEN** the method SHALL INSERT a row into `consolidations` with `source_ids` (JSON array), `summary`, `insight`, `connections` (JSON array), `confidence`, and `created_at`

#### Scenario: Token usage tracking
- **WHEN** a consolidation cycle completes (success or failure)
- **THEN** the system SHALL call `store.recordTokenUsage()` with the model name and tokens used

### Requirement: CLI consolidate command runs end-to-end
The `npx nano-brain consolidate` command SHALL create an LLM provider from config and run a full consolidation cycle.

#### Scenario: Consolidation enabled with valid config
- **WHEN** `consolidation.enabled = true` and `endpoint`, `model`, and `apiKey` are configured
- **THEN** the CLI SHALL create a provider, create a `ConsolidationAgent`, call `runConsolidationCycle()`, and print the number of consolidations created

#### Scenario: Consolidation disabled
- **WHEN** `consolidation.enabled = false` or not set
- **THEN** the CLI SHALL print "Consolidation is not enabled" and exit

#### Scenario: No API key configured
- **WHEN** `consolidation.enabled = true` but no `apiKey` in config or env var
- **THEN** the CLI SHALL print an error message about missing API key and exit

### Requirement: MCP memory_consolidate tool runs on demand
The MCP `memory_consolidate` tool SHALL trigger a consolidation cycle when called.

#### Scenario: Consolidation configured
- **WHEN** the tool is called and consolidation config is valid
- **THEN** it SHALL run a consolidation cycle and return the number of consolidations created and total tokens used

#### Scenario: Consolidation not configured
- **WHEN** the tool is called but consolidation is not enabled or has no API key
- **THEN** it SHALL return an informative error message

### Requirement: Failed batches are recorded
When a consolidation cycle fails mid-batch, the system SHALL record the failed document IDs for visibility.

#### Scenario: LLM call fails
- **WHEN** the LLM provider throws an error during `runConsolidationCycle()`
- **THEN** the system SHALL log the error, call `recordFailedBatch()` with the batch document IDs, and return an empty results array without crashing
