import Database from 'better-sqlite3'
import { execSync } from 'child_process'
import * as path from 'path'
import { getClusterLabels } from './graph.js'

/**
 * Validate that a file path does not contain path traversal sequences.
 * Rejects paths containing '..' segments before or after normalization.
 */
export function validateFilePath(filePath: string): void {
  if (filePath.includes('..')) {
    throw new Error(`Invalid file_path: path traversal detected ("${filePath}")`)
  }
}

export interface SymbolRecord {
  id: number
  name: string
  kind: string
  filePath: string
  startLine: number
  endLine: number
  exported: boolean
  clusterId: number | null
}

export interface EdgeRecord {
  id: number
  sourceId: number
  targetId: number
  edgeType: string
  confidence: number
  symbolName: string
  symbolKind: string
  symbolFilePath: string
}

export class SymbolGraph {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  insertSymbol(symbol: {
    name: string
    kind: string
    filePath: string
    startLine: number
    endLine: number
    exported: boolean
    contentHash: string
    projectHash: string
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, content_hash, project_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      symbol.name,
      symbol.kind,
      symbol.filePath,
      symbol.startLine,
      symbol.endLine,
      symbol.exported ? 1 : 0,
      symbol.contentHash,
      symbol.projectHash
    )
    return Number(result.lastInsertRowid)
  }

  insertEdge(edge: {
    sourceId: number
    targetId: number
    edgeType: string
    confidence: number
    projectHash: string
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO symbol_edges (source_id, target_id, edge_type, confidence, project_hash)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(
      edge.sourceId,
      edge.targetId,
      edge.edgeType,
      edge.confidence,
      edge.projectHash
    )
  }

  deleteSymbolsForFile(filePath: string, projectHash: string): void {
    const deleteEdgesStmt = this.db.prepare(`
      DELETE FROM symbol_edges 
      WHERE project_hash = ? AND (
        source_id IN (SELECT id FROM code_symbols WHERE file_path = ? AND project_hash = ?)
        OR target_id IN (SELECT id FROM code_symbols WHERE file_path = ? AND project_hash = ?)
      )
    `)
    deleteEdgesStmt.run(projectHash, filePath, projectHash, filePath, projectHash)

    const deleteSymbolsStmt = this.db.prepare(`
      DELETE FROM code_symbols WHERE file_path = ? AND project_hash = ?
    `)
    deleteSymbolsStmt.run(filePath, projectHash)
  }

  getSymbolByName(
    name: string,
    projectHash: string,
    filePath?: string
  ): SymbolRecord[] {
    if (filePath) {
      const stmt = this.db.prepare(`
        SELECT id, name, kind, file_path as filePath, start_line as startLine, end_line as endLine,
               exported, cluster_id as clusterId
        FROM code_symbols 
        WHERE name = ? AND project_hash = ? AND file_path = ?
      `)
      return stmt.all(name, projectHash, filePath) as SymbolRecord[]
    }
    const stmt = this.db.prepare(`
      SELECT id, name, kind, file_path as filePath, start_line as startLine, end_line as endLine, 
             exported, cluster_id as clusterId
      FROM code_symbols 
      WHERE name = ? AND project_hash = ?
    `)
    return stmt.all(name, projectHash) as SymbolRecord[]
  }

  getSymbolEdges(
    symbolId: number,
    direction: 'incoming' | 'outgoing',
    edgeTypes?: string[],
    minConfidence?: number
  ): EdgeRecord[] {
    const sql = direction === 'outgoing'
      ? `SELECT e.id, e.source_id as sourceId, e.target_id as targetId, e.edge_type as edgeType, 
               e.confidence, s.name as symbolName, s.kind as symbolKind, s.file_path as symbolFilePath
         FROM symbol_edges e
         JOIN code_symbols s ON s.id = e.target_id
         WHERE e.source_id = ?`
      : `SELECT e.id, e.source_id as sourceId, e.target_id as targetId, e.edge_type as edgeType,
               e.confidence, s.name as symbolName, s.kind as symbolKind, s.file_path as symbolFilePath
         FROM symbol_edges e
         JOIN code_symbols s ON s.id = e.source_id
         WHERE e.target_id = ?`

    const stmt = this.db.prepare(sql)
    let edges = stmt.all(symbolId) as EdgeRecord[]

    if (edgeTypes && edgeTypes.length > 0) {
      edges = edges.filter(e => edgeTypes.includes(e.edgeType))
    }

    if (minConfidence !== undefined) {
      edges = edges.filter(e => e.confidence >= minConfidence)
    }

    return edges
  }

  getSymbolCount(projectHash: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM code_symbols WHERE project_hash = ?
    `)
    const row = stmt.get(projectHash) as { count: number }
    return row.count
  }

  getEdgeCount(projectHash: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM symbol_edges WHERE project_hash = ?
    `)
    const row = stmt.get(projectHash) as { count: number }
    return row.count
  }

