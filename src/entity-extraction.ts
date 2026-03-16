import type { LLMProvider } from './consolidation.js';
import { log } from './logger.js';

export type EntityType = 'tool' | 'service' | 'person' | 'concept' | 'decision' | 'file' | 'library';
export type EdgeType = 'uses' | 'depends_on' | 'decided_by' | 'related_to' | 'replaces' | 'configured_with';

const VALID_ENTITY_TYPES: Set<EntityType> = new Set(['tool', 'service', 'person', 'concept', 'decision', 'file', 'library']);
const VALID_EDGE_TYPES: Set<EdgeType> = new Set(['uses', 'depends_on', 'decided_by', 'related_to', 'replaces', 'configured_with']);

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description?: string;
}

export interface ExtractedRelationship {
  sourceName: string;
  targetName: string;
  edgeType: EdgeType;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export function buildEntityExtractionPrompt(content: string): string {
  return `You are an entity extraction agent. Analyze the following memory content and extract entities and relationships.

Extract:
1. **Entities**: Named things mentioned (tools, services, people, concepts, decisions, files, libraries)
2. **Relationships**: How entities relate to each other

Entity types: tool, service, person, concept, decision, file, library
Relationship types: uses, depends_on, decided_by, related_to, replaces, configured_with

Memory content:
${content.substring(0, 2000)}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "entities": [
    { "name": "EntityName", "type": "tool|service|person|concept|decision|file|library", "description": "brief description" }
  ],
  "relationships": [
    { "sourceName": "Entity1", "targetName": "Entity2", "edgeType": "uses|depends_on|decided_by|related_to|replaces|configured_with" }
  ]
}

If no entities found, return: { "entities": [], "relationships": [] }`;
}

export function parseEntityExtractionResponse(responseText: string): ExtractionResult {
  const emptyResult: ExtractionResult = { entities: [], relationships: [] };
  
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log('entity-extraction', 'No JSON found in response');
      return emptyResult;
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    const entities: ExtractedEntity[] = [];
    if (Array.isArray(parsed.entities)) {
      for (const e of parsed.entities) {
        if (typeof e.name !== 'string' || !e.name.trim()) continue;
        const entityType = String(e.type).toLowerCase() as EntityType;
        if (!VALID_ENTITY_TYPES.has(entityType)) continue;
        
        entities.push({
          name: e.name.trim(),
          type: entityType,
          description: typeof e.description === 'string' ? e.description.trim() : undefined,
        });
      }
    }
    
    const relationships: ExtractedRelationship[] = [];
    if (Array.isArray(parsed.relationships)) {
      for (const r of parsed.relationships) {
        if (typeof r.sourceName !== 'string' || !r.sourceName.trim()) continue;
        if (typeof r.targetName !== 'string' || !r.targetName.trim()) continue;
        const edgeType = String(r.edgeType).toLowerCase() as EdgeType;
        if (!VALID_EDGE_TYPES.has(edgeType)) continue;
        
        relationships.push({
          sourceName: r.sourceName.trim(),
          targetName: r.targetName.trim(),
          edgeType,
        });
      }
    }
    
    return { entities, relationships };
  } catch (err) {
    log('entity-extraction', 'Failed to parse response: ' + (err instanceof Error ? err.message : String(err)));
    return emptyResult;
  }
}

export async function extractEntitiesFromMemory(
  content: string,
  llmProvider: LLMProvider
): Promise<ExtractionResult> {
  const emptyResult: ExtractionResult = { entities: [], relationships: [] };
  
  if (!content.trim()) {
    return emptyResult;
  }
  
  try {
    const prompt = buildEntityExtractionPrompt(content);
    const response = await llmProvider.complete(prompt);
    
    log('entity-extraction', 'LLM response received, tokens=' + response.tokensUsed);
    
    return parseEntityExtractionResponse(response.text);
  } catch (err) {
    log('entity-extraction', 'Extraction failed: ' + (err instanceof Error ? err.message : String(err)));
    return emptyResult;
  }
}
