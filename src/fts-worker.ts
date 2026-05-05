/**
 * FTS Worker Thread
 * Handles Full-Text Search queries in a dedicated thread to prevent blocking the main event loop.
 * Opens a read-only SQLite connection and processes searchFTS/searchVec requests via message passing.
 */
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import type { SearchResult, StoreSearchOptions } from './types.js';

// Message types
interface WorkerRequest {
  id: string;
  method: 'searchFTS' | 'searchVec';
  args: {
    query: string;
    options: StoreSearchOptions;
    embedding?: number[];
  };
}

interface WorkerResponse {
  id: string;
  result?: SearchResult[];
  error?: { message: string };
}

interface ReadyMessage {
  type: 'ready';
}

// Replicate sanitizeFTS5Query from store.ts (line 70-78)
function sanitizeFTS5Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const quotedTokens = tokens.map((token) => `"${token.replace(/"/g, '""')}"`);
  if (quotedTokens.length === 1) return quotedTokens[0];
  return quotedTokens.join(' OR ');
}

// Open read-only connection
// NOTE: Do NOT set journal_mode on a read-only connection — it tries to write and blocks.
// With WAL mode (set by the writer), read-only connections can always read without waiting.
// Set busy_timeout = 0 so we never block waiting for locks — return immediately if busy.
const dbPath = workerData.dbPath as string;
const db = new Database(dbPath, { readonly: true });
db.pragma('busy_timeout = 0');

const enrichByPathStmt = db.prepare(`
  SELECT d.id, d.hash, d.created_at, LENGTH(c.body) as char_length
  FROM documents d
  LEFT JOIN content c ON c.hash = d.hash
  WHERE d.path = ? AND d.active = 1
  LIMIT 1
`);

// Try to load sqlite-vec extension for vector search
let vecAvailable = false;
try {
  const sqliteVec = await import('sqlite-vec');
  sqliteVec.load(db);
  vecAvailable = true;
} catch {
  // sqlite-vec not available, vector search will return empty results
}

/**
 * searchFTS — queries FTS5 index WITHOUT joining the documents table.
 * The documents JOIN blocks when the writer holds a WAL lock during embedding.
 * Instead we derive collection/path from the stored filepath string and return
 * lightweight results. The caller can optionally enrich them via the write connection.
 */
function searchFTS(query: string, options: StoreSearchOptions = {}): SearchResult[] {
  const { limit = 10, collection } = options;
  const sanitized = sanitizeFTS5Query(query);
  if (!sanitized) return [];

  // Build collection filter for FTS filepath prefix (format: "collection/path")
  let sql = `
    SELECT
      filepath,
      title,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
      bm25(documents_fts) as score
    FROM documents_fts
    WHERE documents_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitized];

  // Filter by collection prefix in filepath
  if (collection) {
    sql += ` AND filepath LIKE ?`;
    params.push(`${collection}/%`);
  }

  sql += ` ORDER BY bm25(documents_fts) LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{ filepath: string; title: string; snippet: string; score: number }>;

  return rows.map(row => {
    // filepath format: "collection/path/to/file" or "collection//absolute/path"
    const slashIdx = row.filepath.indexOf('/');
    const coll = slashIdx >= 0 ? row.filepath.substring(0, slashIdx) : '';
    const path = slashIdx >= 0 ? row.filepath.substring(slashIdx + 1) : row.filepath;

    let docId = '';
    let docHash = '';
    let createdAt: string | undefined;
    let charLength: number | undefined;
    try {
      const docRow = enrichByPathStmt.get(path) as { id: number; hash: string; created_at: string; char_length: number | null } | undefined;
      if (docRow) {
        docId = String(docRow.id);
        docHash = docRow.hash.substring(0, 6);
        createdAt = docRow.created_at;
        charLength = docRow.char_length ?? undefined;
      }
    } catch {
    }

    return {
      id: docId,
      path,
      collection: coll,
      title: row.title || path,
      snippet: row.snippet || '',
      score: Math.abs(row.score),
      startLine: 0,
      endLine: 0,
      docid: docHash,
      createdAt,
      charLength,
    };
  });
}

