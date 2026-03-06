import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { SymbolGraph, validateFilePath } from '../src/symbol-graph.js'

describe('MCP Symbol Tools', () => {
  let db: Database.Database
  let graph: SymbolGraph
  const projectHash = 'mcptest12345'

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

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        pattern TEXT NOT NULL,
        operation TEXT NOT NULL,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        raw_expression TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global'
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path, project_hash);
    `)
    graph = new SymbolGraph(db)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM flow_steps')
    db.exec('DELETE FROM execution_flows')
    db.exec('DELETE FROM symbol_edges')
    db.exec('DELETE FROM code_symbols')
    db.exec('DELETE FROM symbols')
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

  function insertFlow(label: string, flowType: string, entryId: number, terminalId: number, steps: number[]): number {
    const flowStmt = db.prepare(`
      INSERT INTO execution_flows (label, flow_type, entry_symbol_id, terminal_symbol_id, step_count, project_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const result = flowStmt.run(label, flowType, entryId, terminalId, steps.length, projectHash)
    const flowId = Number(result.lastInsertRowid)

    const stepStmt = db.prepare(`
      INSERT INTO flow_steps (flow_id, symbol_id, step_index)
      VALUES (?, ?, ?)
    `)
    for (let i = 0; i < steps.length; i++) {
      stepStmt.run(flowId, steps[i], i + 1)
    }
    return flowId
  }

  function insertInfraSymbol(type: string, pattern: string, operation: string, filePath: string): void {
    const stmt = db.prepare(`
      INSERT INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
      VALUES (?, ?, ?, 'test-repo', ?, 1, 'raw', ?)
    `)
    stmt.run(type, pattern, operation, filePath, projectHash)
  }

  describe('handleContext', () => {
    it('should return 360-degree view of a symbol', () => {
      const funcA = insertSymbol('handleRequest', 'function', '/src/handler.ts', true, 1)
      const funcB = insertSymbol('processData', 'function', '/src/processor.ts', true, 1)
      const funcC = insertSymbol('saveResult', 'function', '/src/storage.ts', true, 2)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)

      insertFlow('HandleRequest -> SaveResult', 'cross_community', funcA, funcC, [funcA, funcB, funcC])
      insertInfraSymbol('redis_key', 'cache:*', 'read', '/src/handler.ts')

      const result = graph.handleContext({
        name: 'handleRequest',
        projectHash,
      })

      expect(result.found).toBe(true)
      expect(result.symbol?.name).toBe('handleRequest')
      expect(result.symbol?.kind).toBe('function')
      expect(result.outgoing).toHaveLength(1)
      expect(result.outgoing?.[0].name).toBe('processData')
      expect(result.flows).toHaveLength(1)
      expect(result.flows?.[0].label).toBe('HandleRequest -> SaveResult')
      expect(result.infrastructureSymbols).toHaveLength(1)
      expect(result.infrastructureSymbols?.[0].type).toBe('redis_key')
    })

    it('should return disambiguation list when multiple symbols match', () => {
      insertSymbol('helper', 'function', '/src/a.ts', true)
      insertSymbol('helper', 'function', '/src/b.ts', true)

      const result = graph.handleContext({
        name: 'helper',
        projectHash,
      })

      expect(result.found).toBe(false)
      expect(result.disambiguation).toHaveLength(2)
      expect(result.disambiguation?.[0].filePath).toBe('/src/a.ts')
      expect(result.disambiguation?.[1].filePath).toBe('/src/b.ts')
    })

    it('should disambiguate with file_path', () => {
      insertSymbol('helper', 'function', '/src/a.ts', true)
      insertSymbol('helper', 'function', '/src/b.ts', true)

      const result = graph.handleContext({
        name: 'helper',
        filePath: '/src/a.ts',
        projectHash,
      })

      expect(result.found).toBe(true)
      expect(result.symbol?.filePath).toBe('/src/a.ts')
    })

    it('should return not found for unknown symbol', () => {
      const result = graph.handleContext({
        name: 'nonexistent',
        projectHash,
      })

      expect(result.found).toBe(false)
      expect(result.disambiguation).toBeUndefined()
    })

    it('should include incoming edges (callers)', () => {
      const caller1 = insertSymbol('caller1', 'function', '/src/a.ts', true)
      const caller2 = insertSymbol('caller2', 'function', '/src/b.ts', true)
      const target = insertSymbol('target', 'function', '/src/target.ts', true)

      insertEdge(caller1, target)
      insertEdge(caller2, target)

      const result = graph.handleContext({
        name: 'target',
        projectHash,
      })

      expect(result.found).toBe(true)
      expect(result.incoming).toHaveLength(2)
      const callerNames = result.incoming?.map(e => e.name).sort()
      expect(callerNames).toEqual(['caller1', 'caller2'])
    })
  })

  describe('handleImpact', () => {
    it('should analyze downstream impact', () => {
      const funcA = insertSymbol('entryPoint', 'function', '/src/entry.ts', true)
      const funcB = insertSymbol('middleware', 'function', '/src/mid.ts', true)
      const funcC = insertSymbol('handler', 'function', '/src/handler.ts', true)
      const funcD = insertSymbol('storage', 'function', '/src/storage.ts', true)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)
      insertEdge(funcC, funcD)

      const result = graph.handleImpact({
        target: 'entryPoint',
        direction: 'downstream',
        projectHash,
      })

      expect(result.found).toBe(true)
      expect(result.target?.name).toBe('entryPoint')
      expect(result.summary.directDeps).toBe(1)
      expect(result.summary.totalAffected).toBe(3)
      expect(result.byDepth[1]).toHaveLength(1)
      expect(result.byDepth[1][0].name).toBe('middleware')
      expect(result.byDepth[2]).toHaveLength(1)
      expect(result.byDepth[2][0].name).toBe('handler')
    })

    it('should analyze upstream impact', () => {
      const funcA = insertSymbol('caller1', 'function', '/src/a.ts', true)
      const funcB = insertSymbol('caller2', 'function', '/src/b.ts', true)
      const funcC = insertSymbol('target', 'function', '/src/target.ts', true)

      insertEdge(funcA, funcC)
      insertEdge(funcB, funcC)

      const result = graph.handleImpact({
        target: 'target',
        direction: 'upstream',
        projectHash,
      })

      expect(result.found).toBe(true)
      expect(result.summary.directDeps).toBe(2)
      expect(result.byDepth[1]).toHaveLength(2)
    })

    it('should compute risk levels correctly', () => {
      const target = insertSymbol('target', 'function', '/src/target.ts', true)

      for (let i = 0; i < 10; i++) {
        const caller = insertSymbol(`caller${i}`, 'function', `/src/caller${i}.ts`, true)
        insertEdge(caller, target)
      }

      const result = graph.handleImpact({
        target: 'target',
        direction: 'upstream',
        projectHash,
      })

      expect(result.risk).toBe('CRITICAL')
    })

    it('should include affected flows', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', true)
      const funcC = insertSymbol('funcC', 'function', '/src/c.ts', true)

      insertEdge(funcA, funcB)
      insertEdge(funcB, funcC)
      insertFlow('FuncA -> FuncC', 'cross_community', funcA, funcC, [funcA, funcB, funcC])

      const result = graph.handleImpact({
        target: 'funcA',
        direction: 'downstream',
        projectHash,
      })

      expect(result.affectedFlows.length).toBeGreaterThan(0)
      expect(result.affectedFlows[0].label).toBe('FuncA -> FuncC')
    })

    it('should respect maxDepth limit', () => {
      const symbols: number[] = []
      for (let i = 0; i < 10; i++) {
        symbols.push(insertSymbol(`func${i}`, 'function', `/src/file${i}.ts`, true))
      }
      for (let i = 0; i < 9; i++) {
        insertEdge(symbols[i], symbols[i + 1])
      }

      const result = graph.handleImpact({
        target: 'func0',
        direction: 'downstream',
        maxDepth: 3,
        projectHash,
      })

      expect(Object.keys(result.byDepth).length).toBeLessThanOrEqual(3)
    })

    it('should return disambiguation for multiple matches', () => {
      insertSymbol('common', 'function', '/src/a.ts', true)
      insertSymbol('common', 'function', '/src/b.ts', true)

      const result = graph.handleImpact({
        target: 'common',
        direction: 'downstream',
        projectHash,
      })

      expect(result.found).toBe(false)
      expect(result.disambiguation).toHaveLength(2)
    })
  })

  describe('handleDetectChanges', () => {
    it('should return empty result when no git changes', () => {
      const result = graph.handleDetectChanges({
        workspaceRoot: '/nonexistent/path',
        projectHash,
      })

      expect(result.changedFiles).toHaveLength(0)
      expect(result.changedSymbols).toHaveLength(0)
      expect(result.affectedFlows).toHaveLength(0)
      expect(result.riskLevel).toBe('LOW')
    })

    it('should handle git errors gracefully', () => {
      const result = graph.handleDetectChanges({
        scope: 'staged',
        workspaceRoot: '/definitely/not/a/git/repo',
        projectHash,
      })

      expect(result.changedFiles).toHaveLength(0)
      expect(result.riskLevel).toBe('LOW')
    })
  })

  describe('risk level calculation', () => {
    it('should return LOW for 0-2 direct deps and 0 flows', () => {
      const target = insertSymbol('target', 'function', '/src/target.ts', true)
      const caller1 = insertSymbol('caller1', 'function', '/src/a.ts', true)
      const caller2 = insertSymbol('caller2', 'function', '/src/b.ts', true)

      insertEdge(caller1, target)
      insertEdge(caller2, target)

      const result = graph.handleImpact({
        target: 'target',
        direction: 'upstream',
        projectHash,
      })

      expect(result.risk).toBe('LOW')
    })

    it('should return MEDIUM for 3-5 direct deps', () => {
      const target = insertSymbol('target', 'function', '/src/target.ts', true)

      for (let i = 0; i < 4; i++) {
        const caller = insertSymbol(`caller${i}`, 'function', `/src/caller${i}.ts`, true)
        insertEdge(caller, target)
      }

      const result = graph.handleImpact({
        target: 'target',
        direction: 'upstream',
        projectHash,
      })

      expect(result.risk).toBe('MEDIUM')
    })

    it('should return HIGH for 6-9 direct deps', () => {
      const target = insertSymbol('target', 'function', '/src/target.ts', true)

      for (let i = 0; i < 7; i++) {
        const caller = insertSymbol(`caller${i}`, 'function', `/src/caller${i}.ts`, true)
        insertEdge(caller, target)
      }

      const result = graph.handleImpact({
        target: 'target',
        direction: 'upstream',
        projectHash,
      })

      expect(result.risk).toBe('HIGH')
    })

    it('should return MEDIUM for 1-2 affected flows', () => {
      const funcA = insertSymbol('funcA', 'function', '/src/a.ts', true)
      const funcB = insertSymbol('funcB', 'function', '/src/b.ts', true)

      insertEdge(funcA, funcB)
      insertFlow('Flow1', 'intra_community', funcA, funcB, [funcA, funcB])

      const result = graph.handleImpact({
        target: 'funcA',
        direction: 'downstream',
        projectHash,
      })

      expect(result.summary.flowsAffected).toBeGreaterThanOrEqual(1)
      expect(['MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.risk)
    })
  })

  describe('path traversal validation', () => {
    it('should reject path traversal in handleContext file_path', () => {
      expect(() =>
        graph.handleContext({
          name: 'anything',
          filePath: '../../etc/passwd',
          projectHash,
        })
      ).toThrow('path traversal')
    })

    it('should reject path traversal in handleImpact file_path', () => {
      expect(() =>
        graph.handleImpact({
          target: 'anything',
          direction: 'downstream',
          filePath: '/src/../../../etc/shadow',
          projectHash,
        })
      ).toThrow('path traversal')
    })

    it('should accept normal absolute paths without throwing', () => {
      expect(() =>
        graph.handleContext({
          name: 'nonexistent',
          filePath: '/src/handler.ts',
          projectHash,
        })
      ).not.toThrow()
    })

    it('should validate via standalone validateFilePath function', () => {
      expect(() => validateFilePath('/safe/path/file.ts')).not.toThrow()
      expect(() => validateFilePath('../../etc/passwd')).toThrow('path traversal')
      expect(() => validateFilePath('/a/b/../../../etc')).toThrow('path traversal')
    })
  })
})
