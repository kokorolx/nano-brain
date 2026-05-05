import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { setProjectLabelDataDir } from '../store.js';
import type { SearchResult } from '../types.js';
import { cliOutput } from '../logger.js';
import { isInsideContainer } from '../host.js';

export const DEFAULT_HTTP_PORT = 3100;

export async function detectRunningServer(port: number = getHttpPort()): Promise<boolean> {
  const host = getHttpHost();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function proxyGet(port: number, path: string, timeoutMs = 30_000): Promise<any> {
  const host = getHttpHost();
  const resp = await fetch(`http://${host}:${port}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

export async function proxyPost(port: number, path: string, body: unknown, timeoutMs = 30_000): Promise<any> {
  const host = getHttpHost();
  const resp = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

export function getHttpHost(): string {
  if (process.env.NANO_BRAIN_HOST) return process.env.NANO_BRAIN_HOST;
  return isInsideContainer() ? 'host.docker.internal' : 'localhost';
}

export function getHttpPort(): number {
  if (process.env.NANO_BRAIN_PORT) return parseInt(process.env.NANO_BRAIN_PORT, 10);
  return DEFAULT_HTTP_PORT;
}

export function resolveOpenCodeStorageDir(): string {
  // XDG path (Linux): ~/.local/share/opencode/storage
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const xdgPath = path.join(xdgData, 'opencode', 'storage');
  if (fs.existsSync(xdgPath)) return xdgPath;
  // macOS / legacy fallback: ~/.opencode/storage
  return path.join(os.homedir(), '.opencode', 'storage');
}

export const NANO_BRAIN_HOME = path.join(os.homedir(), '.nano-brain');
export const DEFAULT_DB_DIR = path.join(NANO_BRAIN_HOME, 'data');
setProjectLabelDataDir(DEFAULT_DB_DIR);
export const DEFAULT_CONFIG = path.join(NANO_BRAIN_HOME, 'config.yml');
export const DEFAULT_OUTPUT_DIR = path.join(NANO_BRAIN_HOME, 'sessions');
export const DEFAULT_MEMORY_DIR = path.join(NANO_BRAIN_HOME, 'memory');
export const DEFAULT_LOGS_DIR = path.join(NANO_BRAIN_HOME, 'logs');

export function resolveDbPath(dbPath: string, workspaceRoot: string): string {
  const isDefaultDb = dbPath.endsWith('/default.sqlite') || dbPath.endsWith('\\default.sqlite');
  if (!isDefaultDb) return dbPath;
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const dirName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(path.dirname(dbPath), `${dirName}-${hash}.sqlite`);
}

export function parseGlobalOptions(args: string[]): import('./types.js').GlobalOptions {
  let dbPath = path.join(DEFAULT_DB_DIR, 'default.sqlite');
  let configPath = DEFAULT_CONFIG;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--db=')) {
      dbPath = arg.substring(5);
    } else if (arg === '--db' && i + 1 < args.length) {
      dbPath = args[++i];
    } else if (arg.startsWith('--config=')) {
      configPath = arg.substring(9);
    } else if (arg === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      showVersion();
      process.exit(0);
    } else {
      remaining.push(arg);
    }
  }

  return { dbPath, configPath, remaining };
}

export function showHelp(): void {
  cliOutput(`
nano-brain - Memory system with hybrid search
  nano-brain [global-options] <command> [command-options]
  --db=<path>       SQLite database path (default: ~/.nano-brain/data/default.sqlite)
  --config=<path>   Config YAML path (default: ~/.nano-brain/config.yml)
  --help, -h        Show help
  --version, -v     Show version
  init              Initialize nano-brain for current workspace
    --root=<path>   Workspace root (default: current directory)
    --force         Clear current workspace memory and re-initialize
    --all           With --force, clear ALL workspaces (deletes all database files)
  mcp               Start MCP server (default command if no args)
    --http          Use HTTP transport instead of stdio
    --port=<n>      HTTP port (default: 8282)
    --host=<addr>   Bind address (default: 127.0.0.1)
    --daemon        Run as background daemon
    stop            Stop running daemon
  status            Show index health, embedding server status, and stats
    --all           Show status for all workspaces
  collection        Manage collections
    add <name> <path> [--pattern=<glob>]
    remove <name>
    list
    rename <old> <new>
  embed             Generate embeddings for unembedded chunks
    --force         Re-embed all chunks
  search <query>    BM25 full-text search
  vsearch <query>   Semantic vector search
  query <query>     Full hybrid search
    -n <limit>      Max results (default: 10)
    -c <collection> Filter by collection
    --json          Output as JSON
    --files         Show file paths only
    --compact       Output compact single-line results
    --min-score=<n> Minimum score threshold (query only)
    --scope=all     Search across all workspaces
    --tags=<tags>   Filter by comma-separated tags (AND logic)
    --since=<date>  Filter by modified date (ISO format)
    --until=<date>  Filter by modified date (ISO format)
  tags              List all tags with document counts
  focus <filepath>  Show dependency graph context for a file
  graph-stats       Show graph statistics (nodes, edges, clusters, cycles)
  symbols           Query cross-repo symbols (Redis keys, PubSub, MySQL, APIs, etc.)
    --type=<type>   Filter by type: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue
    --pattern=<pat> Glob pattern (e.g., "sinv:*")
    --repo=<name>   Filter by repository name
    --operation=<op> Filter by operation: read, write, publish, subscribe, define, call, produce, consume
    --json          Output as JSON
  impact            Analyze cross-repo impact of a symbol
    --type=<type>   Symbol type (required)
    --pattern=<pat> Pattern to analyze (required)
    --json          Output as JSON
  context <name>    360° view of a code symbol (callers, callees, flows)
    --file=<path>   Disambiguate when multiple symbols share the name
    --json          Output as JSON
  code-impact <name> Analyze impact of changing a symbol
    --direction=<d> upstream (callers) or downstream (callees), default: upstream
    --max-depth=<n> Max traversal depth (default: 5)
    --min-confidence=<n> Min edge confidence 0-1 (default: 0)
    --file=<path>   Disambiguate symbol
    --json          Output as JSON
  detect-changes    Map git changes to affected symbols and flows
    --scope=<s>     unstaged, staged, or all (default: all)
    --json          Output as JSON
  reindex           Re-index codebase files and symbol graph
    --root=<path>   Workspace root (default: current directory)
  reset             Delete nano-brain data (selective or all)
    --databases     Delete SQLite workspace databases (~/.nano-brain/data/*.sqlite)
    --sessions      Delete harvested session markdown (~/.nano-brain/sessions/)
    --memory        Delete memory notes (~/.nano-brain/memory/)
    --logs          Delete log files (~/.nano-brain/logs/)
    --vectors       Delete Qdrant collection vectors
    --confirm       Required to actually delete (safety flag)
    --dry-run       Preview what would be deleted without deleting
    (no flags + --confirm = delete ALL categories)
  rm <workspace>    Remove a workspace and all its data
    --list          List all known workspaces
    --dry-run       Preview what would be deleted without deleting
    <workspace> can be: absolute path, hash prefix, or workspace name
  harvest           Manually trigger session harvesting
  cache             Manage LLM cache
    clear           Clear cache for current workspace
      --all         Clear all cache entries across all workspaces
      --type=<type> Filter by type (embed, expand, rerank)
    stats           Show cache entry counts by type and workspace
  write <content>   Write content to daily log
    --supersedes=<path-or-docid>  Mark a document as superseded
    --tags=<tags>   Comma-separated tags to associate
  logs [file]       View diagnostic logs (default: today's log)
    path            Print log directory path
    -f, --follow    Follow log output in real-time (tail -f)
    -n <lines>      Show last N lines (default: 50)
    --date=<date>   Show log for specific date (YYYY-MM-DD, default: today)
    --clear         Delete all log files
  wake-up           Generate a compact context briefing for session start
    --json          Output as JSON
    --workspace=<path> Generate briefing for specific workspace
  bench             Run performance benchmarks
    --suite=<name>  Run specific suite (search, embed, cache, store)
    --iterations=<n> Override iteration count
    --json          Output as JSON
    --save          Save results as baseline
    --compare       Compare with last saved baseline
  docker            Manage nano-brain Docker services
    start           Start nano-brain + qdrant containers
    stop            Stop all containers
    restart [svc]   Restart all or specific service (nano-brain|qdrant)
    status          Show container and API health
  qdrant            Manage Qdrant vector store
    up              Start Qdrant via Docker, configure as vector provider
    down            Stop Qdrant, switch back to sqlite-vec
    status          Show Qdrant container and collection health
    migrate         Migrate vectors from SQLite to Qdrant
      --workspace=<path>  Migrate specific workspace only
      --batch-size=<n>    Vectors per batch (default: 500)
      --dry-run           Show counts without migrating
      --activate          Switch to Qdrant provider after migration
    verify          Compare SQLite vector counts against Qdrant
    activate        Switch config to use Qdrant as vector provider
    cleanup         Drop SQLite vector tables (requires Qdrant active with vectors)
    recreate        Recreate Qdrant collection with correct dimensions (DESTRUCTIVE)
  learning          Manage self-learning system
    rollback [id]   View or rollback to a previous config version
  categorize-backfill  Backfill LLM categorization on existing documents
    --batch-size=<n>   Documents per batch (default: 50)
    --rate-limit=<n>   Requests per second (default: 10)
    --dry-run          Preview without making changes
    --workspace=<path> Filter to specific workspace
Logging Config (~/.nano-brain/config.yml):
  logging:
    enabled: true               # enable file logging (or use NANO_BRAIN_LOG=1 env)
  Log files: ~/.nano-brain/logs/nano-brain-YYYY-MM-DD.log
Embedding Config (~/.nano-brain/config.yml):
  embedding:
    provider: ollama              # 'ollama' or 'local'
    url: http://localhost:11434   # Ollama API URL
    model: nomic-embed-text       # embedding model name
  watcher:
    pollIntervalMs: 120000          # reindex interval (default: 120000 = 2min)
    sessionPollMs: 120000           # session harvest interval (default: 120000)
    embedIntervalMs: 60000          # embedding interval (default: 60000 = 1min)
  workspaces:
    /path/to/project-a:
      codebase:
        enabled: true
    /path/to/project-b:
      codebase:
        enabled: true
        extensions: [".ts", ".vue"]
`);
}

export function showVersion(): void {
  const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    cliOutput(`nano-brain v${pkg.version}`);
  } catch {
    cliOutput('nano-brain (unknown version)');
  }
}

export function formatSearchOutput(results: SearchResult[], format: 'text' | 'json' | 'files'): string {
  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }

  if (format === 'files') {
    return results.map(r => r.path).join('\n');
  }

  const lines: string[] = [];
  for (const result of results) {
    lines.push(`[${result.docid}] ${result.collection}/${result.path}`);
    lines.push(`  Score: ${result.score.toFixed(4)} | ${result.title}`);
    if (result.snippet) {
      lines.push(`  ${result.snippet}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
