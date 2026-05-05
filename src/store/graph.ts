import Database from 'better-sqlite3';
import type { MemoryEntity, MemoryEdge } from '../types.js';
import { log } from '../logger.js';
import type { Stmts } from './schema.js';

export function makeGraphMethods(
  db: Database.Database,
  stmts: Stmts,
  state: { workspaceRoot: string | null }
) {
  function toRelativePath(absolutePath: string, workspaceRoot: string): string {
    if (!absolutePath.startsWith('/')) return absolutePath;
    const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
    if (absolutePath.startsWith(prefix)) {
      return absolutePath.slice(prefix.length);
    }
    if (absolutePath === workspaceRoot || absolutePath === workspaceRoot + '/') {
      return '';
    }
    return absolutePath;
  }

  function toRel(p: string): string {
    return state.workspaceRoot ? toRelativePath(p, state.workspaceRoot) : p;
  }

  return {
    insertFileEdge(sourcePath: string, targetPath: string, projectHash: string, edgeType: string = 'import') {
      stmts.insertFileEdge.run(toRel(sourcePath), toRel(targetPath), edgeType, projectHash);
    },

    deleteFileEdges(sourcePath: string, projectHash: string) {
      stmts.deleteFileEdges.run(toRel(sourcePath), projectHash);
    },

    getFileEdges(projectHash: string): Array<{ source_path: string; target_path: string }> {
      return stmts.getFileEdges.all(projectHash) as Array<{ source_path: string; target_path: string }>;
    },

    getFileDependencies(filePath: string, projectHash: string): string[] {
      const rows = stmts.getFileDependenciesStmt.all(toRel(filePath), projectHash) as Array<{ target_path: string }>;
      return rows.map(r => r.target_path);
    },

    getFileDependents(filePath: string, projectHash: string): string[] {
      const rows = stmts.getFileDependentsStmt.all(toRel(filePath), projectHash) as Array<{ source_path: string }>;
      return rows.map(r => r.source_path);
    },

    updateCentralityScores(projectHash: string, scores: Map<string, number>) {
      for (const [filePath, score] of scores) {
        stmts.updateCentrality.run(score, projectHash, filePath);
      }
    },

    updateClusterIds(projectHash: string, clusters: Map<string, number>) {
      for (const [filePath, clusterId] of clusters) {
        stmts.updateClusterId.run(clusterId, projectHash, filePath);
      }
    },

    getEdgeSetHash(projectHash: string): string | null {
      const row = stmts.getEdgeSetHash.get(projectHash) as { result: string } | undefined;
      return row?.result ?? null;
    },

    setEdgeSetHash(projectHash: string, hash: string) {
      stmts.setEdgeSetHash.run(projectHash, hash);
    },

    getDocumentCentrality(filePath: string): { centrality: number; clusterId: number | null } | null {
      const row = stmts.getDocumentCentralityStmt.get(toRel(filePath)) as { centrality: number; cluster_id: number | null } | undefined;
      if (!row) return null;
      return { centrality: row.centrality ?? 0, clusterId: row.cluster_id };
    },

    getClusterMembers(clusterId: number, projectHash: string): string[] {
      const rows = stmts.getClusterMembersStmt.all(clusterId, projectHash) as Array<{ path: string }>;
      return rows.map(r => r.path);
    },

    getGraphStats(projectHash: string): {
      nodeCount: number;
      edgeCount: number;
      clusterCount: number;
      topCentrality: Array<{ path: string; centrality: number }>;
    } {
      const edges = stmts.graphEdgeCount.get(projectHash) as { count: number };
      const nodes = stmts.graphNodeCount.get(projectHash, projectHash) as { count: number };
      const clusters = stmts.graphClusterCount.get(projectHash) as { count: number };
      const topCentrality = stmts.graphTopCentrality.all(projectHash) as Array<{ path: string; centrality: number }>;

      return {
        nodeCount: nodes.count,
        edgeCount: edges.count,
        clusterCount: clusters.count,
        topCentrality,
      };
    },

    insertOrUpdateEntity(entity: Omit<MemoryEntity, 'id'>): number {
      try {
        stmts.insertOrUpdateEntity.run(
          entity.name,
          entity.type,
          entity.description ?? null,
          entity.projectHash
        );
        const row = db.prepare(`
          SELECT id FROM memory_entities
          WHERE name COLLATE NOCASE = ? AND type = ? AND project_hash = ?
        `).get(entity.name, entity.type, entity.projectHash) as { id: number } | undefined;
        return row?.id ?? 0;
      } catch (err) {
        log('store', `Failed to insert/update entity: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return 0;
      }
    },

    getMemoryEntities(projectHash: string, limit: number = 100): MemoryEntity[] {
      const rows = stmts.getMemoryEntities.all(projectHash, limit) as Array<Record<string, unknown>>;
      return rows.map(row => ({
        id: row.id as number,
        name: row.name as string,
        type: row.type as MemoryEntity['type'],
        description: row.description as string | undefined,
        projectHash: row.projectHash as string,
        firstLearnedAt: row.firstLearnedAt as string,
        lastConfirmedAt: row.lastConfirmedAt as string,
        contradictedAt: row.contradictedAt as string | null | undefined,
        contradictedByMemoryId: row.contradictedByMemoryId as number | null | undefined,
      }));
    },

    deleteEntity(id: number): void {
      stmts.deleteEntity.run(id);
    },

    insertEdge(edge: Omit<MemoryEdge, 'id' | 'createdAt'>): number {
      try {
        const result = stmts.insertMemoryEdge.run(
          edge.sourceId,
          edge.targetId,
          edge.edgeType,
          edge.projectHash
        );
        if (result.changes === 0) {
          const existing = db.prepare(`
            SELECT id FROM memory_edges
            WHERE source_id = ? AND target_id = ? AND edge_type = ? AND project_hash = ?
          `).get(edge.sourceId, edge.targetId, edge.edgeType, edge.projectHash) as { id: number } | undefined;
          return existing?.id ?? 0;
        }
        return Number(result.lastInsertRowid);
      } catch (err) {
        log('store', `Failed to insert edge: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return 0;
      }
    },

    getEntityEdges(entityId: number, direction: 'incoming' | 'outgoing' | 'both' = 'both'): Array<MemoryEdge & { sourceName: string; targetName: string }> {
      let rows: Array<Record<string, unknown>>;
      if (direction === 'incoming') {
        rows = stmts.getEntityEdgesIncoming.all(entityId) as Array<Record<string, unknown>>;
      } else if (direction === 'outgoing') {
        rows = stmts.getEntityEdgesOutgoing.all(entityId) as Array<Record<string, unknown>>;
      } else {
        rows = stmts.getEntityEdgesBoth.all(entityId, entityId) as Array<Record<string, unknown>>;
      }
      return rows.map(row => ({
        id: row.id as number,
        sourceId: row.sourceId as number,
        targetId: row.targetId as number,
        edgeType: row.edgeType as MemoryEdge['edgeType'],
        projectHash: row.projectHash as string,
        createdAt: row.createdAt as string,
        sourceName: row.sourceName as string,
        targetName: row.targetName as string,
      }));
    },

    querySymbols(options: {
      type?: string;
      pattern?: string;
      repo?: string;
      operation?: string;
      projectHash?: string;
    }): Array<{
      type: string;
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
      rawExpression: string;
    }> {
      let sql = `SELECT type, pattern, operation, repo, file_path as filePath, line_number as lineNumber, raw_expression as rawExpression FROM symbols WHERE 1=1`;
      const params: string[] = [];

      if (options.type) {
        sql += ` AND type = ?`;
        params.push(options.type);
      }
      if (options.pattern) {
        const likePattern = options.pattern.replace(/\*/g, '%');
        sql += ` AND pattern LIKE ?`;
        params.push(likePattern);
      }
      if (options.repo) {
        sql += ` AND repo = ?`;
        params.push(options.repo);
      }
      if (options.operation) {
        sql += ` AND operation = ?`;
        params.push(options.operation);
      }
      if (options.projectHash) {
        sql += ` AND project_hash = ?`;
        params.push(options.projectHash);
      }

      sql += ` ORDER BY type, pattern, repo, file_path`;

      return db.prepare(sql).all(...params) as Array<{
        type: string;
        pattern: string;
        operation: string;
        repo: string;
        filePath: string;
        lineNumber: number;
        rawExpression: string;
      }>;
    },

    insertSymbol(symbol: {
      type: string;
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
      rawExpression: string;
      projectHash: string;
    }) {
      const relFilePath = toRel(symbol.filePath);
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO symbols (type, pattern, operation, repo, file_path, line_number, raw_expression, project_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        symbol.type,
        symbol.pattern,
        symbol.operation,
        symbol.repo,
        relFilePath,
        symbol.lineNumber,
        symbol.rawExpression,
        symbol.projectHash
      );
    },

    deleteSymbols(filePath: string, projectHash: string) {
      const relFilePath = toRel(filePath);
      db.prepare(`DELETE FROM symbols WHERE file_path = ? AND project_hash = ?`).run(relFilePath, projectHash);
    },

    getSymbolImpact(type: string, pattern: string, projectHash?: string): Array<{
      pattern: string;
      operation: string;
      repo: string;
      filePath: string;
      lineNumber: number;
    }> {
      const likePattern = pattern.replace(/\*/g, '%');
      let sql = `
        SELECT pattern, operation, repo, file_path as filePath, line_number as lineNumber
        FROM symbols
        WHERE type = ? AND pattern LIKE ?
      `;
      const params: string[] = [type, likePattern];

      if (projectHash) {
        sql += ` AND project_hash = ?`;
        params.push(projectHash);
      }

      sql += ` ORDER BY operation, repo, file_path`;

      return db.prepare(sql).all(...params) as Array<{
        pattern: string;
        operation: string;
        repo: string;
        filePath: string;
        lineNumber: number;
      }>;
    },

    getInfrastructureSymbols(projectHash: string) {
      return stmts.getInfrastructureSymbols.all(projectHash) as Array<{
        type: string;
        pattern: string;
        operation: string;
        repo: string;
        filePath: string;
        lineNumber: number;
      }>;
    },

    getSymbolsForProject(projectHash: string) {
      const rows = stmts.getSymbolsForProject.all(projectHash) as Array<{
        id: number;
        name: string;
        kind: string;
        filePath: string;
        startLine: number;
        endLine: number;
        exported: number;
        clusterId: number | null;
      }>;
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        filePath: row.filePath,
        startLine: row.startLine,
        endLine: row.endLine,
        exported: Boolean(row.exported),
        clusterId: row.clusterId,
      }));
    },

    getSymbolEdgesForProject(projectHash: string) {
      return stmts.getSymbolEdgesForProject.all(projectHash) as Array<{
        id: number;
        sourceId: number;
        targetId: number;
        edgeType: string;
        confidence: number;
      }>;
    },

    getSymbolClusters(projectHash: string) {
      return stmts.getSymbolClusters.all(projectHash) as Array<{
        clusterId: number;
        memberCount: number;
      }>;
    },

    getFlowsWithSteps(projectHash: string) {
      return stmts.getFlowsWithSteps.all(projectHash) as Array<{
        id: number;
        label: string;
        flowType: string;
        stepCount: number;
        entryName: string;
        entryFile: string;
        terminalName: string;
        terminalFile: string;
      }>;
    },

    getFlowSteps(flowId: number) {
      return stmts.getFlowSteps.all(flowId) as Array<{
        stepIndex: number;
        symbolId: number;
        name: string;
        kind: string;
        filePath: string;
        startLine: number;
      }>;
    },

    getDocFlows(projectHash: string) {
      return stmts.getDocFlows.all(projectHash) as Array<{
        id: number;
        label: string;
        flowType: string;
        description: string | null;
        services: string | null;
        sourceFile: string | null;
        lastUpdated: string | null;
      }>;
    },

    upsertDocFlow(flow: {
      label: string;
      flowType: string;
      description?: string | null;
      services?: string | null;
      sourceFile?: string | null;
      lastUpdated?: string | null;
      projectHash: string;
    }): number {
      const relSourceFile = flow.sourceFile && state.workspaceRoot
        ? toRelativePath(flow.sourceFile, state.workspaceRoot)
        : flow.sourceFile ?? null;
      const result = stmts.upsertDocFlow.run(
        flow.label, flow.flowType, flow.description ?? null,
        flow.services ?? null, relSourceFile,
        flow.lastUpdated ?? null, flow.projectHash
      );
      return Number(result.lastInsertRowid);
    },

    deleteDocFlowsByProject(projectHash: string): number {
      const result = stmts.deleteDocFlowsByProject.run(projectHash);
      return result.changes;
    },

    getAllConnections(projectHash: string) {
      return stmts.getAllConnections.all(projectHash) as Array<
        import('../types.js').MemoryConnection & {
          fromTitle: string;
          fromPath: string;
          toTitle: string;
          toPath: string;
        }
      >;
    },

    getEntityById(id: number): MemoryEntity | null {
      const row = stmts.getEntityById.get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as number,
        name: row.name as string,
        type: row.type as MemoryEntity['type'],
        description: row.description as string | undefined,
        projectHash: row.projectHash as string,
        firstLearnedAt: row.firstLearnedAt as string,
        lastConfirmedAt: row.lastConfirmedAt as string,
        contradictedAt: row.contradictedAt as string | null | undefined,
        contradictedByMemoryId: row.contradictedByMemoryId as number | null | undefined,
      };
    },

    getEntityByName(name: string, type?: string, projectHash?: string): MemoryEntity | null {
      let row: Record<string, unknown> | undefined;
      if (type && projectHash) {
        row = stmts.getEntityByNameTypeProject.get(name, type, projectHash) as Record<string, unknown> | undefined;
      } else if (type) {
        row = stmts.getEntityByNameAndType.get(name, type) as Record<string, unknown> | undefined;
      } else {
        row = stmts.getEntityByName.get(name) as Record<string, unknown> | undefined;
      }
      if (!row) return null;
      return {
        id: row.id as number,
        name: row.name as string,
        type: row.type as MemoryEntity['type'],
        description: row.description as string | undefined,
        projectHash: row.projectHash as string,
        firstLearnedAt: row.firstLearnedAt as string,
        lastConfirmedAt: row.lastConfirmedAt as string,
        contradictedAt: row.contradictedAt as string | null | undefined,
        contradictedByMemoryId: row.contradictedByMemoryId as number | null | undefined,
      };
    },

    markEntityContradicted(entityId: number, contradictedByMemoryId: number): void {
      try {
        stmts.markEntityContradicted.run(contradictedByMemoryId, entityId);
      } catch (err) {
        log('store', `Failed to mark entity contradicted: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    confirmEntity(entityId: number): void {
      try {
        stmts.confirmEntity.run(entityId);
      } catch (err) {
        log('store', `Failed to confirm entity: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getMemoryEntityCount(projectHash: string): number {
      const row = stmts.getMemoryEntityCount.get(projectHash) as { count: number };
      return row.count;
    },

    getContradictedEntitiesForPruning(ttlDays: number, batchSize: number, projectHash?: string): number[] {
      let rows: Array<{ id: number }>;
      if (projectHash) {
        rows = stmts.getContradictedEntitiesForPruningByProject.all(ttlDays, projectHash, batchSize) as Array<{ id: number }>;
      } else {
        rows = stmts.getContradictedEntitiesForPruning.all(ttlDays, batchSize) as Array<{ id: number }>;
      }
      return rows.map(r => r.id);
    },

    getOrphanEntitiesForPruning(ttlDays: number, batchSize: number, projectHash?: string): number[] {
      let rows: Array<{ id: number }>;
      if (projectHash) {
        rows = stmts.getOrphanEntitiesForPruningByProject.all(ttlDays, projectHash, batchSize) as Array<{ id: number }>;
      } else {
        rows = stmts.getOrphanEntitiesForPruning.all(ttlDays, batchSize) as Array<{ id: number }>;
      }
      return rows.map(r => r.id);
    },

    getPrunedEntitiesForHardDelete(retentionDays: number, batchSize: number, projectHash?: string): number[] {
      let rows: Array<{ id: number }>;
      if (projectHash) {
        rows = stmts.getPrunedEntitiesForHardDeleteByProject.all(retentionDays, projectHash, batchSize) as Array<{ id: number }>;
      } else {
        rows = stmts.getPrunedEntitiesForHardDelete.all(retentionDays, batchSize) as Array<{ id: number }>;
      }
      return rows.map(r => r.id);
    },

    softDeleteEntities(ids: number[]): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE memory_entities SET pruned_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
    },

    hardDeleteEntities(ids: number[]): void {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM memory_entities WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM memory_edges WHERE source_id NOT IN (SELECT id FROM memory_entities) OR target_id NOT IN (SELECT id FROM memory_entities)`).run();
    },

    getActiveEntitiesByTypeAndProject(projectHash?: string): MemoryEntity[] {
      let rows: Array<Record<string, unknown>>;
      if (projectHash) {
        rows = stmts.getActiveEntitiesByTypeAndProjectFiltered.all(projectHash) as Array<Record<string, unknown>>;
      } else {
        rows = stmts.getActiveEntitiesByTypeAndProject.all() as Array<Record<string, unknown>>;
      }
      return rows.map(row => ({
        id: row.id as number,
        name: row.name as string,
        type: row.type as MemoryEntity['type'],
        description: row.description as string | undefined,
        projectHash: row.projectHash as string,
        firstLearnedAt: row.firstLearnedAt as string,
        lastConfirmedAt: row.lastConfirmedAt as string,
        contradictedAt: row.contradictedAt as string | null | undefined,
        contradictedByMemoryId: row.contradictedByMemoryId as number | null | undefined,
      }));
    },

    getEntityEdgeCount(entityId: number): number {
      const row = stmts.getEntityEdgeCount.get(entityId, entityId) as { count: number };
      return row.count;
    },

    redirectEntityEdges(fromId: number, toId: number): void {
      stmts.redirectEntityEdgesSource.run(toId, fromId);
      stmts.redirectEntityEdgesTarget.run(toId, fromId);
    },

    deduplicateEdges(_entityId: number): void {
      stmts.deleteSelfLoopEdges.run();
      stmts.deleteDuplicateEdges.run();
    },
  };
}