  getFileContentHash(filePath: string, projectHash: string): string | null {
    const stmt = this.db.prepare(`
      SELECT content_hash FROM code_symbols WHERE file_path = ? AND project_hash = ? LIMIT 1
    `)
    const row = stmt.get(filePath, projectHash) as { content_hash: string } | undefined
    return row?.content_hash ?? null
  }

  handleContext(params: {
    name: string
    filePath?: string
    projectHash: string
  }): ContextResult {
    if (params.filePath) validateFilePath(params.filePath)
    const symbols = this.getSymbolByName(params.name, params.projectHash, params.filePath)

    if (symbols.length === 0) {
      return { found: false }
    }

    if (symbols.length > 1 && !params.filePath) {
      return {
        found: false,
        disambiguation: symbols.map(s => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          filePath: s.filePath,
          startLine: s.startLine,
        })),
      }
    }

    const symbol = symbols[0]
    const incoming = this.getSymbolEdges(symbol.id, 'incoming')
    const outgoing = this.getSymbolEdges(symbol.id, 'outgoing')

    let clusterLabel: string | undefined
    if (symbol.clusterId !== null) {
      const labels = getClusterLabels(this.db, params.projectHash)
      clusterLabel = labels.get(symbol.clusterId)
    }

    const flowsStmt = this.db.prepare(`
      SELECT ef.label, ef.flow_type as flowType, fs.step_index as stepIndex
      FROM flow_steps fs
      JOIN execution_flows ef ON ef.id = fs.flow_id
      WHERE fs.symbol_id = ? AND ef.project_hash = ?
    `)
    const flows = flowsStmt.all(symbol.id, params.projectHash) as Array<{
      label: string
      flowType: string
      stepIndex: number
    }>

    const infraStmt = this.db.prepare(`
      SELECT type, pattern, operation
      FROM symbols
      WHERE file_path = ? AND project_hash = ?
    `)
    const infrastructureSymbols = infraStmt.all(symbol.filePath, params.projectHash) as Array<{
      type: string
      pattern: string
      operation: string
    }>

    return {
      found: true,
      symbol: {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        exported: symbol.exported,
        clusterId: symbol.clusterId,
      },
      incoming: incoming.map(e => ({
        name: e.symbolName,
        kind: e.symbolKind,
        filePath: e.symbolFilePath,
        edgeType: e.edgeType,
        confidence: e.confidence,
      })),
      outgoing: outgoing.map(e => ({
        name: e.symbolName,
        kind: e.symbolKind,
        filePath: e.symbolFilePath,
        edgeType: e.edgeType,
        confidence: e.confidence,
      })),
      clusterLabel,
      flows,
      infrastructureSymbols,
    }
  }

  handleImpact(params: {
    target: string
    direction: 'upstream' | 'downstream'
    maxDepth?: number
    minConfidence?: number
    filePath?: string
    projectHash: string
  }): ImpactResult {
    if (params.filePath) validateFilePath(params.filePath)
    const symbols = this.getSymbolByName(params.target, params.projectHash, params.filePath)

    if (symbols.length === 0) {
      return {
        found: false,
        risk: 'LOW',
        summary: { directDeps: 0, totalAffected: 0, flowsAffected: 0 },
        byDepth: {},
        affectedFlows: [],
      }
    }

    if (symbols.length > 1 && !params.filePath) {
      return {
        found: false,
        risk: 'LOW',
        summary: { directDeps: 0, totalAffected: 0, flowsAffected: 0 },
        byDepth: {},
        affectedFlows: [],
        disambiguation: symbols.map(s => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          filePath: s.filePath,
        })),
      }
    }

    const symbol = symbols[0]
    const maxDepth = params.maxDepth ?? 5
    const minConfidence = params.minConfidence ?? 0

    const visited = new Set<number>([symbol.id])
    const byDepth: Record<number, Array<{
      name: string
      kind: string
      filePath: string
      edgeType: string
      confidence: number
    }>> = {}

    let currentLevel = [symbol.id]
    let depth = 1

    while (currentLevel.length > 0 && depth <= maxDepth) {
      const nextLevel: number[] = []
      byDepth[depth] = []

      for (const symbolId of currentLevel) {
        const edges = params.direction === 'upstream'
          ? this.getSymbolEdges(symbolId, 'incoming', undefined, minConfidence)
          : this.getSymbolEdges(symbolId, 'outgoing', undefined, minConfidence)

        for (const edge of edges) {
          const neighborId = params.direction === 'upstream' ? edge.sourceId : edge.targetId
          if (!visited.has(neighborId)) {
            visited.add(neighborId)
            nextLevel.push(neighborId)
            byDepth[depth].push({
              name: edge.symbolName,
              kind: edge.symbolKind,
              filePath: edge.symbolFilePath,
              edgeType: edge.edgeType,
              confidence: edge.confidence,
            })
          }
        }
      }

      currentLevel = nextLevel
      depth++
    }

    const affectedSymbolIds = Array.from(visited)
    const placeholders = affectedSymbolIds.map(() => '?').join(',')
    const flowsStmt = this.db.prepare(`
      SELECT DISTINCT ef.label, ef.flow_type as flowType, fs.step_index as stepIndex
      FROM flow_steps fs
      JOIN execution_flows ef ON ef.id = fs.flow_id
      WHERE fs.symbol_id IN (${placeholders}) AND ef.project_hash = ?
    `)
    const affectedFlows = flowsStmt.all(...affectedSymbolIds, params.projectHash) as Array<{
      label: string
      flowType: string
      stepIndex: number
    }>

    const directDeps = byDepth[1]?.length ?? 0
    const totalAffected = visited.size - 1
    const flowsAffected = new Set(affectedFlows.map(f => f.label)).size

    let risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    if (directDeps >= 10 || flowsAffected >= 3) {
      risk = 'CRITICAL'
    } else if (directDeps >= 6 || flowsAffected >= 2) {
      risk = 'HIGH'
    } else if (directDeps >= 3 || flowsAffected >= 1) {
      risk = 'MEDIUM'
    } else {
      risk = 'LOW'
    }

    return {
      found: true,
      target: {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
      },
      risk,
      summary: { directDeps, totalAffected, flowsAffected },
      byDepth,
      affectedFlows,
    }
  }

  handleDetectChanges(params: {
    scope?: 'unstaged' | 'staged' | 'all'
    workspaceRoot: string
    projectHash: string
  }): DetectChangesResult {
    const scope = params.scope ?? 'all'
    let changedFiles: string[] = []

    try {
      let gitOutput = ''
      if (scope === 'unstaged') {
        gitOutput = execSync('git diff --name-only', {
          cwd: params.workspaceRoot,
          encoding: 'utf-8',
        })
      } else if (scope === 'staged') {
        gitOutput = execSync('git diff --cached --name-only', {
          cwd: params.workspaceRoot,
          encoding: 'utf-8',
        })
      } else {
        const unstaged = execSync('git diff --name-only', {
          cwd: params.workspaceRoot,
          encoding: 'utf-8',
        })
        const staged = execSync('git diff --cached --name-only', {
          cwd: params.workspaceRoot,
          encoding: 'utf-8',
        })
        const combined = new Set([
          ...unstaged.trim().split('\n').filter(Boolean),
          ...staged.trim().split('\n').filter(Boolean),
        ])
        changedFiles = Array.from(combined).map(f =>
          f.startsWith('/') ? f : `${params.workspaceRoot}/${f}`
        )
      }

      if (scope !== 'all') {
        changedFiles = gitOutput
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(f => (f.startsWith('/') ? f : `${params.workspaceRoot}/${f}`))
      }
    } catch {
      return {
        changedFiles: [],
        changedSymbols: [],
        affectedFlows: [],
        riskLevel: 'LOW',
      }
    }

    if (changedFiles.length === 0) {
      return {
        changedFiles: [],
        changedSymbols: [],
        affectedFlows: [],
        riskLevel: 'LOW',
      }
    }

    const placeholders = changedFiles.map(() => '?').join(',')
    const symbolsStmt = this.db.prepare(`
      SELECT id, name, kind, file_path as filePath
      FROM code_symbols
      WHERE file_path IN (${placeholders}) AND project_hash = ?
    `)
    const changedSymbols = symbolsStmt.all(...changedFiles, params.projectHash) as Array<{
      id: number
      name: string
      kind: string
      filePath: string
    }>

    const symbolIds = changedSymbols.map(s => s.id)
    let affectedFlows: Array<{ label: string; flowType: string }> = []

    if (symbolIds.length > 0) {
      const flowPlaceholders = symbolIds.map(() => '?').join(',')
      const flowsStmt = this.db.prepare(`
        SELECT DISTINCT ef.label, ef.flow_type as flowType
        FROM flow_steps fs
        JOIN execution_flows ef ON ef.id = fs.flow_id
        WHERE fs.symbol_id IN (${flowPlaceholders}) AND ef.project_hash = ?
      `)
      affectedFlows = flowsStmt.all(...symbolIds, params.projectHash) as Array<{
        label: string
        flowType: string
      }>
    }

    const directDeps = changedSymbols.length
    const flowsAffected = affectedFlows.length

    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    if (directDeps >= 10 || flowsAffected >= 3) {
      riskLevel = 'CRITICAL'
    } else if (directDeps >= 6 || flowsAffected >= 2) {
      riskLevel = 'HIGH'
    } else if (directDeps >= 3 || flowsAffected >= 1) {
      riskLevel = 'MEDIUM'
    } else {
      riskLevel = 'LOW'
    }

    return {
      changedFiles,
      changedSymbols: changedSymbols.map(s => ({
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
      })),
      affectedFlows,
      riskLevel,
    }
  }
}

