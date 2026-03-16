## 1. Schema and Database

- [x] 1.1 Create `memory_entities` table with columns: id, name, type, description, project_hash, first_learned_at, last_confirmed_at, contradicted_at, contradicted_by_memory_id
- [x] 1.2 Create `memory_edges` table with columns: id, source_id, target_id, edge_type, project_hash, created_at
- [x] 1.3 Add indexes on memory_entities (name, type, project_hash) and memory_edges (source_id, target_id, edge_type)
- [x] 1.4 Add UNIQUE constraint on memory_entities (LOWER(name), type, project_hash) for deduplication
- [x] 1.5 Create migration logic for existing databases (add tables if not exist)

## 2. Entity Extraction

- [x] 2.1 Define TypeScript interfaces for MemoryEntity and MemoryEdge in types.ts
- [x] 2.2 Create entity extraction prompt template with entity types (tool, service, person, concept, decision, file, library) and relationship types (uses, depends_on, decided_by, related_to, replaces, configured_with)
- [x] 2.3 Implement extractEntitiesFromMemory() function using Phase 2 LLM infrastructure
- [x] 2.4 Add JSON schema validation for LLM extraction output
- [x] 2.5 Integrate entity extraction into memory_write flow (when consolidation enabled)

## 3. Entity Storage and Deduplication

- [x] 3.1 Implement insertOrUpdateEntity() with case-insensitive deduplication
- [x] 3.2 Implement insertEdge() for relationship storage
- [x] 3.3 Add first_learned_at/last_confirmed_at timestamp management
- [x] 3.4 Create MemoryGraph class following SymbolGraph pattern
- [x] 3.5 Add getEntityByName() with optional type filter

## 4. Graph Traversal

- [x] 4.1 Implement BFS traversal in MemoryGraph.traverse() with configurable depth limit
- [x] 4.2 Add relationship type filtering to traversal
- [x] 4.3 Implement getEntityEdges() for incoming/outgoing relationships
- [x] 4.4 Add depth limit enforcement (max 10, default 3)
- [x] 4.5 Return results ordered by distance from starting entity

## 5. memory_graph_query MCP Tool

- [x] 5.1 Define tool schema with parameters: entity (required), maxDepth (optional), relationshipTypes (optional)
- [x] 5.2 Implement tool handler in server.ts
- [x] 5.3 Add entity-not-found error handling with similar entity suggestions
- [x] 5.4 Add parameter validation (maxDepth range 1-10)
- [x] 5.5 Format response with entity details, connected entities, and edges

## 6. Proactive Surfacing Pipeline

- [x] 6.1 Add proactive config section: enabled (boolean), maxSuggestions (number, default 3)
- [x] 6.2 Implement findRelatedMemories() using vector similarity search
- [x] 6.3 Integrate proactive surfacing into memory_write response
- [x] 6.4 Integrate proactive surfacing into code_detect_changes response
- [x] 6.5 Add deduplication for suggestions across multiple changed files

## 7. memory_related MCP Tool

- [x] 7.1 Define tool schema with parameters: topic (required), collection (optional), limit (optional)
- [x] 7.2 Implement tool handler using vector search
- [x] 7.3 Add collection filtering support
- [x] 7.4 Enforce limit maximum of 10
- [x] 7.5 Return results ordered by relevance score

## 8. Temporal Metadata Tracking

- [x] 8.1 Update entity insertion to set first_learned_at and last_confirmed_at
- [x] 8.2 Update entity re-confirmation to only update last_confirmed_at
- [x] 8.3 Add contradicted_at and contradicted_by_memory_id fields
- [x] 8.4 Implement markEntityContradicted() function

## 9. Contradiction Detection

- [x] 9.1 Extend Phase 2 consolidation prompt to detect contradictions
- [x] 9.2 Add contradiction confidence scoring (0.0-1.0)
- [x] 9.3 Integrate contradiction detection into consolidation flow
- [x] 9.4 Store contradiction metadata on affected entities
- [x] 9.5 Add graceful degradation when Phase 2 consolidation is disabled

## 10. memory_timeline MCP Tool

- [x] 10.1 Define tool schema with parameters: topic (required), startDate (optional), endDate (optional)
- [x] 10.2 Implement getTopicTimeline() to fetch chronological memories
- [x] 10.3 Add change type indicators (new, updated, contradicted)
- [x] 10.4 Implement date range filtering
- [x] 10.5 Format timeline entries with timestamp, summary, and change type

## 11. Testing

- [x] 11.1 Unit tests for entity extraction prompt and parsing
- [x] 11.2 Unit tests for entity deduplication logic
- [x] 11.3 Unit tests for BFS graph traversal
- [x] 11.4 Unit tests for proactive surfacing
- [x] 11.5 Unit tests for temporal metadata tracking
- [x] 11.6 Unit tests for contradiction detection
- [x] 11.7 Integration tests for memory_graph_query tool
- [x] 11.8 Integration tests for memory_related tool
- [x] 11.9 Integration tests for memory_timeline tool
- [x] 11.10 Performance test for proactive surfacing latency (< 100ms)

## 12. Documentation and Config

- [x] 12.1 Update config.yml schema with proactive section
- [x] 12.2 Add entity extraction settings under llm section
- [x] 12.3 Update AGENTS.md with new MCP tools documentation
- [x] 12.4 Add Phase 3 prerequisites note (requires Phase 1 and Phase 2)
