import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Store, IndexHealth } from '../types.js';
import type { VectorStore } from '../vector-store.js';
import { chunkMarkdown } from '../chunker.js';
import { log } from '../logger.js';
import { checkAndRecoverDB } from '../db/corruption-recovery.js';
import { incrementCounter } from '../metrics.js';
import { applyPragmas, applySchema, runMigrations, initStatements } from './schema.js';
import { makeVectorMethods } from './vectors.js';
import { makeGraphMethods } from './graph.js';
import { makeCacheMethods, setLastCorruptionRecovery } from './cache.js';
import { makeDocumentMethods, sanitizeFTS5Query } from './documents.js';

export { applyPragmas, openDatabase } from './schema.js';
export { sanitizeFTS5Query } from './documents.js';
export { getLastCorruptionRecovery, clearCorruptionRecovery } from './cache.js';

const storeCache = new Map<string, Store>();
const storeCacheUncache = new Map<string, () => void>();
const storeCreating = new Set<string>();

export function getCacheSize(): number {
  return storeCache.size;
}

export function evictCachedStore(dbPath: string): void {
  const resolvedPath = path.resolve(dbPath);
  const store = storeCache.get(resolvedPath);
  if (store) {
    storeCache.delete(resolvedPath);
    const uncache = storeCacheUncache.get(resolvedPath);
    if (uncache) { uncache(); storeCacheUncache.delete(resolvedPath); }
    store.close();
  }
}

export function closeAllCachedStores(): void {
  for (const [dbPath, store] of storeCache) {
    log('store', `Closing cached store: ${dbPath}`);
    const uncache = storeCacheUncache.get(dbPath);
    if (uncache) uncache();
    store.close();
  }
  storeCache.clear();
  storeCacheUncache.clear();
}

export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function resolveWorkspaceDbPath(dataDir: string, workspacePath: string): string {
  const dirName = path.basename(workspacePath).replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
  return path.join(dataDir, `${dirName}-${hash}.sqlite`);
}

const projectLabelCache = new Map<string, string>();
let projectLabelDataDir: string | null = null;

export function resolveProjectLabel(projectHash: string, dataDir?: string): string {
  if (projectLabelCache.has(projectHash)) return projectLabelCache.get(projectHash)!;
  const dir = dataDir ?? projectLabelDataDir;
  if (!dir) return projectHash;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.sqlite')) continue;
      const match = file.match(/^(.+)-([a-f0-9]{12})\.sqlite$/);
      if (match && match[2] === projectHash) {
        const label = `${match[1]}(${projectHash})`;
        projectLabelCache.set(projectHash, label);
        return label;
      }
    }
  } catch { }
  projectLabelCache.set(projectHash, projectHash);
  return projectHash;
}

export function setProjectLabelDataDir(dataDir: string): void {
  projectLabelDataDir = dataDir;
}

export function openWorkspaceStore(dataDir: string, workspacePath: string): Store | null {
  const dbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const store = createStore(dbPath);
  const projectHash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 12);
  store.registerWorkspacePrefix(projectHash, workspacePath);
  return store;
}

export function extractProjectHashFromPath(filePath: string, sessionsDir: string): string | undefined {
  if (!filePath || !sessionsDir) return undefined;
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedSessions = sessionsDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalizedFile.startsWith(normalizedSessions + '/')) return undefined;
  const relativePath = normalizedFile.slice(normalizedSessions.length + 1);
  const firstSlash = relativePath.indexOf('/');
  if (firstSlash === -1) return undefined;
  const subdirName = relativePath.slice(0, firstSlash);
  if (subdirName.length !== 12) return undefined;
  if (!/^[a-f0-9]{12}$/i.test(subdirName)) return undefined;
  return subdirName.toLowerCase();
}

