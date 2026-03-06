import Database from 'better-sqlite3'
import { log } from './logger.js'

export interface FlowDetectionConfig {
  maxTraceDepth: number
  maxBranching: number
  maxProcesses: number
  minSteps: number
}

export interface DetectedFlow {
  label: string
  flowType: 'intra_community' | 'cross_community'
  entrySymbolId: number
  terminalSymbolId: number
  steps: number[]
}

interface EntryPoint {
  id: number
  name: string
  kind: string
  filePath: string
}

const DEFAULT_CONFIG: FlowDetectionConfig = {
  maxTraceDepth: 10,
  maxBranching: 4,
  maxProcesses: 75,
  minSteps: 2,
}

function toPascalCase(name: string): string {
  if (!name) return ''
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function detectEntryPoints(
  db: Database.Database,
  projectHash: string
): EntryPoint[] {
  const stmt = db.prepare(`
    SELECT cs.id, cs.name, cs.kind, cs.file_path as filePath
    FROM code_symbols cs
    WHERE cs.project_hash = ?
      AND cs.exported = 1
      AND cs.kind IN ('function', 'method')
      AND cs.id NOT IN (
        SELECT DISTINCT se.target_id
        FROM symbol_edges se
        WHERE se.project_hash = ?
          AND se.edge_type = 'CALLS'
      )
  `)

  const rows = stmt.all(projectHash, projectHash) as EntryPoint[]
  log('flow-detection', `Found ${rows.length} entry points for project ${projectHash}`)
  return rows
}

export function traceFlows(
  db: Database.Database,
  entryPoints: EntryPoint[],
  projectHash: string,
  config?: Partial<FlowDetectionConfig>
): DetectedFlow[] {
  const cfg: FlowDetectionConfig = { ...DEFAULT_CONFIG, ...config }
  const flows: DetectedFlow[] = []

  const getOutgoingCallsStmt = db.prepare(`
    SELECT se.target_id as targetId, se.confidence
    FROM symbol_edges se
    WHERE se.source_id = ?
      AND se.project_hash = ?
      AND se.edge_type = 'CALLS'
    ORDER BY se.confidence DESC
    LIMIT ?
  `)

  const getClusterIdStmt = db.prepare(`
    SELECT cluster_id as clusterId FROM code_symbols WHERE id = ?
  `)

  const getSymbolNameStmt = db.prepare(`
    SELECT name FROM code_symbols WHERE id = ?
  `)

  for (const entry of entryPoints) {
    if (flows.length >= cfg.maxProcesses) {
      log('flow-detection', `Reached maxProcesses limit (${cfg.maxProcesses})`)
      break
    }

    const visited = new Set<number>()
    const queue: Array<{ path: number[]; depth: number }> = [{ path: [entry.id], depth: 0 }]
    const completedPaths: number[][] = []

    while (queue.length > 0 && flows.length + completedPaths.length < cfg.maxProcesses) {
      const current = queue.shift()!
      const currentId = current.path[current.path.length - 1]

      if (visited.has(currentId) && current.path.length > 1) {
        if (current.path.length >= cfg.minSteps) {
          completedPaths.push(current.path)
        }
        continue
      }
      visited.add(currentId)

      if (current.depth >= cfg.maxTraceDepth) {
        if (current.path.length >= cfg.minSteps) {
          completedPaths.push(current.path)
        }
        continue
      }

      const outgoing = getOutgoingCallsStmt.all(currentId, projectHash, cfg.maxBranching) as Array<{
        targetId: number
        confidence: number
      }>

      if (outgoing.length === 0) {
        if (current.path.length >= cfg.minSteps) {
          completedPaths.push(current.path)
        }
      } else {
        let addedAny = false
        for (const edge of outgoing) {
          if (!current.path.includes(edge.targetId)) {
            queue.push({
              path: [...current.path, edge.targetId],
              depth: current.depth + 1,
            })
            addedAny = true
          }
        }
        if (!addedAny && current.path.length >= cfg.minSteps) {
          completedPaths.push(current.path)
        }
      }
    }

    for (const pathSteps of completedPaths) {
      if (flows.length >= cfg.maxProcesses) break

      const entrySymbolId = pathSteps[0]
      const terminalSymbolId = pathSteps[pathSteps.length - 1]

      const entryNameRow = getSymbolNameStmt.get(entrySymbolId) as { name: string } | undefined
      const terminalNameRow = getSymbolNameStmt.get(terminalSymbolId) as { name: string } | undefined

      const entryName = entryNameRow?.name || 'Unknown'
      const terminalName = terminalNameRow?.name || 'Unknown'
      const label = `${toPascalCase(entryName)} -> ${toPascalCase(terminalName)}`

      const clusterIds = new Set<number | null>()
      for (const symbolId of pathSteps) {
        const row = getClusterIdStmt.get(symbolId) as { clusterId: number | null } | undefined
        clusterIds.add(row?.clusterId ?? null)
      }

      let flowType: 'intra_community' | 'cross_community'
      if (clusterIds.has(null)) {
        flowType = 'cross_community'
      } else if (clusterIds.size === 1) {
        flowType = 'intra_community'
      } else {
        flowType = 'cross_community'
      }

      flows.push({
        label,
        flowType,
        entrySymbolId,
        terminalSymbolId,
        steps: pathSteps,
      })
    }
  }

  log('flow-detection', `Traced ${flows.length} flows from ${entryPoints.length} entry points`)
  return flows
}

export function storeFlows(
  db: Database.Database,
  flows: DetectedFlow[],
  projectHash: string
): { flowsStored: number } {
  const deleteFlowStepsStmt = db.prepare(`
    DELETE FROM flow_steps WHERE flow_id IN (
      SELECT id FROM execution_flows WHERE project_hash = ?
    )
  `)
  const deleteFlowsStmt = db.prepare(`
    DELETE FROM execution_flows WHERE project_hash = ?
  `)

  deleteFlowStepsStmt.run(projectHash)
  deleteFlowsStmt.run(projectHash)

  const insertFlowStmt = db.prepare(`
    INSERT INTO execution_flows (label, flow_type, entry_symbol_id, terminal_symbol_id, step_count, project_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const insertStepStmt = db.prepare(`
    INSERT INTO flow_steps (flow_id, symbol_id, step_index)
    VALUES (?, ?, ?)
  `)

  let flowsStored = 0

  for (const flow of flows) {
    const result = insertFlowStmt.run(
      flow.label,
      flow.flowType,
      flow.entrySymbolId,
      flow.terminalSymbolId,
      flow.steps.length,
      projectHash
    )
    const flowId = Number(result.lastInsertRowid)

    for (let i = 0; i < flow.steps.length; i++) {
      insertStepStmt.run(flowId, flow.steps[i], i + 1)
    }

    flowsStored++
  }

  log('flow-detection', `Stored ${flowsStored} flows for project ${projectHash}`)
  return { flowsStored }
}

export function detectAndStoreFlows(
  db: Database.Database,
  projectHash: string,
  config?: Partial<FlowDetectionConfig>
): { flowsDetected: number; entryPointsFound: number } {
  const entryPoints = detectEntryPoints(db, projectHash)
  const flows = traceFlows(db, entryPoints, projectHash, config)
  storeFlows(db, flows, projectHash)

  return {
    flowsDetected: flows.length,
    entryPointsFound: entryPoints.length,
  }
}
