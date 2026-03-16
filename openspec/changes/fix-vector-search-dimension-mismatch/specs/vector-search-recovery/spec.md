## ADDED Requirements

### Requirement: Error Logging on Vector Search Failure

Vector search errors MUST be logged instead of silently swallowed. The bare `catch {}` blocks in search.ts and store.ts MUST log the error and continue with FTS-only results.

#### Scenario: Vector search fails gracefully with logging

WHEN vector search fails due to dimension mismatch or any other error
THEN the error message is logged with `log('search', 'vector search failed: ' + err.message)`
AND the search continues with FTS-only results

### Requirement: Startup Dimension Validation

The MCP server MUST detect dimension mismatches between the qdrant collection and the embedding provider at startup. On mismatch, vector search MUST be disabled with a clear warning — the server MUST NOT crash.

#### Scenario: Dimension mismatch detected at startup

WHEN the MCP server starts
AND the qdrant collection exists with dimensions different from the embedding provider
THEN a warning is logged with the mismatch details
AND vector search is disabled
AND FTS search continues to work normally

#### Scenario: Dimensions match at startup

WHEN the MCP server starts
AND qdrant collection dimensions match the embedding provider
THEN vector search is enabled normally

#### Scenario: No qdrant collection exists at startup

WHEN the MCP server starts
AND no qdrant collection exists yet
THEN a new collection is created with dimensions from the embedding provider

### Requirement: Recreate Vectors CLI Command

The system MUST provide a CLI command `npx nano-brain recreate-vectors` that safely resets the qdrant collection with correct dimensions and clears stale tracking data. The command MUST require confirmation unless `--force` is passed.

#### Scenario: Recreate vectors with confirmation

WHEN user runs `npx nano-brain recreate-vectors`
THEN the command prompts for confirmation
AND deletes the existing qdrant collection
AND creates a new collection with correct dimensions
AND clears content_vectors and llm_cache tables
AND prints next steps to run embed command

#### Scenario: Recreate vectors with force flag

WHEN user runs `npx nano-brain recreate-vectors --force`
THEN the command skips the confirmation prompt and proceeds

#### Scenario: Recreate vectors when qdrant unreachable

WHEN user runs `npx nano-brain recreate-vectors`
AND qdrant is not reachable
THEN the command fails with a clear error message

### Requirement: Auto-Detect Dimensions from Embedding Provider

The vector store dimensions MUST be auto-detected from the active embedding provider instead of using the hardcoded 1024 default. The system SHALL fall back to config or 1024 only when no embedder is available.

#### Scenario: Dimensions from embedding provider

WHEN the vector store is initialized
AND an embedding provider is available
THEN the vector store uses the embedding provider dimensions instead of hardcoded 1024

#### Scenario: Dimensions fallback without embedding provider

WHEN the vector store is initialized
AND no embedding provider is available
THEN the vector store uses configured dimensions or 1024 as last resort

### Requirement: Re-embedding Produces Correct Metadata

After recreating the qdrant collection, re-embedding MUST produce vectors with full workspace metadata (projectHash, collection) in qdrant payloads so that workspace filtering works correctly.

#### Scenario: Full re-embed with workspace metadata

WHEN user runs `npx nano-brain embed` after recreate-vectors
THEN new vectors include projectHash and collection in qdrant payloads
AND the embed command is resumable via content_vectors tracking
AND rate limiting is respected