export function migrateToRelativePaths(store: Store, projectHash: string, workspaceRoot: string): void {
  const db = store.getDb();
  const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';

  const needsMigration = db.prepare(
    `SELECT COUNT(*) as cnt FROM documents WHERE path LIKE '/%' AND project_hash = ?`
  ).get(projectHash) as { cnt: number };

  if (needsMigration.cnt === 0) {
    return;
  }

  log('store', `Migrating ${needsMigration.cnt} documents from absolute to relative paths (prefix=${prefix})`);

  const migrate = db.transaction(() => {
    const docDupResult = db.prepare(`
      DELETE FROM documents WHERE id IN (
        SELECT abs.id FROM documents abs
        INNER JOIN documents rel
          ON rel.collection = abs.collection
          AND rel.path = substr(abs.path, ?)
        WHERE abs.path LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', projectHash);
    if (docDupResult.changes > 0) {
      log('store', `Deleted ${docDupResult.changes} duplicate absolute-path document rows`);
    }

    const docResult = db.prepare(
      `UPDATE documents SET path = substr(path, ?) WHERE path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    log('store', `Migrated ${docResult.changes} document paths`);

    const unmatchedDocs = db.prepare(
      `SELECT path FROM documents WHERE path LIKE '/%' AND project_hash = ? LIMIT 10`
    ).all(projectHash) as Array<{ path: string }>;
    for (const doc of unmatchedDocs) {
      if (doc.path.includes('/.nano-brain/')) continue;
      log('store', `Warning: document path does not match workspace prefix, left unchanged: ${doc.path}`, 'warn');
    }

    db.prepare(`
      DELETE FROM file_edges WHERE rowid IN (
        SELECT abs.rowid FROM file_edges abs
        INNER JOIN file_edges rel
          ON rel.source_path = substr(abs.source_path, ?)
          AND rel.target_path = CASE
            WHEN abs.target_path LIKE ? THEN substr(abs.target_path, ?)
            ELSE abs.target_path
          END
          AND rel.project_hash = abs.project_hash
        WHERE abs.source_path LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', prefix.length + 1, prefix + '%', projectHash);

    db.prepare(
      `UPDATE file_edges SET source_path = substr(source_path, ?) WHERE source_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE file_edges SET target_path = substr(target_path, ?) WHERE target_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(`
      DELETE FROM symbols WHERE id IN (
        SELECT abs.id FROM symbols abs
        INNER JOIN symbols rel
          ON rel.type = abs.type
          AND rel.pattern = abs.pattern
          AND rel.operation = abs.operation
          AND rel.repo = abs.repo
          AND rel.file_path = substr(abs.file_path, ?)
          AND rel.line_number IS abs.line_number
        WHERE abs.file_path LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(
      `UPDATE symbols SET file_path = substr(file_path, ?) WHERE file_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(`
      DELETE FROM code_symbols WHERE id IN (
        SELECT abs.id FROM code_symbols abs
        INNER JOIN code_symbols rel
          ON rel.name = abs.name
          AND rel.kind = abs.kind
          AND rel.file_path = substr(abs.file_path, ?)
          AND rel.start_line = abs.start_line
          AND rel.end_line = abs.end_line
          AND rel.project_hash = abs.project_hash
        WHERE abs.file_path LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(
      `UPDATE code_symbols SET file_path = substr(file_path, ?) WHERE file_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(`
      DELETE FROM doc_flows WHERE id IN (
        SELECT abs.id FROM doc_flows abs
        INNER JOIN doc_flows rel
          ON rel.label = abs.label
          AND rel.flow_type = abs.flow_type
          AND rel.source_file = substr(abs.source_file, ?)
          AND rel.project_hash = abs.project_hash
        WHERE abs.source_file LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', projectHash);

    db.prepare(
      `UPDATE doc_flows SET source_file = substr(source_file, ?) WHERE source_file LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);

    db.exec(`DELETE FROM documents_fts`);
    db.exec(`
      INSERT INTO documents_fts(filepath, title, body)
      SELECT d.collection || '/' || d.path, d.title, c.body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.active = 1
    `);

    log('store', 'FTS index rebuilt with relative paths');
  });

  migrate();
  log('store', 'Migration to relative paths complete');
}

export function cleanupDuplicatePaths(store: Store, projectHash: string, workspaceRoot: string): void {
  const db = store.getDb();
  const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';

  const absCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM documents WHERE path LIKE '/%' AND project_hash = ?`
  ).get(projectHash) as { cnt: number };

  if (absCount.cnt === 0) {
    return;
  }

  log('store', `Cleaning up ${absCount.cnt} absolute-path rows in documents table`);

  const cleanup = db.transaction(() => {
    const docResult = db.prepare(`
      DELETE FROM documents WHERE id IN (
        SELECT abs.id FROM documents abs
        INNER JOIN documents rel
          ON rel.collection = abs.collection
          AND rel.path = substr(abs.path, ?)
          AND rel.path NOT LIKE '/%'
        WHERE abs.path LIKE ? AND abs.project_hash = ?
      )
    `).run(prefix.length + 1, prefix + '%', projectHash);
    if (docResult.changes > 0) {
      log('store', `Cleaned up ${docResult.changes} duplicate document rows`);
    }

    db.prepare(`
      DELETE FROM file_edges WHERE rowid IN (
        SELECT abs.rowid FROM file_edges abs
        WHERE abs.source_path LIKE ? AND abs.project_hash = ?
        AND EXISTS (
          SELECT 1 FROM file_edges rel
          WHERE rel.source_path = substr(abs.source_path, ?)
            AND rel.target_path = CASE
              WHEN abs.target_path LIKE ? THEN substr(abs.target_path, ?)
              ELSE abs.target_path
            END
            AND rel.project_hash = abs.project_hash
        )
      )
    `).run(prefix + '%', projectHash, prefix.length + 1, prefix + '%', prefix.length + 1);

    db.prepare(`
      DELETE FROM symbols WHERE id IN (
        SELECT abs.id FROM symbols abs
        WHERE abs.file_path LIKE ? AND abs.project_hash = ?
        AND EXISTS (
          SELECT 1 FROM symbols rel
          WHERE rel.type = abs.type
            AND rel.pattern = abs.pattern
            AND rel.operation = abs.operation
            AND rel.repo = abs.repo
            AND rel.file_path = substr(abs.file_path, ?)
            AND rel.line_number IS abs.line_number
        )
      )
    `).run(prefix + '%', projectHash, prefix.length + 1);

    db.prepare(`
      DELETE FROM code_symbols WHERE id IN (
        SELECT abs.id FROM code_symbols abs
        WHERE abs.file_path LIKE ? AND abs.project_hash = ?
        AND EXISTS (
          SELECT 1 FROM code_symbols rel
          WHERE rel.name = abs.name
            AND rel.kind = abs.kind
            AND rel.file_path = substr(abs.file_path, ?)
            AND rel.start_line = abs.start_line
            AND rel.end_line = abs.end_line
            AND rel.project_hash = abs.project_hash
        )
      )
    `).run(prefix + '%', projectHash, prefix.length + 1);

    db.prepare(`
      DELETE FROM doc_flows WHERE id IN (
        SELECT abs.id FROM doc_flows abs
        WHERE abs.source_file LIKE ? AND abs.project_hash = ?
        AND EXISTS (
          SELECT 1 FROM doc_flows rel
          WHERE rel.label = abs.label
            AND rel.flow_type = abs.flow_type
            AND rel.source_file = substr(abs.source_file, ?)
            AND rel.project_hash = abs.project_hash
        )
      )
    `).run(prefix + '%', projectHash, prefix.length + 1);

    db.prepare(
      `UPDATE documents SET path = substr(path, ?) WHERE path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE file_edges SET source_path = substr(source_path, ?) WHERE source_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE file_edges SET target_path = substr(target_path, ?) WHERE target_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE symbols SET file_path = substr(file_path, ?) WHERE file_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE code_symbols SET file_path = substr(file_path, ?) WHERE file_path LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);
    db.prepare(
      `UPDATE doc_flows SET source_file = substr(source_file, ?) WHERE source_file LIKE ? AND project_hash = ?`
    ).run(prefix.length + 1, prefix + '%', projectHash);

    db.exec(`DELETE FROM documents_fts`);
    db.exec(`
      INSERT INTO documents_fts(filepath, title, body)
      SELECT d.collection || '/' || d.path, d.title, c.body
      FROM documents d
      JOIN content c ON c.hash = d.hash
      WHERE d.active = 1
    `);

    log('store', 'Duplicate path cleanup complete, FTS rebuilt');
  });

  cleanup();
}

export function indexDocument(
  store: Store,
  collection: string,
  filePath: string,
  content: string,
  title: string,
  projectHash?: string
): { hash: string; chunks: number; skipped: boolean } {
  const hash = computeHash(content);

  const existingDoc = store.findDocument(filePath);
  if (existingDoc && existingDoc.hash === hash) {
    return { hash, chunks: 0, skipped: true };
  }

  if (existingDoc && existingDoc.hash !== hash) {
    store.cleanupVectorsForHash(existingDoc.hash);
  }

  store.insertContent(hash, content);

  const chunks = chunkMarkdown(content, hash);

  const now = new Date().toISOString();
  store.insertDocument({
    collection,
    path: filePath,
    title,
    hash,
    createdAt: existingDoc?.createdAt ?? now,
    modifiedAt: now,
    active: true,
    projectHash,
  });

  return { hash, chunks: chunks.length, skipped: false };
}

export function createStore(dbPath: string): Store {
  const resolvedPath = path.resolve(dbPath);

  const cached = storeCache.get(resolvedPath);
  if (cached) {
    return cached;
  }

  if (storeCreating.has(resolvedPath)) {
    log('store', 'createStore already in progress for ' + resolvedPath + ', waiting...', 'warn');
    const nowCached = storeCache.get(resolvedPath);
    if (nowCached) return nowCached;
  }
  storeCreating.add(resolvedPath);

  try {

  log('store', 'createStore dbPath=' + resolvedPath);

  const recoveryResult = checkAndRecoverDB(resolvedPath, {
    logger: { log, error: (msg: string) => log('store', msg, 'error') },
    metricsCallback: (event: string) => {
      if (event === 'corruption_detected') {
        incrementCounter('database_corruption_detected');
      }
    }
  });

  const db = recoveryResult.db;
  if (recoveryResult.recovered) {
    setLastCorruptionRecovery(recoveryResult);
    log('store', `Database recovered from corruption at ${recoveryResult.recoveredAt}`);
  }

  applyPragmas(db);

  let vecAvailable = false;
  let vectorStore: VectorStore | null = null;

  try {
    sqliteVec.load(db);
    vecAvailable = true;
  } catch {
    log('store', 'sqlite-vec extension not available, vector search disabled', 'warn');
  }

  applySchema(db);
  runMigrations(db);

  const stmts = initStatements(db);

  const sharedState = {
    workspaceRoot: null as string | null,
    vecAvailable,
    get vectorStore() { return vectorStore; },
    set vectorStore(vs: VectorStore | null) { vectorStore = vs; },
  };

  const vecMethods = makeVectorMethods(db, stmts, sharedState);
  const graphMethods = makeGraphMethods(db, stmts, sharedState);
  const cacheMethods = makeCacheMethods(db, stmts);
  const docMethods = makeDocumentMethods(db, stmts, sharedState);

  let _cached = false;

  const store: Store = {
    modelStatus: {
      embedding: 'missing',
      reranker: 'missing',
      expander: 'missing',
    },

    getDb() {
      return db;
    },

    close() {
      if (_cached) {
        return;
      }
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { }
      db.close();
    },

    registerWorkspacePrefix: docMethods.registerWorkspacePrefix.bind(docMethods),
    getWorkspaceRoot: docMethods.getWorkspaceRoot.bind(docMethods),
    toRelative: docMethods.toRelative.bind(docMethods),
    resolvePath: docMethods.resolvePath.bind(docMethods),
    insertContent: docMethods.insertContent.bind(docMethods),
    insertDocument: docMethods.insertDocument.bind(docMethods),
    findDocument: docMethods.findDocument.bind(docMethods),
    getDocumentBody: docMethods.getDocumentBody.bind(docMethods),
    deactivateDocument: docMethods.deactivateDocument.bind(docMethods),
    bulkDeactivateExcept: docMethods.bulkDeactivateExcept.bind(docMethods),
    supersedeDocument: docMethods.supersedeDocument.bind(docMethods),
    deleteDocumentsByPath: docMethods.deleteDocumentsByPath.bind(docMethods),
    searchFTS: docMethods.searchFTS.bind(docMethods),
    getWorkspaceStats: docMethods.getWorkspaceStats.bind(docMethods),
    getCollectionStorageSize: docMethods.getCollectionStorageSize.bind(docMethods),
    removeWorkspace: docMethods.removeWorkspace.bind(docMethods),
    clearWorkspace: docMethods.clearWorkspace.bind(docMethods),

    setVectorStore: vecMethods.setVectorStore.bind(vecMethods),
    getVectorStore: vecMethods.getVectorStore.bind(vecMethods),
    insertEmbeddingLocal: vecMethods.insertEmbeddingLocal.bind(vecMethods),
    insertEmbeddingLocalBatch: vecMethods.insertEmbeddingLocalBatch.bind(vecMethods),
    insertEmbedding: vecMethods.insertEmbedding.bind(vecMethods),
    ensureVecTable: vecMethods.ensureVecTable.bind(vecMethods),
    searchVec: vecMethods.searchVec.bind(vecMethods),
    searchVecAsync: vecMethods.searchVecAsync.bind(vecMethods),
    cleanupVectorsForHash: vecMethods.cleanupVectorsForHash.bind(vecMethods),
    cleanOrphanedEmbeddings: vecMethods.cleanOrphanedEmbeddings.bind(vecMethods),
    getSqliteVecCount: vecMethods.getSqliteVecCount.bind(vecMethods),
    getHashesNeedingEmbedding: vecMethods.getHashesNeedingEmbedding.bind(vecMethods),
    getNextHashNeedingEmbedding: vecMethods.getNextHashNeedingEmbedding.bind(vecMethods),

    getCachedResult: cacheMethods.getCachedResult.bind(cacheMethods),
    setCachedResult: cacheMethods.setCachedResult.bind(cacheMethods),
    getCacheStats: cacheMethods.getCacheStats.bind(cacheMethods),
    clearCache: cacheMethods.clearCache.bind(cacheMethods),
    logSearchQuery: cacheMethods.logSearchQuery.bind(cacheMethods),
    getTelemetryStats: cacheMethods.getTelemetryStats.bind(cacheMethods),
    recordTokenUsage: cacheMethods.recordTokenUsage.bind(cacheMethods),
    enqueueConsolidation: cacheMethods.enqueueConsolidation.bind(cacheMethods),
    getNextPendingJob: cacheMethods.getNextPendingJob.bind(cacheMethods),
    updateJobStatus: cacheMethods.updateJobStatus.bind(cacheMethods),
    getRecentConsolidationLogs: cacheMethods.getRecentConsolidationLogs.bind(cacheMethods),

    insertFileEdge: graphMethods.insertFileEdge.bind(graphMethods),
    deleteFileEdges: graphMethods.deleteFileEdges.bind(graphMethods),
    getFileEdges: graphMethods.getFileEdges.bind(graphMethods),
    getFileDependencies: graphMethods.getFileDependencies.bind(graphMethods),
    getFileDependents: graphMethods.getFileDependents.bind(graphMethods),
    updateCentralityScores: graphMethods.updateCentralityScores.bind(graphMethods),
    updateClusterIds: graphMethods.updateClusterIds.bind(graphMethods),
    getEdgeSetHash: graphMethods.getEdgeSetHash.bind(graphMethods),
    setEdgeSetHash: graphMethods.setEdgeSetHash.bind(graphMethods),
    getDocumentCentrality: graphMethods.getDocumentCentrality.bind(graphMethods),
    getClusterMembers: graphMethods.getClusterMembers.bind(graphMethods),
    getGraphStats: graphMethods.getGraphStats.bind(graphMethods),
    insertSymbol: graphMethods.insertSymbol.bind(graphMethods),
    deleteSymbols: graphMethods.deleteSymbols.bind(graphMethods),
    querySymbols: graphMethods.querySymbols.bind(graphMethods),
    getSymbolImpact: graphMethods.getSymbolImpact.bind(graphMethods),
    getInfrastructureSymbols: graphMethods.getInfrastructureSymbols.bind(graphMethods),
    getSymbolsForProject: graphMethods.getSymbolsForProject.bind(graphMethods),
    getSymbolEdgesForProject: graphMethods.getSymbolEdgesForProject.bind(graphMethods),
    getSymbolClusters: graphMethods.getSymbolClusters.bind(graphMethods),
    getFlowsWithSteps: graphMethods.getFlowsWithSteps.bind(graphMethods),
    getFlowSteps: graphMethods.getFlowSteps.bind(graphMethods),
    getDocFlows: graphMethods.getDocFlows.bind(graphMethods),
    upsertDocFlow: graphMethods.upsertDocFlow.bind(graphMethods),
    deleteDocFlowsByProject: graphMethods.deleteDocFlowsByProject.bind(graphMethods),
    getAllConnections: graphMethods.getAllConnections.bind(graphMethods),
    insertOrUpdateEntity: graphMethods.insertOrUpdateEntity.bind(graphMethods),
    getMemoryEntities: graphMethods.getMemoryEntities.bind(graphMethods),
    deleteEntity: graphMethods.deleteEntity.bind(graphMethods),
    insertEdge: graphMethods.insertEdge.bind(graphMethods),
    getEntityEdges: graphMethods.getEntityEdges.bind(graphMethods),
    getEntityById: graphMethods.getEntityById.bind(graphMethods),
    getEntityByName: graphMethods.getEntityByName.bind(graphMethods),
    markEntityContradicted: graphMethods.markEntityContradicted.bind(graphMethods),
    confirmEntity: graphMethods.confirmEntity.bind(graphMethods),
    getMemoryEntityCount: graphMethods.getMemoryEntityCount.bind(graphMethods),
    getContradictedEntitiesForPruning: graphMethods.getContradictedEntitiesForPruning.bind(graphMethods),
    getOrphanEntitiesForPruning: graphMethods.getOrphanEntitiesForPruning.bind(graphMethods),
    getPrunedEntitiesForHardDelete: graphMethods.getPrunedEntitiesForHardDelete.bind(graphMethods),
    softDeleteEntities: graphMethods.softDeleteEntities.bind(graphMethods),
    hardDeleteEntities: graphMethods.hardDeleteEntities.bind(graphMethods),
    getActiveEntitiesByTypeAndProject: graphMethods.getActiveEntitiesByTypeAndProject.bind(graphMethods),
    getEntityEdgeCount: graphMethods.getEntityEdgeCount.bind(graphMethods),
    redirectEntityEdges: graphMethods.redirectEntityEdges.bind(graphMethods),
    deduplicateEdges: graphMethods.deduplicateEdges.bind(graphMethods),

    getQueryEmbeddingCache(query: string): number[] | null {
      const key = computeHash('qembed:' + query);
      const cached = stmts.getCachedResult.get(key, 'global') as { result: string } | undefined;
      if (!cached) return null;
      try {
        return JSON.parse(cached.result) as number[];
      } catch {
        return null;
      }
    },

    setQueryEmbeddingCache(query: string, embedding: number[]) {
      const key = computeHash('qembed:' + query);
      stmts.setCachedResult.run(key, 'global', 'qembed', JSON.stringify(embedding));
    },

    clearQueryEmbeddingCache() {
      db.exec("DELETE FROM llm_cache WHERE type = 'qembed'");
    },

    getIndexHealth(): IndexHealth {
      const snapshot = db.transaction(() => {
        const docCount = (stmts.getDocumentCount.get() as { count: number }).count;
        const embeddedCount = (stmts.getEmbeddedCount.get() as { count: number }).count;
        const collections = stmts.getCollectionStats.all() as Array<{ name: string; documentCount: number; path: string }>;
        const pending = (stmts.getPendingEmbeddingCount.get() as { count: number }).count;
        const workspaceStats = store.getWorkspaceStats();
        const extractedFactCount = (stmts.getExtractedFactCount.get() as { count: number }).count;
        return { docCount, embeddedCount, collections, pending, workspaceStats, extractedFactCount };
      });

      const { docCount, embeddedCount, collections, pending, workspaceStats, extractedFactCount } = snapshot();

      let dbSize = 0;
      try {
        const stats = fs.statSync(dbPath);
        dbSize = stats.size;
      } catch {
      }

      return {
        documentCount: docCount,
        embeddedCount: embeddedCount,
        pendingEmbeddings: pending,
        collections: collections,
        databaseSize: dbSize,
        modelStatus: store.modelStatus,
        workspaceStats: workspaceStats,
        extractedFacts: extractedFactCount,
      };
    },

    insertTags(documentId: number, tags: string[]) {
      const insertTagStmt = db.prepare(`INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)`);
      const uniqueTags = [...new Set(tags.map(t => t.toLowerCase().trim()).filter(t => t.length > 0))];
      for (const tag of uniqueTags) {
        insertTagStmt.run(documentId, tag);
      }
    },

    getDocumentTags(documentId: number): string[] {
      const rows = db.prepare(`SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag`).all(documentId) as Array<{ tag: string }>;
      return rows.map(r => r.tag);
    },

    listAllTags(): Array<{ tag: string; count: number }> {
      return db.prepare(`
        SELECT tag, COUNT(*) as count
        FROM document_tags
        GROUP BY tag
        ORDER BY count DESC, tag ASC
      `).all() as Array<{ tag: string; count: number }>;
    },

    getTokenUsage() {
      return stmts.getTokenUsage.all() as Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>;
    },

    logSearchExpand(cacheKey: string, expandedIndices: number[]) {
      try {
        stmts.updateTelemetryExpand.run(JSON.stringify(expandedIndices), cacheKey);
      } catch (err) {
        log('store', `Failed to log expand: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getRecentQueries(sessionId: string): Array<{ id: number; query_text: string; timestamp: string }> {
      return stmts.getRecentQueries.all(sessionId) as Array<{ id: number; query_text: string; timestamp: string }>;
    },

    getConfigVariantByCacheKey(cacheKey: string): string | null {
      const row = stmts.getConfigVariantByCacheKey.get(cacheKey) as { config_variant: string | null } | undefined;
      return row?.config_variant ?? null;
    },

    getConfigVariantById(telemetryId: number): string | null {
      const row = stmts.getConfigVariantById.get(telemetryId) as { config_variant: string | null } | undefined;
      return row?.config_variant ?? null;
    },

    markReformulation(telemetryId: number) {
      try {
        stmts.updateTelemetryReformulation.run(telemetryId);
      } catch (err) {
        log('store', `Failed to mark reformulation: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    purgeTelemetry(retentionDays: number): number {
      const result = stmts.purgeTelemetry.run(retentionDays);
      return result.changes;
    },

    getTelemetryCount(): number {
      return (stmts.getTelemetryCount.get() as { count: number }).count;
    },

    saveBanditStats(stats: Array<{ parameterName: string; variantValue: number; successes: number; failures: number }>, workspaceHash: string) {
      for (const s of stats) {
        try {
          stmts.upsertBandit.run(s.parameterName, s.variantValue, s.successes, s.failures, workspaceHash);
        } catch (err) {
          log('store', `Failed to save bandit stats: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        }
      }
    },

    loadBanditStats(workspaceHash: string): Array<{ parameter_name: string; variant_value: number; successes: number; failures: number }> {
      return stmts.getBanditStats.all(workspaceHash) as Array<{ parameter_name: string; variant_value: number; successes: number; failures: number }>;
    },

    saveConfigVersion(configJson: string, expandRate: number | null): number {
      try {
        const result = stmts.insertConfigVersion.run(configJson, expandRate);
        return Number(result.lastInsertRowid);
      } catch (err) {
        log('store', `Failed to save config version: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return 0;
      }
    },

    getLatestConfigVersion(): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null {
      return stmts.getLatestConfigVersion.get() as { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;
    },

    getConfigVersion(versionId: number): { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null {
      return stmts.getConfigVersion.get(versionId) as { version_id: number; config_json: string; expand_rate: number | null; created_at: string } | null;
    },

    getWorkspaceProfile(workspaceHash: string): { workspace_hash: string; profile_data: string; updated_at: string } | null {
      return stmts.getWorkspaceProfile.get(workspaceHash) as { workspace_hash: string; profile_data: string; updated_at: string } | null;
    },

    saveWorkspaceProfile(workspaceHash: string, profileData: string): void {
      stmts.upsertWorkspaceProfile.run(workspaceHash, profileData);
    },

    saveGlobalLearning(parameterName: string, value: number, confidence: number): void {
      stmts.upsertGlobalLearning.run(parameterName, value, confidence);
    },

    getGlobalLearning(): Array<{ parameter_name: string; value: number; confidence: number }> {
      return stmts.getGlobalLearning.all() as Array<{ parameter_name: string; value: number; confidence: number }>;
    },

    getTelemetryTopKeywords(workspaceHash: string, limit: number): Array<{ keyword: string; count: number }> {
      const rows = stmts.getTelemetryQueryTexts.all(workspaceHash) as Array<{ query_text: string }>;
      const stopwords = new Set([
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below', 'between',
        'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
        'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
        'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
        'you', 'your', 'yours', 'yourself', 'yourselves',
        'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
        'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'am', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'all', 'any',
        'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
      ]);
      const keywordCounts = new Map<string, number>();
      for (const row of rows) {
        const tokens = row.query_text.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !stopwords.has(t));
        for (const token of tokens) {
          keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
        }
      }
      const sorted = [...keywordCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([keyword, count]) => ({ keyword, count }));
      return sorted;
    },

    insertChainMembership(chainId: string, queryId: string, position: number, workspaceHash: string): void {
      try {
        stmts.insertChainMembership.run(chainId, queryId, position, workspaceHash);
      } catch (err) {
        log('store', `Failed to insert chain membership: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getChainsByWorkspace(workspaceHash: string, limit: number): Array<{ chain_id: string; query_id: string; position: number }> {
      return stmts.getChainsByWorkspace.all(workspaceHash, limit) as Array<{ chain_id: string; query_id: string; position: number }>;
    },

    getRecentTelemetryQueries(workspaceHash: string, limit: number): Array<{ id: number; query_id: string; query_text: string; timestamp: string; session_id: string }> {
      return stmts.getRecentTelemetryQueries.all(workspaceHash, limit) as Array<{ id: number; query_id: string; query_text: string; timestamp: string; session_id: string }>;
    },

    upsertQueryCluster(clusterId: number, centroidEmbedding: string, representativeQuery: string, queryCount: number, workspaceHash: string): void {
      try {
        stmts.upsertQueryCluster.run(clusterId, centroidEmbedding, representativeQuery, queryCount, workspaceHash);
      } catch (err) {
        log('store', `Failed to upsert query cluster: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getQueryClusters(workspaceHash: string): Array<{ cluster_id: number; centroid_embedding: string; representative_query: string; query_count: number }> {
      return stmts.getQueryClusters.all(workspaceHash) as Array<{ cluster_id: number; centroid_embedding: string; representative_query: string; query_count: number }>;
    },

    clearQueryClusters(workspaceHash: string): void {
      stmts.clearQueryClusters.run(workspaceHash);
    },

    upsertClusterTransition(fromId: number, toId: number, frequency: number, probability: number, workspaceHash: string): void {
      try {
        stmts.upsertClusterTransition.run(fromId, toId, frequency, probability, workspaceHash);
      } catch (err) {
        log('store', `Failed to upsert cluster transition: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getClusterTransitions(workspaceHash: string): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }> {
      return stmts.getClusterTransitions.all(workspaceHash) as Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
    },

    getTransitionsFrom(fromClusterId: number, workspaceHash: string, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }> {
      return stmts.getTransitionsFrom.all(fromClusterId, workspaceHash, limit) as Array<{ to_cluster_id: number; frequency: number; probability: number }>;
    },

    clearClusterTransitions(workspaceHash: string): void {
      stmts.clearClusterTransitions.run(workspaceHash);
    },

    upsertGlobalTransition(fromId: number, toId: number, frequency: number, probability: number): void {
      try {
        stmts.upsertGlobalTransition.run(fromId, toId, frequency, probability);
      } catch (err) {
        log('store', `Failed to upsert global transition: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getGlobalTransitions(): Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }> {
      return stmts.getGlobalTransitions.all() as Array<{ from_cluster_id: number; to_cluster_id: number; frequency: number; probability: number }>;
    },

    getGlobalTransitionsFrom(fromClusterId: number, limit: number): Array<{ to_cluster_id: number; frequency: number; probability: number }> {
      return stmts.getGlobalTransitionsFrom.all(fromClusterId, limit) as Array<{ to_cluster_id: number; frequency: number; probability: number }>;
    },

    clearGlobalTransitions(): void {
      stmts.clearGlobalTransitions.run();
    },

    recordSuggestionFeedback(suggestedQuery: string, actualQuery: string, matchType: string, workspaceHash: string): void {
      try {
        stmts.insertSuggestionFeedback.run(suggestedQuery, actualQuery, matchType, workspaceHash);
      } catch (err) {
        log('store', `Failed to record suggestion feedback: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getSuggestionAccuracy(workspaceHash: string): { total: number; exact: number; partial: number; none: number } {
      const row = stmts.getSuggestionAccuracy.get(workspaceHash) as { total: number; exact: number; partial: number; none: number } | undefined;
      return {
        total: row?.total ?? 0,
        exact: row?.exact ?? 0,
        partial: row?.partial ?? 0,
        none: row?.none ?? 0,
      };
    },

    getQueueStats(): { pending: number; processing: number; completed: number; failed: number } {
      const row = stmts.getQueueStats.get() as { pending: number | null; processing: number | null; completed: number | null; failed: number | null } | undefined;
      return {
        pending: row?.pending ?? 0,
        processing: row?.processing ?? 0,
        completed: row?.completed ?? 0,
        failed: row?.failed ?? 0,
      };
    },

    addConsolidationLog(entry: { documentId: number; action: string; reason: string; targetDocId?: number; model: string; tokensUsed: number }): void {
      try {
        stmts.addConsolidationLog.run(
          entry.documentId,
          entry.action,
          entry.reason,
          entry.targetDocId ?? null,
          entry.model,
          entry.tokensUsed
        );
      } catch (err) {
        log('store', `Failed to add consolidation log: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    trackAccess(docIds: number[]): void {
      if (docIds.length === 0) return;
      try {
        const placeholders = docIds.map(() => '?').join(',');
        const sql = `UPDATE documents SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id IN (${placeholders})`;
        db.prepare(sql).run(...docIds);
      } catch (err) {
        log('store', `Failed to track access: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    },

    getTopAccessedDocuments(limit: number, projectHash?: string): Array<{ id: number; path: string; collection: string; title: string; hash: string; access_count: number; last_accessed_at: string }> {
      try {
        if (projectHash && projectHash !== 'all') {
          return stmts.getTopAccessedDocuments.all(projectHash, limit) as Array<{ id: number; path: string; collection: string; title: string; hash: string; access_count: number; last_accessed_at: string }>;
        }
        return stmts.getTopAccessedDocumentsAll.all(limit) as Array<{ id: number; path: string; collection: string; title: string; hash: string; access_count: number; last_accessed_at: string }>;
      } catch (err) {
        log('store', `getTopAccessedDocuments failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return [];
      }
    },

    getRecentDocumentsByTags(tags: string[], limit: number, projectHash?: string): Array<{ id: number; path: string; collection: string; title: string; hash: string; modified_at: string }> {
      if (tags.length === 0) return [];
      try {
        const tagPlaceholders = tags.map(() => '?').join(',');
        let sql: string;
        let params: any[];
        if (projectHash && projectHash !== 'all') {
          sql = `SELECT d.id, d.path, d.collection, d.title, d.hash, d.modified_at
            FROM documents d
            JOIN document_tags dt ON dt.document_id = d.id
            WHERE d.active = 1 AND d.superseded_by IS NULL
              AND dt.tag IN (${tagPlaceholders})
              AND d.project_hash IN (?, 'global')
            GROUP BY d.id
            ORDER BY d.modified_at DESC
            LIMIT ?`;
          params = [...tags, projectHash, limit];
        } else {
          sql = `SELECT d.id, d.path, d.collection, d.title, d.hash, d.modified_at
            FROM documents d
            JOIN document_tags dt ON dt.document_id = d.id
            WHERE d.active = 1 AND d.superseded_by IS NULL
              AND dt.tag IN (${tagPlaceholders})
            GROUP BY d.id
            ORDER BY d.modified_at DESC
            LIMIT ?`;
          params = [...tags, limit];
        }
        return db.prepare(sql).all(...params) as Array<{ id: number; path: string; collection: string; title: string; hash: string; modified_at: string }>;
      } catch (err) {
        log('store', `getRecentDocumentsByTags failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
        return [];
      }
    },

    getUncategorizedDocuments(limit: number, projectHash?: string): Array<{ id: number; path: string; body: string }> {
      let sql = `
        SELECT d.id, d.path, c.body
        FROM documents d
        JOIN content c ON d.hash = c.hash
        WHERE d.active = 1
        AND d.id NOT IN (
          SELECT document_id FROM document_tags WHERE tag LIKE 'llm:%'
        )
      `;
      const params: (string | number)[] = [];
      if (projectHash && projectHash !== 'all') {
        sql += ` AND d.project_hash IN (?, 'global')`;
        params.push(projectHash);
      }
      sql += ` ORDER BY d.modified_at DESC LIMIT ?`;
      params.push(limit);
      return db.prepare(sql).all(...params) as Array<{ id: number; path: string; body: string }>;
    },

    insertConnection(conn) {
      const result = stmts.insertConnection.run(
        conn.fromDocId, conn.toDocId, conn.relationshipType,
        conn.description ?? null, conn.strength, conn.createdBy, conn.projectHash
      );
      return Number(result.lastInsertRowid);
    },

    getConnectionsForDocument(docId, options) {
      const dir = options?.direction ?? 'both';
      const relType = options?.relationshipType;
      let rows: any[];
      if (relType) {
        rows = stmts.getConnectionsByType.all(docId, docId, relType);
      } else if (dir === 'outgoing') {
        rows = stmts.getConnectionsFrom.all(docId);
      } else if (dir === 'incoming') {
        rows = stmts.getConnectionsTo.all(docId);
      } else {
        rows = stmts.getConnectionsBoth.all(docId, docId);
      }
      return rows.map((r: any) => ({
        id: r.id,
        fromDocId: r.from_doc_id,
        toDocId: r.to_doc_id,
        relationshipType: r.relationship_type,
        description: r.description,
        strength: r.strength,
        createdBy: r.created_by,
        createdAt: r.created_at,
        projectHash: r.project_hash,
      }));
    },

    deleteConnection(id) {
      stmts.deleteConnection.run(id);
    },

    getConnectionCount(docId) {
      const row = stmts.getConnectionCount.get(docId, docId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    },

    getActiveDocumentsWithAccess(): Array<{ id: number; path: string; hash: string; access_count: number; last_accessed_at: string | null }> {
      return stmts.getActiveDocumentsWithAccess.all() as Array<{ id: number; path: string; hash: string; access_count: number; last_accessed_at: string | null }>;
    },

    getTagCountForDocument(docId: number): number {
      const row = stmts.getTagCountForDocument.get(docId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    },
  };

  _cached = true;
  storeCache.set(resolvedPath, store);
  storeCacheUncache.set(resolvedPath, () => { _cached = false; });
  storeCreating.delete(resolvedPath);

  return store;

  } finally {
    storeCreating.delete(resolvedPath);
  }
}
