import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server/types.js';
import { log } from '../logger.js';
import { sequentialFileAppend } from '../server/utils.js';
import { hybridSearch } from '../search.js';
import { generateBriefing } from '../wake-up.js';
import { indexCodebase, embedPendingCodebase } from '../codebase.js';
import { getLastCorruptionRecovery } from '../store.js';
import { isFTSWorkerReady, searchFTSAsync } from '../fts-client.js';
import { resolveWorkspaceDbPath, openDatabase } from '../store.js';
import type { SqliteEventStore } from '../event-store.js';
import { sseSessions, handleSseConnect, handleSseMessage } from './sse.js';
import { createMcpServer } from '../mcp/index.js';
import { getWorkspaceConfig, loadCollectionConfig } from '../collections.js';

export interface HttpContext {
  deps: ServerDeps;
  mcpServer: McpServer;
  streamableSessions: Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>;
  maintenanceModeRef: { value: boolean };
  maintenanceTimerRef: { value: NodeJS.Timeout | null };
  startFileWatcher: () => void;
  watcherRef: { value: { stop: () => void } | null };
  watcherStartedRef: { value: boolean };
  readyState: { value: boolean };
  resolvedWorkspaceRoot: string;
  currentProjectHash: string;
  outputDir: string;
  effectiveDbPath: string;
  finalConfigPath: string;
  symbolGraphDb: import('better-sqlite3').Database;
  eventStore: SqliteEventStore;
}

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: HttpContext
): Promise<void> {
  const { deps, streamableSessions, maintenanceModeRef, maintenanceTimerRef, startFileWatcher, watcherRef, watcherStartedRef, readyState, resolvedWorkspaceRoot, currentProjectHash, outputDir, effectiveDbPath, finalConfigPath, symbolGraphDb, eventStore } = ctx;
  const { store, providers } = deps;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (maintenanceModeRef.value && pathname !== '/api/maintenance/resume' && pathname !== '/health' && pathname !== '/api/maintenance/prepare') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'maintenance in progress' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    let version = 'unknown';
    try {
      const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    } catch {}
    const recovery = getLastCorruptionRecovery();
    const healthResponse: Record<string, unknown> = {
      status: 'ok',
      ready: readyState.value,
      version,
      uptime: process.uptime(),
      sessions: { sse: sseSessions.size, streamable: streamableSessions.size }
    };
    if (recovery?.recovered) {
      healthResponse.corruption_recovered = true;
      healthResponse.recovered_at = recovery.recoveredAt;
      healthResponse.corrupted_path = recovery.corruptedPath;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthResponse));
    return;
  }

  if (req.method === 'GET' && pathname === '/sse') {
    const clientServer = createMcpServer(deps);
    await handleSseConnect(req, res, clientServer);
    return;
  }

  if (req.method === 'POST' && pathname === '/messages') {
    await handleSseMessage(req, res, url);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    let indexHealth: any = null;
    let indexError: string | undefined;
    try {
      indexHealth = store.getIndexHealth();
    } catch (e) {
      indexError = e instanceof Error ? e.message : String(e);
      log('server', `getIndexHealth failed: ${indexError}`);
    }
    const modelStatus = store.modelStatus;
    let statusVersion = 'unknown';
    try {
      const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
      statusVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: indexError ? 'degraded' : 'ok',
      version: statusVersion,
      uptime: process.uptime(),
      ready: readyState.value,
      models: modelStatus,
      index: indexHealth,
      ...(indexError ? { error: indexError } : {}),
      workspace: { root: resolvedWorkspaceRoot, hash: currentProjectHash },
    }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/query') {
    const body = await readBody(req);
    try {
      const { query, tags, scope, limit } = JSON.parse(body);
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query is required' }));
        return;
      }
      const effectiveProjectHash = scope === 'all' ? 'all' : currentProjectHash;
      const parsedTags = tags ? tags.split(',').map((t: string) => t.trim().toLowerCase()).filter((t: string) => t.length > 0) : undefined;
      const QUERY_TIMEOUT_MS = 6000;
      const results = await Promise.race([
        hybridSearch(
          store,
          { query, limit: limit || 10, projectHash: effectiveProjectHash, tags: parsedTags, searchConfig: deps.searchConfig, db: deps.db },
          providers
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Query timed out after ' + QUERY_TIMEOUT_MS + 'ms')), QUERY_TIMEOUT_MS)
        ),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON body';
      const status = message.includes('timed out') ? 504 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/search') {
    const body = await readBody(req);
    try {
      const { query, limit } = JSON.parse(body);
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query is required' }));
        return;
      }
      const safeLimit = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? limit : 10, 100));
      const SEARCH_DEADLINE_MS = 8000;
      const FTS_TIMEOUT_MS = 5000;
      const deadline = new Promise<{ results: import('../types.js').SearchResult[]; timedOut: boolean }>((resolve) => {
        setTimeout(() => resolve({ results: [], timedOut: true }), SEARCH_DEADLINE_MS);
      });
      const doSearch = async (): Promise<{ results: import('../types.js').SearchResult[]; timedOut: boolean }> => {
        if (isFTSWorkerReady()) {
          try {
            const results = await Promise.race([
              searchFTSAsync(query, { limit: safeLimit, projectHash: currentProjectHash }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('__FTS_TIMEOUT__')), FTS_TIMEOUT_MS)
              ),
            ]);
            return { results, timedOut: false };
          } catch (ftsErr: any) {
            log('server', `POST /api/search FTS worker timeout/fail: ${ftsErr?.message}`, 'warn');
          }
        }
        return { results: [], timedOut: false };
      };
      const { results, timedOut } = await Promise.race([doSearch(), deadline]);
      try { store.trackAccess(results.map((r: { id: string | number }) => typeof r.id === 'string' ? parseInt(r.id, 10) : r.id)); } catch { /* non-critical */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, ...(timedOut ? { warning: 'search timed out, try again when indexing completes' } : {}) }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/write') {
    const body = await readBody(req);
    try {
      const { content, tags, workspace } = JSON.parse(body);
      if (!content || !content.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'content is required' }));
        return;
      }
      const date = new Date().toISOString().split('T')[0];
      const memoryDir = path.join(outputDir, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const targetPath = path.join(memoryDir, `${date}.md`);
      const timestamp = new Date().toISOString();
      const workspaceName = path.basename(resolvedWorkspaceRoot);
      const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${currentProjectHash})\n\n${content}\n`;
      sequentialFileAppend(targetPath, entry);
      let tagInfo = '';
      if (tags) {
        const parsedTags = tags.split(',').map((t: string) => t.trim().toLowerCase()).filter((t: string) => t.length > 0);
        if (parsedTags.length > 0) {
          const fileContent = fs.readFileSync(targetPath, 'utf-8');
          const title = path.basename(targetPath, path.extname(targetPath));
          const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
          store.insertContent(hash, fileContent);
          const stats = fs.statSync(targetPath);
          const docId = store.insertDocument({
            collection: 'memory',
            path: targetPath,
            title,
            hash,
            createdAt: stats.birthtime.toISOString(),
            modifiedAt: stats.mtime.toISOString(),
            active: true,
            projectHash: currentProjectHash,
          });
          store.insertTags(docId, parsedTags);
          tagInfo = ` Tags: ${parsedTags.join(', ')}`;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', path: targetPath, message: `Written to ${targetPath}${tagInfo}` }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/wake-up') {
    try {
      const workspace = url.searchParams.get('workspace') || undefined;
      const jsonParam = url.searchParams.get('json') === 'true';
      const limitParam = parseInt(url.searchParams.get('limit') || '10', 10);
      const effectiveProjectHash = workspace
        ? crypto.createHash('sha256').update(workspace).digest('hex').substring(0, 12)
        : currentProjectHash;
      const result = generateBriefing(store, deps.configPath, effectiveProjectHash, {
        limit: limitParam,
        json: jsonParam,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonParam ? result : { formatted: result.formatted }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Wake-up briefing failed' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/wake-up') {
    const body = await readBody(req);
    try {
      const { workspace, json: jsonParam, limit: limitParam } = JSON.parse(body);
      const effectiveProjectHash = workspace
        ? crypto.createHash('sha256').update(workspace).digest('hex').substring(0, 12)
        : currentProjectHash;
      const result = generateBriefing(store, deps.configPath, effectiveProjectHash, {
        limit: typeof limitParam === 'number' ? limitParam : 10,
        json: !!jsonParam,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonParam ? result : { formatted: result.formatted }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/init') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use maintenance endpoints for init operations from container. Run init directly on the host: npx nano-brain init' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/reindex') {
    const body = await readBody(req);
    try {
      const { root } = JSON.parse(body || '{}');
      const effectiveRoot = root || resolvedWorkspaceRoot;
      const effectiveProjectHash = crypto.createHash('sha256').update(effectiveRoot).digest('hex').substring(0, 12);
      const wsConfig = getWorkspaceConfig(loadCollectionConfig(finalConfigPath), effectiveRoot);
      const codebaseConfig = wsConfig?.codebase ?? { enabled: true };
      indexCodebase(store, effectiveRoot, codebaseConfig, effectiveProjectHash, providers.embedder, symbolGraphDb)
        .then((stats) => {
          log('server', `[api/reindex] Reindex complete: ${stats.filesIndexed} indexed, ${stats.filesSkippedUnchanged} unchanged`);
        })
        .catch((err) => {
          log('server', `[api/reindex] Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'started', root: effectiveRoot }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/embed') {
    try {
      if (!providers.embedder) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Embedding provider not available' }));
        return;
      }
      embedPendingCodebase(store, providers.embedder, 50, currentProjectHash)
        .then((embedded) => {
          log('server', `[api/embed] Embedded ${embedded} chunks`);
        })
        .catch((err) => {
          log('server', `[api/embed] Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'started' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Embedding failed' }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/maintenance/prepare') {
    if (maintenanceModeRef.value) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'maintenance already in progress' }));
      return;
    }
    maintenanceModeRef.value = true;
    if (watcherRef.value) {
      watcherRef.value.stop();
      watcherRef.value = null;
    }
    watcherStartedRef.value = false;
    try {
      symbolGraphDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      log('server', 'WAL checkpoint failed during maintenance prepare: ' + (err instanceof Error ? err.message : String(err)));
    }
    maintenanceTimerRef.value = setTimeout(() => {
      if (maintenanceModeRef.value) {
        maintenanceModeRef.value = false;
        startFileWatcher();
        log('server', 'Maintenance auto-resumed after timeout (no resume call received)');
      }
    }, 5 * 60 * 1000);
    log('server', 'Maintenance mode started');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'prepared' }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/maintenance/resume') {
    if (!maintenanceModeRef.value) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no maintenance in progress' }));
      return;
    }
    maintenanceModeRef.value = false;
    if (maintenanceTimerRef.value) {
      clearTimeout(maintenanceTimerRef.value);
      maintenanceTimerRef.value = null;
    }
    startFileWatcher();
    log('server', 'Maintenance mode ended');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'resumed' }));
    return;
  }

  if (req.url?.startsWith('/api/v1/') || req.url?.startsWith('/web/') || req.url === '/web') {
    const origin = req.headers.origin;
    if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (req.url?.startsWith('/web/') || req.url === '/web') {
    const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
    let filePath = req.url === '/web' || req.url === '/web/'
      ? path.join(webDir, 'index.html')
      : path.join(webDir, req.url.slice(5));

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(webDir))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    const ext = path.extname(resolved);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    try {
      const content = await fs.promises.readFile(resolved);
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      try {
        const indexContent = await fs.promises.readFile(path.join(webDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexContent);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Web dashboard not built. Run: npm run build:web' }));
      }
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/status') {
    let version = 'unknown';
    try {
      const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    } catch {}
    const workspaces = deps.allWorkspaces
      ? Object.entries(deps.allWorkspaces).map(([wsPath]) => ({
          path: wsPath,
          name: path.basename(wsPath),
        }))
      : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      version,
      uptime: process.uptime(),
      documents: store.getIndexHealth().documentCount,
      embeddings: store.getIndexHealth().embeddedCount,
      workspaces,
      primaryWorkspace: resolvedWorkspaceRoot,
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/workspaces') {
    const workspaceList: Array<{ path: string; name: string; hash: string; documentCount: number }> = [];
    if (deps.allWorkspaces) {
      for (const [wsPath] of Object.entries(deps.allWorkspaces)) {
        const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
        let docCount = 0;
        try {
          const wsDbPath = resolveWorkspaceDbPath(deps.dataDir ?? path.dirname(effectiveDbPath), wsPath);
          const lightDb = openDatabase(wsDbPath);
          try {
            const row = lightDb.prepare(
              `SELECT COUNT(*) as cnt FROM documents WHERE active = 1 AND project_hash = ?`
            ).get(wsHash) as { cnt: number } | undefined;
            docCount = row?.cnt ?? 0;
          } finally {
            lightDb.close();
          }
        } catch { /* workspace DB may not exist yet */ }
        workspaceList.push({
          path: wsPath,
          name: path.basename(wsPath),
          hash: wsHash,
          documentCount: docCount,
        });
      }
    } else {
      workspaceList.push({
        path: resolvedWorkspaceRoot,
        name: path.basename(resolvedWorkspaceRoot),
        hash: currentProjectHash,
        documentCount: store.getIndexHealth().documentCount,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workspaces: workspaceList }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/entities') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const entities = store.getMemoryEntities(wsHash);
      const entityEdges: Array<{ id: number; sourceId: number; targetId: number; edgeType: string; createdAt: string }> = [];
      for (const entity of entities) {
        const edges = store.getEntityEdges(entity.id, 'outgoing');
        for (const edge of edges) {
          entityEdges.push({
            id: edge.id,
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            edgeType: edge.edgeType,
            createdAt: edge.createdAt,
          });
        }
      }
      const typeDistribution: Record<string, number> = {};
      for (const entity of entities) {
        typeDistribution[entity.type] = (typeDistribution[entity.type] || 0) + 1;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        nodes: entities.map(e => ({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
          firstLearnedAt: e.firstLearnedAt,
          lastConfirmedAt: e.lastConfirmedAt,
          contradictedAt: e.contradictedAt,
        })),
        edges: entityEdges,
        stats: {
          nodeCount: entities.length,
          edgeCount: entityEdges.length,
          typeDistribution,
        },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/stats') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const stats = store.getGraphStats(wsHash);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/code/dependencies') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const edges = store.getFileEdges(wsHash);
      const fileSet = new Set<string>();
      for (const edge of edges) {
        fileSet.add(edge.source_path);
        fileSet.add(edge.target_path);
      }
      const files: Array<{ path: string; centrality: number; clusterId: number | null }> = [];
      for (const fp of fileSet) {
        const centralityInfo = store.getDocumentCentrality(fp);
        files.push({
          path: fp,
          centrality: centralityInfo?.centrality ?? 0,
          clusterId: centralityInfo?.clusterId ?? null,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        files,
        edges: edges.map(e => ({ source: e.source_path, target: e.target_path })),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/search') {
    const query = url.searchParams.get('q');
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'query parameter "q" is required' }));
      return;
    }
    const SEARCH_HARD_DEADLINE_MS = 8000;
    const searchDeadline = new Promise<{ results: import('../types.js').SearchResult[]; timedOut: boolean }>((resolve) => {
      setTimeout(() => resolve({ results: [], timedOut: true }), SEARCH_HARD_DEADLINE_MS);
    });

    const doSearch = async (): Promise<{ results: import('../types.js').SearchResult[]; timedOut: boolean }> => {
      let results: import('../types.js').SearchResult[] = [];
      const FTS_WORKER_TIMEOUT_MS = 5000;
      if (isFTSWorkerReady()) {
        try {
          results = await Promise.race([
            searchFTSAsync(query, { limit, projectHash: wsHash }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('__FTS_TIMEOUT__')), FTS_WORKER_TIMEOUT_MS)
            ),
          ]);
          return { results, timedOut: false };
        } catch (ftsErr: any) {
          log('server', `FTS worker timeout/fail: ${ftsErr?.message}`, 'warn');
        }
      }
      return { results: [], timedOut: false };
    };

    try {
      const startTime = Date.now();
      const { results, timedOut } = await Promise.race([doSearch(), searchDeadline]);
      const executionMs = Date.now() - startTime;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        results: results.map(r => ({
          id: r.id,
          docid: r.docid,
          title: r.title,
          path: r.path,
          score: r.score,
          snippet: r.snippet,
          collection: r.collection,
        })),
        query,
        executionMs,
        ...(timedOut ? { warning: 'search timed out, try again when indexing completes' } : {}),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/telemetry') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const telemetryCount = store.getTelemetryCount();
      const banditStats = store.loadBanditStats(wsHash);
      const profile = store.getWorkspaceProfile(wsHash);
      const telemetryStats = store.getTelemetryStats(wsHash);
      const importanceRows = store.getActiveDocumentsWithAccess();
      const accessCounts = importanceRows.map((r) => r.access_count || 0);
      const importanceStats = accessCounts.length > 0
        ? {
            min: Math.min(...accessCounts),
            max: Math.max(...accessCounts),
            mean: accessCounts.reduce((a, b) => a + b, 0) / accessCounts.length,
            median: accessCounts.sort((a, b) => a - b)[Math.floor(accessCounts.length / 2)],
          }
        : { min: 0, max: 0, mean: 0, median: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        queryCount: telemetryCount,
        banditStats,
        preferenceWeights: profile ? JSON.parse(profile.profile_data || '{}').categoryWeights || {} : {},
        expandRate: telemetryStats.expandCount / Math.max(telemetryStats.queryCount, 1),
        importanceStats,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/connections') {
    const docId = url.searchParams.get('docId');
    const direction = (url.searchParams.get('direction') || 'both') as 'incoming' | 'outgoing' | 'both';
    if (!docId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'docId parameter is required' }));
      return;
    }
    try {
      const doc = store.findDocument(docId);
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Document not found' }));
        return;
      }
      const connections = store.getConnectionsForDocument(doc.id, { direction });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        connections: connections.map(c => ({
          fromDocId: c.fromDocId,
          toDocId: c.toDocId,
          relationshipType: c.relationshipType,
          strength: c.strength,
          description: c.description,
          createdAt: c.createdAt,
        })),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/symbols') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    const limitParam = url.searchParams.get('limit');
    const symbolLimit = limitParam === '0' ? Infinity : parseInt(limitParam || '2000', 10);
    const kindsParam = url.searchParams.get('kinds');
    const excludeKinds = kindsParam === 'all' ? new Set<string>() : new Set(['property']);
    try {
      const allSymbolsRaw = store.getSymbolsForProject(wsHash);
      const allSymbols = excludeKinds.size > 0
        ? allSymbolsRaw.filter((s: { kind: string }) => !excludeKinds.has(s.kind))
        : allSymbolsRaw;
      const allEdges = store.getSymbolEdgesForProject(wsHash);
      const clusters = store.getSymbolClusters(wsHash);
      const total = allSymbols.length;

      const edgeDegree = new Map<number, number>();
      for (const e of allEdges) {
        edgeDegree.set(e.sourceId, (edgeDegree.get(e.sourceId) || 0) + 1);
        edgeDegree.set(e.targetId, (edgeDegree.get(e.targetId) || 0) + 1);
      }

      let symbols = allSymbols;
      let edges = allEdges;
      if (isFinite(symbolLimit) && allSymbols.length > symbolLimit) {
        symbols = [...allSymbols].sort((a, b) => {
          const aDeg = edgeDegree.get(a.id) || 0;
          const bDeg = edgeDegree.get(b.id) || 0;
          const aConnected = aDeg > 0 ? 1 : 0;
          const bConnected = bDeg > 0 ? 1 : 0;
          if (bConnected !== aConnected) return bConnected - aConnected;
          const exportedDiff = (b.exported ? 1 : 0) - (a.exported ? 1 : 0);
          if (exportedDiff !== 0) return exportedDiff;
          return bDeg - aDeg;
        }).slice(0, symbolLimit);
        const keptIds = new Set(symbols.map((s: { id: number }) => s.id));
        edges = allEdges.filter((e: { sourceId: number; targetId: number }) => keptIds.has(e.sourceId) && keptIds.has(e.targetId));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ symbols, edges, clusters, total, truncated: total > symbols.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/flows') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const flows = store.getFlowsWithSteps(wsHash);
      const flowsWithSteps = flows.map(flow => ({
        ...flow,
        steps: store.getFlowSteps(flow.id),
      }));
      const docFlows = store.getDocFlows(wsHash);
      const docFlowsMapped = docFlows.map(df => ({
        id: df.id + 100000,
        label: df.label,
        flowType: df.flowType,
        stepCount: 0,
        entryName: null,
        entryFile: df.sourceFile,
        terminalName: null,
        terminalFile: null,
        description: df.description,
        services: df.services,
        lastUpdated: df.lastUpdated,
        steps: [],
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ flows: [...flowsWithSteps, ...docFlowsMapped] }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/connections') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const connections = store.getAllConnections(wsHash);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connections }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/graph/infrastructure') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const symbols = store.getInfrastructureSymbols(wsHash);
      const grouped: Record<string, Array<{
        pattern: string;
        operations: Array<{ op: string; repo: string; file: string; line: number }>;
      }>> = {};
      for (const sym of symbols) {
        if (!grouped[sym.type]) grouped[sym.type] = [];
        let patternEntry = grouped[sym.type].find(p => p.pattern === sym.pattern);
        if (!patternEntry) {
          patternEntry = { pattern: sym.pattern, operations: [] };
          grouped[sym.type].push(patternEntry);
        }
        patternEntry.operations.push({
          op: sym.operation,
          repo: sym.repo,
          file: sym.filePath,
          line: sym.lineNumber,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ grouped, total: symbols.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/v1/tags') {
    const wsHash = url.searchParams.get('workspace') || currentProjectHash;
    try {
      const tags = store.listAllTags();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tags }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/vsearch') {
    const body = await readBody(req);
    try {
      const { query, limit, workspace } = JSON.parse(body);
      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'query is required' }));
        return;
      }
      const safeLimit = Math.max(1, Math.min(typeof limit === 'number' && limit > 0 ? limit : 10, 100));
      const wsHash = workspace || currentProjectHash;
      const VSEARCH_DEADLINE_MS = 8000;
      const deadline = new Promise<import('../types.js').SearchResult[]>((resolve) => {
        setTimeout(() => resolve([]), VSEARCH_DEADLINE_MS);
      });
      const doVsearch = async (): Promise<import('../types.js').SearchResult[]> => {
        if (providers.embedder) {
          try {
            let embedding: number[];
            const cached = store.getQueryEmbeddingCache(query);
            if (cached) {
              embedding = cached;
            } else {
              const result = await providers.embedder.embed(query);
              embedding = result.embedding;
              store.setQueryEmbeddingCache(query, embedding);
            }
            return await store.searchVecAsync(query, embedding, { limit: safeLimit, projectHash: wsHash });
          } catch {
          }
        }
        return [];
      };
      const results = await Promise.race([doVsearch(), deadline]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'GET' || (req.method === 'POST' && !sessionId)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
      });
      const clientServer = createMcpServer(deps);

      const heartbeatInterval = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(': ping\n\n');
        }
      }, 30_000);

      transport.onclose = () => {
        clearInterval(heartbeatInterval);
        if (transport.sessionId) {
          streamableSessions.delete(transport.sessionId);
          log('server', `Streamable HTTP client disconnected sessionId=${transport.sessionId}`);
        }
      };

      res.on('close', () => clearInterval(heartbeatInterval));
      res.on('error', () => clearInterval(heartbeatInterval));

      await clientServer.connect(transport);
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        streamableSessions.set(transport.sessionId, { transport, server: clientServer });
        log('server', `Streamable HTTP client connected sessionId=${transport.sessionId}`);
      }
      return;
    }

    if (sessionId) {
      const session = streamableSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not Found');
}
