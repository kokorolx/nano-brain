import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  detectEntryPoints,
  traceFlows,
  storeFlows,
  detectAndStoreFlows,
  type DetectedFlow,
} from '../src/flow-detection.js'

describe('Flow Detection', () => {
  let db: Database.Database
  const projectHash = 'flowtest1234'

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        cluster_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path, project_hash);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name, kind);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project_hash);

      CREATE TABLE IF NOT EXISTS symbol_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        project_hash TEXT NOT NULL DEFAULT 'global',
        FOREIGN KEY (source_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_source ON symbol_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_target ON symbol_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_type ON symbol_edges(edge_type);

      CREATE TABLE IF NOT EXISTS execution_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        flow_type TEXT NOT NULL,
        entry_symbol_id INTEGER NOT NULL,
        terminal_symbol_id INTEGER NOT NULL,
        step_count INTEGER NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        FOREIGN KEY (entry_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (terminal_symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_execution_flows_project ON execution_flows(project_hash);

      CREATE TABLE IF NOT EXISTS flow_steps (
        flow_id INTEGER NOT NULL,
        symbol_id INTEGER NOT NULL,
        step_index INTEGER NOT NULL,
        PRIMARY KEY (flow_id, step_index),
        FOREIGN KEY (flow_id) REFERENCES execution_flows(id) ON DELETE CASCADE,
        FOREIGN KEY (symbol_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_flow_steps_symbol ON flow_steps(symbol_id);
    `)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM flow_steps')
    db.exec('DELETE FROM execution_flows')
    db.exec('DELETE FROM symbol_edges')
    db.exec('DELETE FROM code_symbols')
  })

  function insertSymbol(
    name: string,
    kind: string,
    filePath: string,
    exported: boolean,
    clusterId: number | null = null
  ): number {
    const stmt = db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, content_hash, project_hash, cluster_id)
      VALUES (?, ?, ?, 1, 10, ?, 'hash123', ?, ?)
    `)
    const result = stmt.run(name, kind, filePath, exported ? 1 : 0, projectHash, clusterId)
    return Number(result.lastInsertRowid)
  }

  function insertEdge(sourceId: number, targetId: number, edgeType: string = 'CALLS', confidence: number = 1.0): void {
    const stmt = db.prepare(`
      INSERT INTO symbol_edges (source_id, target_id, edge_type, confidence, project_hash)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(sourceId, targetId, edgeType, confidence, projectHash)
  }

  describe('detectEntryPoints', () => {
    it('should find exported functions with no incoming CALLS edges', () => {
      const funcA = insertSymbol('handleRequest', 'function', '/src/handler.ts', true)
      const funcB = insertSymbol('processData', 'function', '/src/processor.ts', true)
      const funcC = insertSymbol('helperFunc', 'function', '/src/helper.ts', true)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      const entryPoints = detectEntryPoints(db, projectHash)

      expect(entryPoints).toHaveLength(1)
      expect(entryPoints[0].id).toBe(funcA)
      expect(entryPoints[0].name).toBe('handleRequest')
    })

    it('should exclude non-exported functions', () => {
      const exportedFunc = insertSymbol('publicFunc', 'function', '/src/public.ts', true)
      const privateFunc = insertSymbol('privateFunc', 'function', '/src/private.ts', false)

      const entryPoints = detectEntryPoints(db, projectHash)

      expect(entryPoints).toHaveLength(1)
      expect(entryPoints[0].id).toBe(exportedFunc)
    })

    it('should exclude classes and interfaces', () => {
      insertSymbol('MyClass', 'class', '/src/class.ts', true)
      insertSymbol('MyInterface', 'interface', '/src/interface.ts', true)
      const funcEntry = insertSymbol('entryFunc', 'function', '/src/entry.ts', true)

      const entryPoints = detectEntryPoints(db, projectHash)

      expect(entryPoints).toHaveLength(1)
      expect(entryPoints[0].id).toBe(funcEntry)
    })

    it('should include methods as entry points', () => {
      const method = insertSymbol('handleEvent', 'method', '/src/handler.ts', true)

      const entryPoints = detectEntryPoints(db, projectHash)

      expect(entryPoints).toHaveLength(1)
      expect(entryPoints[0].id).toBe(method)
      expect(entryPoints[0].kind).toBe('method')
    })
  })

  describe('traceFlows', () => {
    it('should trace a simple call chain A -> B -> C -> D', () => {
      const funcA = insertSymbol('handleLogin', 'function', '/src/auth.ts', true)
      const funcB = insertSymbol('validateUser', 'function', '/src/auth.ts', false)
      const funcC = insertSymbol('checkPassword', 'function', '/src/auth.ts', false)
      const funcD = insertSymbol('createSession', 'function', '/src/session.ts', false)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)
      insertEdge(funcC, funcD)

      const entryPoints = [{ id: funcA, name: 'handleLogin', kind: 'function', filePath: '/src/auth.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash)

      expect(flows).toHaveLength(1)
      expect(flows[0].steps).toEqual([funcA, funcB, funcC, funcD])
      expect(flows[0].entrySymbolId).toBe(funcA)
      expect(flows[0].terminalSymbolId).toBe(funcD)
      expect(flows[0].label).toBe('HandleLogin -> CreateSession')
    })

    it('should exclude flows with fewer than minSteps', () => {
      const funcE = insertSymbol('shortEntry', 'function', '/src/short.ts', true)
      const funcF = insertSymbol('shortEnd', 'function', '/src/short.ts', false)

      insertEdge(funcE, funcF)

      const entryPoints = [{ id: funcE, name: 'shortEntry', kind: 'function', filePath: '/src/short.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(0)
    })

    it('should respect maxTraceDepth limit', () => {
      const symbols: number[] = []
      for (let i = 0; i < 15; i++) {
        symbols.push(insertSymbol(`func${i}`, 'function', `/src/file${i}.ts`, i === 0))
      }

      for (let i = 0; i < 14; i++) {
        insertEdge(symbols[i], symbols[i + 1])
      }

      const entryPoints = [{ id: symbols[0], name: 'func0', kind: 'function', filePath: '/src/file0.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { maxTraceDepth: 5, minSteps: 3 })

      expect(flows).toHaveLength(1)
      expect(flows[0].steps.length).toBeLessThanOrEqual(6)
    })

    it('should handle branching paths', () => {
      const entry = insertSymbol('entryPoint', 'function', '/src/entry.ts', true)
      const branch1 = insertSymbol('branch1', 'function', '/src/b1.ts', false)
      const branch2 = insertSymbol('branch2', 'function', '/src/b2.ts', false)
      const end1 = insertSymbol('end1', 'function', '/src/e1.ts', false)
      const end2 = insertSymbol('end2', 'function', '/src/e2.ts', false)

      insertEdge(entry, branch1)
      insertEdge(entry, branch2)
      insertEdge(branch1, end1)
      insertEdge(branch2, end2)

      const entryPoints = [{ id: entry, name: 'entryPoint', kind: 'function', filePath: '/src/entry.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(2)
    })

    it('should handle cycles without infinite loops', () => {
      const funcA = insertSymbol('cycleA', 'function', '/src/cycle.ts', true)
      const funcB = insertSymbol('cycleB', 'function', '/src/cycle.ts', false)
      const funcC = insertSymbol('cycleC', 'function', '/src/cycle.ts', false)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)
      insertEdge(funcC, funcA)

      const entryPoints = [{ id: funcA, name: 'cycleA', kind: 'function', filePath: '/src/cycle.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows.length).toBeGreaterThanOrEqual(1)
      for (const flow of flows) {
        const uniqueSteps = new Set(flow.steps)
        expect(uniqueSteps.size).toBe(flow.steps.length)
      }
    })
  })

  describe('flow classification', () => {
    it('should classify as intra_community when all steps have same cluster_id', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true, 1)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', false, 1)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', false, 1)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      const entryPoints = [{ id: funcA, name: 'funcA', kind: 'function', filePath: '/src/a.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(1)
      expect(flows[0].flowType).toBe('intra_community')
    })

    it('should classify as cross_community when steps span multiple clusters', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true, 1)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', false, 1)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', false, 2)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      const entryPoints = [{ id: funcA, name: 'funcA', kind: 'function', filePath: '/src/a.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(1)
      expect(flows[0].flowType).toBe('cross_community')
    })

    it('should classify as cross_community when any step has null cluster_id', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true, 1)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', false, null)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', false, 1)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      const entryPoints = [{ id: funcA, name: 'funcA', kind: 'function', filePath: '/src/a.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(1)
      expect(flows[0].flowType).toBe('cross_community')
    })
  })

  describe('storeFlows', () => {
    it('should store flows in execution_flows and flow_steps tables', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', false)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', false)

      const flows: DetectedFlow[] = [
        {
          label: 'FuncA -> FuncC',
          flowType: 'cross_community',
          entrySymbolId: funcA,
          terminalSymbolId: funcC,
          steps: [funcA, funcB, funcC],
        },
      ]

      const result = storeFlows(db, flows, projectHash)

      expect(result.flowsStored).toBe(1)

      const storedFlows = db.prepare('SELECT * FROM execution_flows WHERE project_hash = ?').all(projectHash) as Array<{
        id: number
        label: string
        flow_type: string
        entry_symbol_id: number
        terminal_symbol_id: number
        step_count: number
      }>
      expect(storedFlows).toHaveLength(1)
      expect(storedFlows[0].label).toBe('FuncA -> FuncC')
      expect(storedFlows[0].flow_type).toBe('cross_community')
      expect(storedFlows[0].step_count).toBe(3)

      const storedSteps = db.prepare('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY step_index').all(
        storedFlows[0].id
      ) as Array<{ flow_id: number; symbol_id: number; step_index: number }>
      expect(storedSteps).toHaveLength(3)
      expect(storedSteps[0].symbol_id).toBe(funcA)
      expect(storedSteps[0].step_index).toBe(1)
      expect(storedSteps[1].symbol_id).toBe(funcB)
      expect(storedSteps[1].step_index).toBe(2)
      expect(storedSteps[2].symbol_id).toBe(funcC)
      expect(storedSteps[2].step_index).toBe(3)
    })

    it('should clear existing flows before storing new ones', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', false)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', false)

      const flows1: DetectedFlow[] = [
        {
          label: 'Flow1',
          flowType: 'intra_community',
          entrySymbolId: funcA,
          terminalSymbolId: funcB,
          steps: [funcA, funcB, funcC],
        },
      ]

      storeFlows(db, flows1, projectHash)

      const flows2: DetectedFlow[] = [
        {
          label: 'Flow2',
          flowType: 'cross_community',
          entrySymbolId: funcA,
          terminalSymbolId: funcC,
          steps: [funcA, funcC],
        },
      ]

      storeFlows(db, flows2, projectHash)

      const storedFlows = db.prepare('SELECT * FROM execution_flows WHERE project_hash = ?').all(projectHash) as Array<{
        label: string
      }>
      expect(storedFlows).toHaveLength(1)
      expect(storedFlows[0].label).toBe('Flow2')
    })
  })

  describe('detectAndStoreFlows', () => {
    it('should detect and store flows end-to-end', () => {
      const funcA = insertSymbol('handleLogin', 'function', '/src/auth.ts', true)
      const funcB = insertSymbol('validateUser', 'function', '/src/auth.ts', false)
      const funcC = insertSymbol('checkPassword', 'function', '/src/auth.ts', false)
      const funcD = insertSymbol('createSession', 'function', '/src/session.ts', false)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)
      insertEdge(funcC, funcD)

      const result = detectAndStoreFlows(db, projectHash)

      expect(result.entryPointsFound).toBe(1)
      expect(result.flowsDetected).toBe(1)

      const storedFlows = db.prepare('SELECT * FROM execution_flows WHERE project_hash = ?').all(projectHash) as Array<{
        label: string
      }>
      expect(storedFlows).toHaveLength(1)
      expect(storedFlows[0].label).toBe('HandleLogin -> CreateSession')
    })

    it('should handle multiple entry points', () => {
      const entry1 = insertSymbol('handleGet', 'function', '/src/routes.ts', true)
      const entry2 = insertSymbol('handlePost', 'function', '/src/routes.ts', true)
      const shared = insertSymbol('processRequest', 'function', '/src/processor.ts', false)
      const end = insertSymbol('sendResponse', 'function', '/src/response.ts', false)

      insertEdge(entry1, shared)
      insertEdge(entry2, shared)
      insertEdge(shared, end)

      const result = detectAndStoreFlows(db, projectHash, { minSteps: 3 })

      expect(result.entryPointsFound).toBe(2)
      expect(result.flowsDetected).toBe(2)
    })

    it('should exclude short chains below minSteps', () => {
      const longEntry = insertSymbol('longEntry', 'function', '/src/long.ts', true)
      const longMid1 = insertSymbol('longMid1', 'function', '/src/long.ts', false)
      const longMid2 = insertSymbol('longMid2', 'function', '/src/long.ts', false)
      const longEnd = insertSymbol('longEnd', 'function', '/src/long.ts', false)

      insertEdge(longEntry, longMid1)
      insertEdge(longMid1, longMid2)
      insertEdge(longMid2, longEnd)

      const shortEntry = insertSymbol('shortEntry', 'function', '/src/short.ts', true)
      const shortEnd = insertSymbol('shortEnd', 'function', '/src/short.ts', false)

      insertEdge(shortEntry, shortEnd)

      const result = detectAndStoreFlows(db, projectHash, { minSteps: 3 })

      expect(result.entryPointsFound).toBe(2)
      expect(result.flowsDetected).toBe(1)

      const storedFlows = db.prepare('SELECT * FROM execution_flows WHERE project_hash = ?').all(projectHash) as Array<{
        label: string
      }>
      expect(storedFlows).toHaveLength(1)
      expect(storedFlows[0].label).toBe('LongEntry -> LongEnd')
    })

    it('should respect maxProcesses limit', () => {
      for (let i = 0; i < 10; i++) {
        const entry = insertSymbol(`entry${i}`, 'function', `/src/entry${i}.ts`, true)
        const mid = insertSymbol(`mid${i}`, 'function', `/src/mid${i}.ts`, false)
        const end = insertSymbol(`end${i}`, 'function', `/src/end${i}.ts`, false)
        insertEdge(entry, mid)
        insertEdge(mid, end)
      }

      const result = detectAndStoreFlows(db, projectHash, { minSteps: 3, maxProcesses: 5 })

      expect(result.flowsDetected).toBeLessThanOrEqual(5)
    })
  })

  describe('flow labeling', () => {
    it('should generate PascalCase labels from symbol names', () => {
      const funcA = insertSymbol('handleUserLogin', 'function', '/src/auth.ts', true)
      const funcB = insertSymbol('validateCredentials', 'function', '/src/auth.ts', false)
      const funcC = insertSymbol('createUserSession', 'function', '/src/session.ts', false)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      const entryPoints = [{ id: funcA, name: 'handleUserLogin', kind: 'function', filePath: '/src/auth.ts' }]
      const flows = traceFlows(db, entryPoints, projectHash, { minSteps: 3 })

      expect(flows).toHaveLength(1)
      expect(flows[0].label).toBe('HandleUserLogin -> CreateUserSession')
    })
  })
})