export interface ContextResult {
  found: boolean
  disambiguation?: Array<{
    id: number
    name: string
    kind: string
    filePath: string
    startLine: number
  }>
  symbol?: {
    id: number
    name: string
    kind: string
    filePath: string
    startLine: number
    endLine: number
    exported: boolean
    clusterId: number | null
  }
  incoming?: Array<{
    name: string
    kind: string
    filePath: string
    edgeType: string
    confidence: number
  }>
  outgoing?: Array<{
    name: string
    kind: string
    filePath: string
    edgeType: string
    confidence: number
  }>
  clusterLabel?: string
  flows?: Array<{
    label: string
    flowType: string
    stepIndex: number
  }>
  infrastructureSymbols?: Array<{
    type: string
    pattern: string
    operation: string
  }>
}

export interface ImpactResult {
  found: boolean
  disambiguation?: Array<{
    id: number
    name: string
    kind: string
    filePath: string
  }>
  target?: {
    id: number
    name: string
    kind: string
    filePath: string
  }
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  summary: {
    directDeps: number
    totalAffected: number
    flowsAffected: number
  }
  byDepth: Record<number, Array<{
    name: string
    kind: string
    filePath: string
    edgeType: string
    confidence: number
  }>>
  affectedFlows: Array<{
    label: string
    flowType: string
    stepIndex: number
  }>
}

export interface DetectChangesResult {
  changedFiles: string[]
  changedSymbols: Array<{
    name: string
    kind: string
    filePath: string
  }>
  affectedFlows: Array<{
    label: string
    flowType: string
  }>
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
}