/**
 * searchVec - Replicates store.ts lines 1597-1672
 */
function searchVec(query: string, embedding: number[], options: StoreSearchOptions = {}): SearchResult[] {
  const { limit = 10, collection, projectHash, tags, since, until } = options;
  if (!vecAvailable) {
    return [];
  }

  try {
    let sql = `
      SELECT v.hash_seq, v.distance, d.id, d.path, d.collection, d.title, d.hash, d.agent, d.project_hash,
             d.centrality, d.cluster_id, d.superseded_by,
             d.created_at as createdAt,
             d.access_count, d.last_accessed_at as lastAccessedAt,
             substr(c.body, 1, 700) as snippet,
             LENGTH(c.body) as char_length
      FROM vectors_vec v
      JOIN documents d ON substr(v.hash_seq, 1, instr(v.hash_seq, ':') - 1) = d.hash
      LEFT JOIN content c ON c.hash = d.hash
      WHERE v.embedding MATCH ?
        AND k = ?
        AND d.active = 1
    `;

    const params: (Float32Array | string | number)[] = [new Float32Array(embedding), limit];
    if (collection) {
      sql += ` AND d.collection = ?`;
      params.push(collection);
    }
    if (projectHash && projectHash !== 'all') {
      sql += ` AND d.project_hash = ?`;
      params.push(projectHash);
    }
    if (since) {
      sql += ` AND d.modified_at >= ?`;
      params.push(since);
    }
    if (until) {
      sql += ` AND d.modified_at <= ?`;
      params.push(until);
    }
    if (tags && tags.length > 0) {
      sql += ` AND d.id IN (
        SELECT dt.document_id FROM document_tags dt
        WHERE dt.tag IN (${tags.map(() => '?').join(',')})
        GROUP BY dt.document_id
        HAVING COUNT(DISTINCT dt.tag) = ?
      )`;
      params.push(...tags.map(t => t.toLowerCase().trim()));
      params.push(tags.length);
    }
    sql += ` ORDER BY v.distance`;

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: String(row.id),
      path: row.path as string,
      collection: row.collection as string,
      title: row.title as string,
      snippet: (row.snippet as string) || '',
      score: 1 - (row.distance as number),
      startLine: 0,
      endLine: 0,
      docid: (row.hash as string).substring(0, 6),
      agent: row.agent as string | undefined,
      projectHash: projectHash === 'all' ? (row.project_hash as string | undefined) : undefined,
      centrality: row.centrality as number | undefined,
      clusterId: row.cluster_id as number | undefined,
      supersededBy: row.superseded_by as number | null | undefined,
      access_count: row.access_count as number | undefined,
      lastAccessedAt: row.lastAccessedAt as string | null | undefined,
      createdAt: row.createdAt as string | undefined,
      charLength: row.char_length as number | undefined,
    }));
  } catch {
    return [];
  }
}

// Handle messages from main thread
if (parentPort) {
  parentPort.on('message', (msg: WorkerRequest) => {
    const response: WorkerResponse = { id: msg.id };

    try {
      if (msg.method === 'searchFTS') {
        response.result = searchFTS(msg.args.query, msg.args.options);
      } else if (msg.method === 'searchVec') {
        if (!msg.args.embedding) {
          throw new Error('embedding is required for searchVec');
        }
        response.result = searchVec(msg.args.query, msg.args.embedding, msg.args.options);
      } else {
        throw new Error(`Unknown method: ${msg.method}`);
      }
    } catch (err) {
      response.error = { message: err instanceof Error ? err.message : String(err) };
    }

    parentPort!.postMessage(response);
  });

  // Signal that worker is ready
  const readyMsg: ReadyMessage = { type: 'ready' };
  parentPort.postMessage(readyMsg);
}
