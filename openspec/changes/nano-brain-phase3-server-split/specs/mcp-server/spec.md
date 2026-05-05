## MODIFIED Requirements

### Requirement: createMcpServer is located in src/mcp/index.ts
The `createMcpServer(deps)` function SHALL be defined in `src/mcp/index.ts` and re-exported via the `src/server.ts` barrel shim. All existing callers that `import { createMcpServer } from './server.js'` SHALL continue to work without modification.

#### Scenario: createMcpServer is importable from server.js barrel shim
- **WHEN** code does `import { createMcpServer } from './server.js'`
- **THEN** it SHALL resolve to the function defined in `src/mcp/index.ts` via the barrel shim
