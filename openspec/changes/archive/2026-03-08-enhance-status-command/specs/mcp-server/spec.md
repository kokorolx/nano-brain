## MODIFIED Requirements

### Requirement: memory_status reports storage usage
The `memory_status` MCP tool SHALL return vector store health, token usage metrics, and per-workspace storage info in addition to the existing index health, collection info, and model status.

#### Scenario: Status with Qdrant vector store
- **WHEN** `memory_status` is called and Qdrant is the active vector provider
- **THEN** the response SHALL include a "Vector Store" section with provider, connectivity status, vector count, and dimensions

#### Scenario: Status with token usage data
- **WHEN** `memory_status` is called and token_usage table has data
- **THEN** the response SHALL include a "Token Usage" section with per-model token counts and request counts

#### Scenario: Status with no vector store or token data
- **WHEN** `memory_status` is called with sqlite-vec (default) and no token usage recorded
- **THEN** the response SHALL include vector store section showing sqlite-vec as built-in, and omit the token usage section
