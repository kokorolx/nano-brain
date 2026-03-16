import { startServer } from './server.js';
import { createStore, computeHash, indexDocument, extractProjectHashFromPath, resolveWorkspaceDbPath, resolveProjectLabel, setProjectLabelDataDir, openDatabase } from './store.js';
import { loadCollectionConfig, addCollection, removeCollection, renameCollection, listCollections, getCollections, scanCollectionFiles, saveCollectionConfig, getWorkspaceConfig, removeWorkspaceConfig } from './collections.js';
import { harvestSessions } from './harvester.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth, checkOpenAIHealth } from './embeddings.js';
import { hybridSearch, parseSearchConfig } from './search.js';
import { createReranker } from './reranker.js';
import { indexCodebase, embedPendingCodebase, getCodebaseStats } from './codebase.js';
import { findCycles } from './graph.js';
import { handleBench } from './bench.js';
import { resolveHostUrl } from './host.js';
import { SymbolGraph } from './symbol-graph.js';
import { installService, uninstallService } from './service-installer.js';
import { isTreeSitterAvailable } from './treesitter.js';
import { QdrantVecStore } from './providers/qdrant.js';
import { createVectorStore } from './vector-store.js';
import type { SearchResult, CollectionConfig, Store, ConsolidationConfig } from './types.js';
import { createLLMProvider } from './llm-provider.js';
import { ConsolidationAgent } from './consolidation.js';
import { ResultCache } from './cache.js';
import { formatCompactResults } from './server.js';
import type { VectorPoint, VectorStore, VectorStoreHealth } from './vector-store.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { log, initLogger, cliOutput, cliError } from './logger.js';

const DEFAULT_HTTP_PORT = 3100;

async function detectRunningServer(port: number = DEFAULT_HTTP_PORT): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const resp = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

const UNSAFE_SERVE_STOP_PATTERNS = [
  /docker/i,
  /docker-proxy/i,
  /com\.docker/i,
  /vpnkit/i,
  /containerd/i,
];

function getProcessCommand(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function isUnsafeServeStopTarget(command: string): boolean {
  if (!command) return true;
  return UNSAFE_SERVE_STOP_PATTERNS.some((pattern) => pattern.test(command));
}

function isLikelyNanoBrainServerCommand(command: string): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  const hasNanoBrainMarker =
    normalized.includes('nano-brain') ||
    normalized.includes('/bin/cli.js') ||
    normalized.includes('/src/index.ts');

  const hasServerModeMarker =
    normalized.includes(' mcp') ||
    normalized.includes(' serve') ||
    normalized.includes('--daemon');

  return hasNanoBrainMarker && hasServerModeMarker;
}

async function proxyGet(port: number, path: string): Promise<any> {
  const resp = await fetch(`http://localhost:${port}${path}`);
  return resp.json();
}

async function proxyPost(port: number, path: string, body: any): Promise<any> {
  const resp = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

function isRunningInContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

function getHttpHost(): string {
  return isRunningInContainer() ? 'host.docker.internal' : 'localhost';
}

async function detectRunningServerContainer(port: number = DEFAULT_HTTP_PORT): Promise<boolean> {
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

async function proxyGetContainer(port: number, path: string): Promise<any> {
  const host = getHttpHost();
  const resp = await fetch(`http://${host}:${port}${path}`);
  return resp.json();
}

async function proxyPostContainer(port: number, path: string, body: any): Promise<any> {
  const host = getHttpHost();
  const resp = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

function resolveOpenCodeStorageDir(): string {
  // XDG path (Linux): ~/.local/share/opencode/storage
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const xdgPath = path.join(xdgData, 'opencode', 'storage');
  if (fs.existsSync(xdgPath)) return xdgPath;
  // macOS / legacy fallback: ~/.opencode/storage
  return path.join(os.homedir(), '.opencode', 'storage');
}

const NANO_BRAIN_HOME = path.join(os.homedir(), '.nano-brain');
const DEFAULT_DB_DIR = path.join(NANO_BRAIN_HOME, 'data');
setProjectLabelDataDir(DEFAULT_DB_DIR);
const DEFAULT_CONFIG = path.join(NANO_BRAIN_HOME, 'config.yml');
const DEFAULT_OUTPUT_DIR = path.join(NANO_BRAIN_HOME, 'sessions');
const DEFAULT_MEMORY_DIR = path.join(NANO_BRAIN_HOME, 'memory');
const DEFAULT_LOGS_DIR = path.join(NANO_BRAIN_HOME, 'logs');

export interface GlobalOptions {
  dbPath: string;
  configPath: string;
  remaining: string[];
}

export function parseGlobalOptions(args: string[]): GlobalOptions {
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


/**
 * Resolve per-workspace database path.
 * If dbPath ends with 'default.sqlite', replace with '{dirName}-{hash}.sqlite'
 * where dirName is the sanitized basename of workspaceRoot and hash is first 12 chars of SHA-256.
 * If user explicitly set --db=, that path is returned unchanged.
 */
export function resolveDbPath(dbPath: string, workspaceRoot: string): string {
  const isDefaultDb = dbPath.endsWith('/default.sqlite') || dbPath.endsWith('\\default.sqlite');
  if (!isDefaultDb) return dbPath;
  const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const dirName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(path.dirname(dbPath), `${dirName}-${hash}.sqlite`);
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
  serve             Start SSE server as background daemon (shortcut)
    --port=<n>      HTTP port (default: 3100)
    --foreground    Run in foreground instead of detaching
    stop [--force]  Stop running server (safe PID checks)
    status          Show server status
    install         Install as system service (launchd on macOS, systemd on Linux)
      --force       Overwrite existing service file
    uninstall       Remove system service
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
  bench             Run performance benchmarks
    --suite=<name>  Run specific suite (search, embed, cache, store)
    --iterations=<n> Override iteration count
    --json          Output as JSON
    --save          Save results as baseline
    --compare       Compare with last saved baseline
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
  const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
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

async function handleMcp(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let useHttp = false;
  let port = 8282;
  let host = '127.0.0.1';
  let daemon = false;
  let root: string | undefined;

  for (const arg of commandArgs) {
    if (arg === '--http') {
      useHttp = true;
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--host=')) {
      host = arg.substring(7);
    } else if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--daemon') {
      daemon = true;
    } else if (arg === 'stop') {
      cliOutput('Daemon stop not implemented yet');
      return;
    }
  }

  log('cli', 'mcp server start transport=' + (useHttp ? `http:${host}:${port}` : 'stdio'));
  await startServer({
    dbPath: globalOpts.dbPath,
    configPath: globalOpts.configPath,
    httpPort: useHttp ? port : undefined,
    httpHost: useHttp ? host : undefined,
    daemon,
    root,
  });
}

async function handleServe(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const SERVE_PID_FILE = path.join(NANO_BRAIN_HOME, 'serve.pid');
  const SERVE_LOG_FILE = path.join(NANO_BRAIN_HOME, 'logs', 'server.log');

  let port = 3100;
  let foreground = false;
  let subcommand: string | undefined;
  let root: string | undefined;
  let force = false;

  for (const arg of commandArgs) {
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--foreground' || arg === '-f') {
      foreground = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === 'stop' || arg === 'status' || arg === 'install' || arg === 'uninstall') {
      subcommand = arg;
    }
  }

  // serve stop
  if (subcommand === 'stop') {
    let stopped = false;
    const skippedUnsafe: Array<{ pid: number; command: string; source: string }> = [];

    const tryStopPid = (pid: number, source: string): boolean => {
      if (!Number.isInteger(pid) || pid <= 0) return false;

      const command = getProcessCommand(pid);
      if (!force && (isUnsafeServeStopTarget(command) || !isLikelyNanoBrainServerCommand(command))) {
        skippedUnsafe.push({ pid, command, source });
        return false;
      }

      try {
        process.kill(pid, 'SIGTERM');
        cliOutput(`Stopped nano-brain server (${source}, PID: ${pid})`);
        return true;
      } catch {
        return false;
      }
    };

    // Try stopping via PID file
    try {
      if (fs.existsSync(SERVE_PID_FILE)) {
        const pidText = fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim();
        const pid = parseInt(pidText, 10);
        if (tryStopPid(pid, 'PID file')) {
          stopped = true;
          fs.unlinkSync(SERVE_PID_FILE);
        } else if (fs.existsSync(SERVE_PID_FILE)) {
          // Remove stale/invalid PID file and continue with safe fallback
          fs.unlinkSync(SERVE_PID_FILE);
        }
      }
    } catch {
      // Process might already be dead
      if (fs.existsSync(SERVE_PID_FILE)) fs.unlinkSync(SERVE_PID_FILE);
    }

    // Secondary stop: try to find process by port if PID file failed or was missing
    if (!stopped) {
      try {
        const isPortActive = await detectRunningServer(port);
        if (isPortActive) {
          const platform = process.platform;
          if (platform === 'darwin' || platform === 'linux') {
            try {
              const cmd = platform === 'darwin'
                ? `lsof -ti tcp:${port}`
                : `lsof -ti tcp:${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`;
              const raw = execSync(cmd, { encoding: 'utf-8' }).trim();
              const candidatePids = Array.from(
                new Set(
                  (raw.match(/\d+/g) || [])
                    .map((value) => parseInt(value, 10))
                    .filter((value) => Number.isInteger(value) && value > 0 && value !== port)
                )
              );

              const stoppedPids: number[] = [];
              for (const pid of candidatePids) {
                if (tryStopPid(pid, `port ${port}`)) {
                  stoppedPids.push(pid);
                }
              }

              if (stoppedPids.length > 0) {
                cliOutput(`Stopped nano-brain server on port ${port} (PIDs: ${stoppedPids.join(', ')})`);
                stopped = true;
              }
            } catch {
              // Ignore command failures
            }
          }
        }
      } catch {
        // Ignore health check failures
      }
    }

    if (!stopped) {
      if (force) {
        cliOutput('No running server found');
      } else if (skippedUnsafe.length > 0) {
        cliOutput('No safe nano-brain server PID found to stop.');
        for (const item of skippedUnsafe) {
          const details = item.command ? ` (${item.command})` : '';
          cliOutput(`  skipped ${item.source} PID ${item.pid}${details}`);
        }
        cliOutput('Use `npx nano-brain serve stop --force` only if you verified the target PID manually.');
      } else {
        cliOutput('No running server found');
      }
    }
    return;
  }

  // serve status
  if (subcommand === 'status') {
    try {
      const pid = parseInt(fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check if alive
      cliOutput(`nano-brain server is running (PID: ${pid}, port: ${port})`);
    } catch {
      cliOutput('nano-brain server is not running');
    }
    return;
  }

  // serve install
  if (subcommand === 'install') {
    const result = installService({ force, port });
    if (result.success) {
      cliOutput(`✅ ${result.message}`);
      cliOutput(`   The server will start automatically on login.`);
      cliOutput(`   Port: ${port}`);
    } else {
      cliError(`❌ ${result.message}`);
      process.exit(1);
    }
    return;
  }

  // serve uninstall
  if (subcommand === 'uninstall') {
    const result = uninstallService();
    if (result.success) {
      cliOutput(`✅ ${result.message}`);
    } else {
      cliError(`❌ ${result.message}`);
      process.exit(1);
    }
    return;
  }

  // serve (start)
  if (foreground) {
    return handleMcp(globalOpts, ['--http', `--port=${port}`, '--host=0.0.0.0', '--daemon', ...(root ? [`--root=${root}`] : [])]);
  }

  // Check if already running via PID file
  let pidFileValid = false;
  try {
    if (fs.existsSync(SERVE_PID_FILE)) {
      const existingPid = parseInt(fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim(), 10);
      process.kill(existingPid, 0);
      cliOutput(`Server already running (PID: ${existingPid}). Stop first: npx nano-brain serve stop`);
      return;
    }
  } catch {
    // PID file process not running, or PID file invalid
  }

  // Secondary check: verify if port is already in use by another instance
  const isPortActive = await detectRunningServer(port);
  if (isPortActive) {
    cliOutput(`Server already running on port ${port}. Stop first: npx nano-brain serve stop`);
    return;
  }

  // Spawn detached child
  const logsDir = path.join(NANO_BRAIN_HOME, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/cli.js');
  const args = [cliPath, 'mcp', '--http', `--port=${port}`, '--host=0.0.0.0', '--daemon'];
  if (root) {
    args.push(`--root=${root}`);
  }
  if (globalOpts.configPath !== DEFAULT_CONFIG) {
    args.push(`--config=${globalOpts.configPath}`);
  }

  const logFd = fs.openSync(SERVE_LOG_FILE, 'a');
  const child = spawn(process.argv[0], args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  if (child.pid) {
    fs.writeFileSync(SERVE_PID_FILE, String(child.pid));
    child.unref();
    cliOutput(`nano-brain server started on http://0.0.0.0:${port} (PID: ${child.pid})`);
    cliOutput(`  SSE endpoint: http://localhost:${port}/sse`);
    cliOutput(`  Health check: http://localhost:${port}/health`);
    cliOutput(`  Logs: ${SERVE_LOG_FILE}`);
    cliOutput(`  Stop: npx nano-brain serve stop`);
  } else {
    cliError('Failed to start server');
    process.exit(1);
  }

  fs.closeSync(logFd);
  process.exit(0);
}

async function handleCollection(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing collection subcommand (add, remove, list, rename)');
    process.exit(1);
  }

  switch (subcommand) {
    case 'add': {
      const name = commandArgs[1];
      const collectionPath = commandArgs[2];
      let pattern = '**/*.md';

      for (const arg of commandArgs.slice(3)) {
        if (arg.startsWith('--pattern=')) {
          pattern = arg.substring(10);
        }
      }

      if (!name || !collectionPath) {
        cliError('Usage: collection add <name> <path> [--pattern=<glob>]');
        process.exit(1);
      }

      addCollection(globalOpts.configPath, name, collectionPath, pattern);
      cliOutput(`✅ Added collection "${name}"`);
      break;
    }

    case 'remove': {
      const name = commandArgs[1];
      if (!name) {
        cliError('Usage: collection remove <name>');
        process.exit(1);
      }

      removeCollection(globalOpts.configPath, name);
      cliOutput(`✅ Removed collection "${name}"`);
      break;
    }

    case 'list': {
      const config = loadCollectionConfig(globalOpts.configPath);
      if (!config) {
        cliOutput('No collections configured');
        return;
      }

      const names = listCollections(config);
      if (names.length === 0) {
        cliOutput('No collections configured');
      } else {
        cliOutput('Collections:');
        for (const name of names) {
          const coll = config.collections?.[name];
          cliOutput(`  ${name}: ${coll?.path} (${coll?.pattern || '**/*.md'})`);
        }
      }
      break;
    }

    case 'rename': {
      const oldName = commandArgs[1];
      const newName = commandArgs[2];

      if (!oldName || !newName) {
        cliError('Usage: collection rename <old> <new>');
        process.exit(1);
      }

      renameCollection(globalOpts.configPath, oldName, newName);
      cliOutput(`✅ Renamed collection "${oldName}" to "${newName}"`);
      break;
    }

    default:
      cliError(`Unknown collection subcommand: ${subcommand}`);
      process.exit(1);
  }
}

function extractWorkspaceName(dbFilename: string): string {
  const base = path.basename(dbFilename, '.sqlite');
  const parts = base.split('-');
  if (parts.length > 1 && parts[parts.length - 1].length === 12) {
    return parts.slice(0, -1).join('-');
  }
  return base;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

async function getVectorStoreHealth(config: ReturnType<typeof loadCollectionConfig>): Promise<VectorStoreHealth | null> {
  const vectorConfig = config?.vector;
  if (!vectorConfig || vectorConfig.provider !== 'qdrant') return null;

  try {
    const vectorStore = createVectorStore(vectorConfig);
    const health = await Promise.race([
      vectorStore.health(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    await vectorStore.close();
    return health;
  } catch (err) {
    return {
      ok: false,
      provider: vectorConfig.provider || 'unknown',
      vectorCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printVectorStoreSection(vectorHealth: VectorStoreHealth | null, sqliteVecCount?: number): void {
  cliOutput('Vector Store:');
  if (vectorHealth) {
    cliOutput(`  Provider:   ${vectorHealth.provider}`);
    if (vectorHealth.ok) {
      cliOutput(`  Status:     ✅ connected`);
      cliOutput(`  Vectors:    ${vectorHealth.vectorCount.toLocaleString()}`);
      if (vectorHealth.dimensions) {
        cliOutput(`  Dimensions: ${vectorHealth.dimensions}`);
      }
    } else {
      cliOutput(`  Status:     ❌ unreachable (${vectorHealth.error || 'unknown'})`);
    }
  } else {
    cliOutput(`  Provider:   sqlite-vec (built-in)`);
    cliOutput(`  Vectors:    ${(sqliteVecCount ?? 0).toLocaleString()}`);
  }
  cliOutput('');
}

function printTokenUsageSection(tokenUsage: Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>): void {
  if (tokenUsage.length === 0) return;
  cliOutput('Token Usage:');
  for (const usage of tokenUsage) {
    cliOutput(`  ${usage.model.padEnd(25)} ${usage.totalTokens.toLocaleString()} tokens (${usage.requestCount.toLocaleString()} requests)`);
  }
  cliOutput('');
}

async function printEmbeddingServerStatus(config: ReturnType<typeof loadCollectionConfig>): Promise<void> {
  const embeddingConfig = config?.embedding;
  const url = embeddingConfig?.url || detectOllamaUrl();
  const model = embeddingConfig?.model || 'nomic-embed-text';
  const provider = embeddingConfig?.provider || 'ollama';

  cliOutput('Embedding Server:');
  cliOutput(`  Provider:  ${provider}`);
  cliOutput(`  URL:       ${url}`);
  cliOutput(`  Model:     ${model}`);

  if (provider === 'openai') {
    const openAiHealth = await checkOpenAIHealth(url, embeddingConfig?.apiKey || '', model);
    if (openAiHealth.reachable) {
      cliOutput(`  Status:    ✅ connected`);
    } else {
      cliOutput(`  Status:    ❌ unreachable (${openAiHealth.error})`);
    }
  } else if (provider !== 'local') {
    const ollamaHealth = await checkOllamaHealth(url);
    if (ollamaHealth.reachable) {
      cliOutput(`  Status:    ✅ connected`);
    } else {
      cliOutput(`  Status:    ❌ unreachable (${ollamaHealth.error})`);
    }
  } else {
    cliOutput(`  Status:    local GGUF mode`);
  }
}

async function handleStatus(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'status command invoked');
  const serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);
  let serverInfo: { uptime: number; ready: boolean } | null = null;
  if (serverRunning) {
    try {
      const data = await proxyGet(DEFAULT_HTTP_PORT, '/api/status') as { uptime?: number; ready?: boolean };
      serverInfo = { uptime: data.uptime ?? 0, ready: data.ready ?? false };
    } catch (err) {
      log('cli', 'HTTP proxy failed for server info: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  const showAll = commandArgs.includes('--all');
  const config = loadCollectionConfig(globalOpts.configPath);
  const dataDir = path.dirname(globalOpts.dbPath);

  if (showAll) {
    let dbFiles: string[] = [];
    try {
      const files = fs.readdirSync(dataDir);
      dbFiles = files.filter(f => f.endsWith('.sqlite')).map(f => path.join(dataDir, f));
    } catch {
      cliError(`Cannot read data directory: ${dataDir}`);
      return;
    }

    if (dbFiles.length === 0) {
      cliOutput('No workspaces found.');
      return;
    }

    cliOutput('nano-brain Status — All Workspaces');
    cliOutput('═══════════════════════════════════════════════════');
    cliOutput('');

    if (serverInfo) {
      const uptimeSec = Math.floor(serverInfo.uptime);
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const secs = uptimeSec % 60;
      const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      cliOutput('Server:');
      cliOutput(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
      cliOutput(`  Uptime:   ${uptimeStr}`);
      cliOutput(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
      cliOutput('');
    }

    const header = '  Workspace              Documents  Embedded  Pending  DB Size';
    const divider = '  ─────────────────────  ─────────  ────────  ───────  ───────';
    cliOutput(header);
    cliOutput(divider);

    let totalDocs = 0;
    let totalEmbedded = 0;
    let totalPending = 0;
    let totalSize = 0;

    for (const dbFile of dbFiles) {
      const workspaceName = extractWorkspaceName(dbFile);
      let fileSize = 0;
      try {
        fileSize = fs.statSync(dbFile).size;
      } catch { /* ignore */ }

      let docs = 0;
      let embedded = 0;
      let pending = 0;
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          docs = (readDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
          embedded = (readDb.prepare('SELECT COUNT(*) as count FROM content_vectors').get() as { count: number }).count;
          pending = docs - embedded;
          if (pending < 0) pending = 0;
        } catch {
        }
        readDb.close();
      } catch { /* ignore */ }

      totalDocs += docs;
      totalEmbedded += embedded;
      totalPending += pending;
      totalSize += fileSize;

      const name = workspaceName.padEnd(21);
      const docsStr = docs.toLocaleString().padStart(9);
      const embeddedStr = embedded.toLocaleString().padStart(8);
      const pendingStr = pending.toLocaleString().padStart(7);
      const sizeStr = formatBytes(fileSize).padStart(9);
      cliOutput(`  ${name}  ${docsStr}  ${embeddedStr}  ${pendingStr}  ${sizeStr}`);
    }

    cliOutput('');
    cliOutput(`  Total: ${dbFiles.length} workspaces, ${totalDocs.toLocaleString()} documents, ${totalPending.toLocaleString()} pending embeddings, ${formatBytes(totalSize)}`);
    cliOutput('');

    await printEmbeddingServerStatus(config);
    cliOutput('');

    const vectorHealth = await getVectorStoreHealth(config);
    printVectorStoreSection(vectorHealth);

    const allTokenUsage = new Map<string, { totalTokens: number; requestCount: number; lastUpdated: string }>();
    for (const dbFile of dbFiles) {
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          const rows = readDb.prepare('SELECT model, total_tokens as totalTokens, request_count as requestCount, last_updated as lastUpdated FROM token_usage').all() as Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>;
          for (const row of rows) {
            const existing = allTokenUsage.get(row.model);
            if (existing) {
              existing.totalTokens += row.totalTokens;
              existing.requestCount += row.requestCount;
              if (row.lastUpdated > existing.lastUpdated) existing.lastUpdated = row.lastUpdated;
            } else {
              allTokenUsage.set(row.model, { totalTokens: row.totalTokens, requestCount: row.requestCount, lastUpdated: row.lastUpdated });
            }
          }
        } catch { /* token_usage table may not exist in older DBs */ }
        readDb.close();
      } catch { /* ignore */ }
    }
    const aggregatedUsage = [...allTokenUsage.entries()].map(([model, data]) => ({ model, ...data })).sort((a, b) => b.totalTokens - a.totalTokens);
    printTokenUsageSection(aggregatedUsage);

    return;
  }

  const workspaceRoot = process.cwd();
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const workspaceName = extractWorkspaceName(resolvedDbPath);
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  let dbSize = 0;
  try {
    dbSize = fs.statSync(resolvedDbPath).size;
  } catch { /* ignore */ }

  const store = await createStore(resolvedDbPath);
  const health = store.getIndexHealth();

  cliOutput(`nano-brain Status — ${workspaceName}`);
  cliOutput('═══════════════════════════════════════════════════');
  cliOutput('');

  if (serverInfo) {
    const uptimeSec = Math.floor(serverInfo.uptime);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    cliOutput('Server:');
    cliOutput(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
    cliOutput(`  Uptime:   ${uptimeStr}`);
    cliOutput(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
    cliOutput('');
  }

  cliOutput('Database:');
  cliOutput(`  Path:     ${resolvedDbPath.replace(os.homedir(), '~')}`);
  cliOutput(`  Size:     ${formatBytes(dbSize)} (on disk)`);
  cliOutput('');

  cliOutput('Index:');
  cliOutput(`  Documents:          ${health.documentCount.toLocaleString()}`);
  cliOutput(`  Embedded:           ${health.embeddedCount.toLocaleString()}`);
  cliOutput(`  Pending embeddings: ${health.pendingEmbeddings.toLocaleString()}`);
  cliOutput('');

  if (health.collections.length > 0) {
    cliOutput('Collections:');
    for (const coll of health.collections) {
      cliOutput(`  ${coll.name.padEnd(10)} ${coll.documentCount.toLocaleString()} documents`);
    }
    cliOutput('');
  }

  const wsConfig = getWorkspaceConfig(config, workspaceRoot);
  const codebaseStats = getCodebaseStats(store, wsConfig?.codebase, workspaceRoot);
  if (codebaseStats) {
    cliOutput('Codebase:');
    cliOutput(`  Enabled:    ${codebaseStats.enabled}`);
    cliOutput(`  Storage:    ${formatBytes(codebaseStats.storageUsed)} / ${formatBytes(codebaseStats.maxSize)}`);
    cliOutput(`  Extensions: ${codebaseStats.extensions.join(', ') || 'auto-detect'}`);
    cliOutput(`  Excludes:   ${codebaseStats.excludeCount} patterns`);
    cliOutput('');
  }

  // Code Intelligence (symbol graph)
  try {
    const symbolDb = openDatabase(resolvedDbPath);
    const symbolCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    const edgeCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    let flowCount = 0;
    try {
      flowCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM execution_flows WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    } catch { /* table may not exist */ }
    symbolDb.close();

    cliOutput('Code Intelligence:');
    cliOutput(`  Symbols:    ${symbolCount.toLocaleString()}`);
    cliOutput(`  Edges:      ${edgeCount.toLocaleString()}`);
    cliOutput(`  Flows:      ${flowCount.toLocaleString()}`);
    if (symbolCount === 0) {
      cliOutput('  ⚠️  Empty — run `npx nano-brain reindex` to populate');
    }
    cliOutput('');
  } catch { /* code_symbols table may not exist in older DBs */ }

  await printEmbeddingServerStatus(config);
  cliOutput('');

  const vectorHealth = await getVectorStoreHealth(config);
  printVectorStoreSection(vectorHealth, vectorHealth ? undefined : store.getSqliteVecCount());

  printTokenUsageSection(store.getTokenUsage());

  cliOutput('Models:');
  cliOutput(`  Embedding: ${health.modelStatus.embedding}`);
  cliOutput(`  Reranker:  ${health.modelStatus.reranker}`);
  cliOutput(`  Expander:  ${health.modelStatus.expander}`);
  store.close();
}

async function handleInit(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  if (isRunningInContainer()) {
    cliError('Error: Destructive operations must be run on the host, not from containers.');
    cliError('Run this command directly on the host: npx nano-brain init --force');
    process.exit(1);
  }

  let root = process.cwd();
  let force = false;
  let all = false;

  for (const arg of commandArgs) {
    if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--all') {
      all = true;
    }
  }

  log('cli', 'init start root=' + root + ' force=' + force + ' all=' + all);

  // Resolve per-workspace DB path with the actual root
  globalOpts.dbPath = resolveDbPath(globalOpts.dbPath, root);
  const configDir = path.dirname(globalOpts.configPath);
  const configPath = globalOpts.configPath;

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let config = loadCollectionConfig(configPath);
  const isNewConfig = !config;

  if (!config) {
    config = {
      collections: {
        memory: {
          path: DEFAULT_MEMORY_DIR,
          pattern: '**/*.md',
          update: 'auto'
        },
        sessions: {
          path: DEFAULT_OUTPUT_DIR,
          pattern: '**/*.md',
          update: 'auto'
        }
      },
      embedding: {
        provider: 'ollama',
        url: detectOllamaUrl(),
        model: 'nomic-embed-text'
      }
    };
    saveCollectionConfig(configPath, config);
    cliOutput(`✅ Created config: ${configPath}`);
  } else if (!config.embedding) {
    config.embedding = {
      provider: 'ollama',
      url: detectOllamaUrl(),
      model: 'nomic-embed-text'
    };
    saveCollectionConfig(configPath, config);
    cliOutput(`✅ Updated config with embedding section`);
  } else {
    cliOutput(`ℹ️  Config exists: ${configPath}`);
  }

  if (config.embedding?.provider !== 'openai') {
    const ollamaUrl = config.embedding?.url || detectOllamaUrl();
    const ollamaHealth = await checkOllamaHealth(ollamaUrl);

    if (ollamaHealth.reachable) {
      cliOutput(`✅ Ollama reachable at ${ollamaUrl}`);
    } else {
      cliOutput(`⚠️  Ollama not reachable at ${ollamaUrl} — will use local GGUF fallback`);
    }
  }

  if (all && !force) {
    cliOutput('⚠️  --all ignored without --force');
  }

  if (force && all) {
    const dataDir = path.dirname(globalOpts.dbPath);
    let deletedCount = 0;
    if (fs.existsSync(dataDir)) {
      const dbFiles = fs.readdirSync(dataDir).filter(file =>
        file.endsWith('.sqlite') || file.endsWith('-wal') || file.endsWith('-shm')
      );
      for (const file of dbFiles) {
        fs.unlinkSync(path.join(dataDir, file));
      }
      deletedCount = dbFiles.length;
    }
    cliOutput(`🗑️  Force --all: deleted ${deletedCount} database files from ${dataDir}`);
  }

  if (!config.workspaces) {
    config.workspaces = {};
  }
  if (!config.workspaces[root]) {
    config.workspaces[root] = {
      codebase: { enabled: true }
    };
    saveCollectionConfig(configPath, config);
    cliOutput(`✅ Enabled codebase indexing for workspace: ${root}`);
  } else {
    cliOutput(`ℹ️  Workspace already configured: ${root}`);
  }
  const projectHash = crypto.createHash('sha256').update(root).digest('hex').substring(0, 12);
  let serverRunning = false;
  if (force) {
    serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);
    if (serverRunning) {
      try {
        await proxyPost(DEFAULT_HTTP_PORT, '/api/maintenance/prepare', {});
        cliOutput('⏸️  Daemon paused for maintenance');
      } catch (err) {
        cliError('⚠️  Warning: Could not coordinate with daemon. Stop the daemon first: launchctl unload ~/Library/LaunchAgents/com.nano-brain.server.plist');
        process.exit(1);
      }
    }
  }
  if (force && !all) {
    cliOutput('🗑️  Force mode: deleting workspace database...');
    const dbPath = globalOpts.dbPath;
    let deletedFiles = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = dbPath + suffix;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFiles++;
      }
    }
    cliOutput(`   Deleted ${deletedFiles} database file(s)`);
  }
  const store = await createStore(globalOpts.dbPath);
  cliOutput('📂 Indexing codebase...');
  const wsConfig = config.workspaces[root];
  const codebaseConfig = wsConfig?.codebase ?? { enabled: true };
  const db = openDatabase(globalOpts.dbPath);
  const codebaseStats = await indexCodebase(store, root, codebaseConfig, projectHash, undefined, db);
  db.close();
  cliOutput(`✅ Indexed ${codebaseStats.filesIndexed} files (${codebaseStats.filesSkippedUnchanged} unchanged)`);

  cliOutput('📜 Harvesting sessions...');
  const sessionDir = resolveOpenCodeStorageDir();
  const sessions = await harvestSessions({ sessionDir, outputDir: DEFAULT_OUTPUT_DIR });
  cliOutput(`✅ Harvested ${sessions.length} sessions`);

  cliOutput('📚 Indexing collections...');
  const collections = getCollections(config);
  // Only index core collections during init; MCP watcher handles the rest
  const initCollections = collections.filter(c => c.name === 'memory' || c.name === 'sessions');
  const skippedCount = collections.length - initCollections.length;
  let totalIndexed = 0;
  for (const collection of initCollections) {
    const files = await scanCollectionFiles(collection);
    let collIndexed = 0;
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const title = path.basename(file, path.extname(file));
      const effectiveProjectHash = collection.name === 'sessions'
        ? extractProjectHashFromPath(file, DEFAULT_OUTPUT_DIR) ?? projectHash
        : projectHash;
      const result = indexDocument(store, collection.name, file, content, title, effectiveProjectHash);
      if (!result.skipped) {
        collIndexed++;
        totalIndexed++;
      }
    }
    cliOutput(`  ${collection.name}: ${files.length} files (${collIndexed} new)`);
  }
  if (skippedCount > 0) {
    cliOutput(`  (${skippedCount} other collection(s) deferred to MCP watcher)`);
  }
  cliOutput(`✅ Indexed ${totalIndexed} documents from collections`);
  // Generate embeddings — cap at 50 during init, MCP server handles the rest
  cliOutput('🧠 Generating embeddings...');
  const embeddingConfig = config.embedding;
  const provider = await createEmbeddingProvider({ embeddingConfig });
  const INIT_EMBED_CAP = 50;
  if (provider) {
    store.ensureVecTable(provider.getDimensions());
    let embedded = 0;
    // Embed up to INIT_EMBED_CAP documents during init for quick startup
    while (embedded < INIT_EMBED_CAP) {
      const row = store.getNextHashNeedingEmbedding(projectHash);
      if (!row) break;
      try {
        const maxChars = provider.getMaxChars();
        const result = await provider.embed(row.body.slice(0, maxChars));
        store.insertEmbedding(row.hash, 0, 0, result.embedding, 'nomic-embed-text-v1.5');
        embedded++;
      } catch {
        break;
      }
    }
    const remaining = store.getHashesNeedingEmbedding().length;
    cliOutput(`✅ Embedded ${embedded} documents${remaining > 0 ? ` (${remaining} remaining — MCP server will continue in background)` : ''}`);
    provider.dispose();
  } else {
    const pending = store.getHashesNeedingEmbedding();
    cliOutput(`⚠️  No embedding provider available — ${pending.length} documents pending`);
    cliOutput(`   Run 'npx nano-brain embed' later to generate embeddings`);
  }
  store.close();

  const agentsPath = path.join(root, 'AGENTS.md');
  const snippetPath = path.join(path.dirname(import.meta.url.replace('file://', '')), '..', 'AGENTS_SNIPPET.md');
  const startMarker = '<!-- OPENCODE-MEMORY:START -->';
  const endMarker = '<!-- OPENCODE-MEMORY:END -->';

  if (fs.existsSync(snippetPath)) {
    const snippet = fs.readFileSync(snippetPath, 'utf-8');

    if (fs.existsSync(agentsPath)) {
      let agentsContent = fs.readFileSync(agentsPath, 'utf-8');
      const startIdx = agentsContent.indexOf(startMarker);
      const endIdx = agentsContent.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        agentsContent = agentsContent.substring(0, startIdx) + snippet + agentsContent.substring(endIdx + endMarker.length);
        fs.writeFileSync(agentsPath, agentsContent);
        cliOutput(`✅ Updated AGENTS.md with memory snippet`);
      } else {
        fs.appendFileSync(agentsPath, '\n\n' + snippet);
        cliOutput(`✅ Appended memory snippet to AGENTS.md`);
      }
    } else {
      fs.writeFileSync(agentsPath, snippet);
      cliOutput(`✅ Created AGENTS.md with memory snippet`);
    }
  }


  // Install slash commands to both global and project .opencode/command/
  const commandsDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'commands');
  if (fs.existsSync(commandsDir)) {
    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    const targets = [
      path.join(os.homedir(), '.config', 'opencode', '.opencode', 'command'),
      path.join(root, '.opencode', 'command'),
    ];
    for (const targetDir of targets) {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const file of commandFiles) {
        fs.copyFileSync(path.join(commandsDir, file), path.join(targetDir, file));
      }
    }
    cliOutput(`✅ Installed ${commandFiles.length} slash commands (global + project)`);
  }
  if (serverRunning) {
    try {
      await proxyPost(DEFAULT_HTTP_PORT, '/api/maintenance/resume', {});
      cliOutput('▶️  Daemon resumed');
    } catch (err) {
      cliError('⚠️  Warning: Could not resume daemon. It will auto-resume in 5 minutes.');
    }
  }
  cliOutput('');
  cliOutput('nano-brain initialized! Run `npx nano-brain status` to verify.');
}

async function handleUpdate(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'update start');
  const store = await createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);

  if (!config) {
    cliError('No config file found');
    store.close();
    process.exit(1);
  }

  const collections = getCollections(config);
  let totalIndexed = 0;
  let totalSkipped = 0;

  for (const collection of collections) {
    cliOutput(`Scanning collection: ${collection.name}`);
    const files = await scanCollectionFiles(collection);

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const title = path.basename(file, path.extname(file));
      const effectiveProjectHash = collection.name === 'sessions'
        ? extractProjectHashFromPath(file, DEFAULT_OUTPUT_DIR)
        : undefined;
      const result = indexDocument(store, collection.name, file, content, title, effectiveProjectHash);

      if (result.skipped) {
        totalSkipped++;
      } else {
        totalIndexed++;
      }
    }
  }

  cliOutput(`✅ Indexed ${totalIndexed} documents, skipped ${totalSkipped}`);
  store.close();
}

async function handleEmbed(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let force = false;

  for (const arg of commandArgs) {
    if (arg === '--force') {
      force = true;
    }
  }

  log('cli', 'embed start force=' + force);

  if (isRunningInContainer()) {
    const serverRunning = await detectRunningServerContainer(DEFAULT_HTTP_PORT);
    if (!serverRunning) {
      cliError('Error: Daemon not running. Start it on the host:');
      cliError('  npx nano-brain serve install && launchctl load ~/Library/LaunchAgents/com.nano-brain.server.plist');
      process.exit(1);
    }
    try {
      const result = await proxyPostContainer(DEFAULT_HTTP_PORT, '/api/embed', {});
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput('✅ Embedding started in background on daemon');
      return;
    } catch (err) {
      cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const config = loadCollectionConfig(globalOpts.configPath);
  const provider = await createEmbeddingProvider({ embeddingConfig: config?.embedding });

  if (!provider) {
    cliError('Failed to load embedding provider');
    process.exit(1);
  }

  let qdrantStore: VectorStore | null = null;
  if (config?.vector?.provider === 'qdrant' && config.vector.url) {
    qdrantStore = createVectorStore(config.vector);
  }

  let totalEmbedded = 0;
  const dataDir = path.dirname(globalOpts.dbPath);

  try {
    const store = await createStore(globalOpts.dbPath);
    if (qdrantStore) store.setVectorStore(qdrantStore);
    const hashes = store.getHashesNeedingEmbedding();
    if (hashes.length > 0) {
      store.ensureVecTable(provider.getDimensions());
      cliOutput(`[${path.basename(process.cwd())}] ${hashes.length} chunks pending...`);
      const embedded = await embedPendingCodebase(store, provider, 50);
      totalEmbedded += embedded;
      cliOutput(`[${path.basename(process.cwd())}] Embedded ${embedded} documents`);
    }
    store.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('malformed') || msg.includes('corrupt')) {
      cliError(`[${path.basename(process.cwd())}] Database corrupted — skipping (delete and re-init to fix)`);
    } else {
      throw err;
    }
  }

  if (config?.workspaces) {
    for (const [wsPath, wsConfig] of Object.entries(config.workspaces)) {
      if (!wsConfig.codebase?.enabled) continue;
      const wsDbPath = resolveWorkspaceDbPath(dataDir, wsPath);
      if (!fs.existsSync(wsDbPath)) continue;
      try {
        const wsStore = await createStore(wsDbPath);
        if (qdrantStore) wsStore.setVectorStore(qdrantStore);
        const wsHashes = wsStore.getHashesNeedingEmbedding();
        if (wsHashes.length > 0) {
          wsStore.ensureVecTable(provider.getDimensions());
          cliOutput(`[${path.basename(wsPath)}] ${wsHashes.length} chunks pending...`);
          const embedded = await embedPendingCodebase(wsStore, provider, 50);
          totalEmbedded += embedded;
          cliOutput(`[${path.basename(wsPath)}] Embedded ${embedded} documents`);
        }
        wsStore.close();
      } catch (err) {
        cliError(`[${path.basename(wsPath)}] Embed failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (totalEmbedded === 0) {
    cliOutput('No chunks need embedding');
  } else {
    cliOutput(`✅ Embedded ${totalEmbedded} documents total`);
  }

  provider.dispose();
  if (qdrantStore) await qdrantStore.close();
}

async function handleSearch(
  globalOpts: GlobalOptions,
  commandArgs: string[],
  mode: 'fts' | 'vec' | 'hybrid'
): Promise<void> {
  log('cli', 'search mode=' + mode + ' query=' + (commandArgs[0] || ''));
  const query = commandArgs[0];

  if (!query) {
    cliError('Missing query argument');
    process.exit(1);
  }

  let limit = 10;
  let collection: string | undefined;
  let format: 'text' | 'json' | 'files' = 'text';
  let minScore = 0;
  let scope: 'workspace' | 'all' = 'workspace';
  let tags: string[] | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let compact = false;

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i];

    if (arg === '-n' && i + 1 < commandArgs.length) {
      limit = parseInt(commandArgs[++i], 10);
    } else if (arg === '-c' && i + 1 < commandArgs.length) {
      collection = commandArgs[++i];
    } else if (arg === '--json') {
      format = 'json';
    } else if (arg === '--files') {
      format = 'files';
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg.startsWith('--min-score=')) {
      minScore = parseFloat(arg.substring(12));
    } else if (arg === '--scope=all' || arg === '--scope' && commandArgs[i + 1] === 'all') {
      scope = 'all';
      if (arg === '--scope') i++;
    } else if (arg.startsWith('--tags=')) {
      tags = arg.substring(7).split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
    } else if (arg.startsWith('--since=')) {
      since = arg.substring(8);
    } else if (arg.startsWith('--until=')) {
      until = arg.substring(8);
    }
  }

  const inContainer = isRunningInContainer();
  const serverRunning = inContainer
    ? await detectRunningServerContainer(DEFAULT_HTTP_PORT)
    : await detectRunningServer(DEFAULT_HTTP_PORT);

  if (inContainer && !serverRunning) {
    cliError('Error: Daemon not running. Start it on the host:');
    cliError('  npx nano-brain serve install && launchctl load ~/Library/LaunchAgents/com.nano-brain.server.plist');
    process.exit(1);
  }

  if (serverRunning) {
    try {
      const endpoint = mode === 'fts' ? '/api/search' : '/api/query';
      const data = inContainer
        ? await proxyPostContainer(DEFAULT_HTTP_PORT, endpoint, { query, limit, tags: tags?.join(','), scope })
        : await proxyPost(DEFAULT_HTTP_PORT, endpoint, { query, limit, tags: tags?.join(','), scope });
      if (format === 'json') {
        cliOutput(JSON.stringify(data, null, 2));
      } else if (format === 'files') {
        cliOutput(data.results?.map((r: any) => r.path).join('\n') || '');
      } else if (compact) {
        const cache = new ResultCache();
        const cacheKey = cache.set(data.results || [], query);
        cliOutput(formatCompactResults(data.results || [], cacheKey));
      } else {
        cliOutput(formatSearchOutput(data.results || [], 'text'));
      }
      return;
    } catch (err) {
      if (inContainer) {
        cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log('cli', 'HTTP proxy failed, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const workspaceRoot = process.cwd();
  const projectHash = scope === 'all' ? 'all' : crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);

  const store = await createStore(globalOpts.dbPath);
  let results: SearchResult[];

  if (mode === 'fts') {
    results = store.searchFTS(query, { limit, collection, projectHash, tags, since, until });
  } else if (mode === 'vec') {
    const searchConfig = loadCollectionConfig(globalOpts.configPath);
    if (searchConfig?.vector?.provider === 'qdrant' && searchConfig.vector.url) {
      const vs = createVectorStore(searchConfig.vector);
      store.setVectorStore(vs);
    }
    const provider = await createEmbeddingProvider({ embeddingConfig: searchConfig?.embedding });
    if (!provider) {
      cliError('Vector search requires embedding model');
      store.close();
      process.exit(1);
    }

    const { embedding } = await provider.embed(query);
    results = await store.searchVecAsync(query, embedding, { limit, collection, projectHash, tags, since, until });
    provider.dispose();
  } else {
    const searchConfig = loadCollectionConfig(globalOpts.configPath);
    if (searchConfig?.vector?.provider === 'qdrant' && searchConfig.vector.url) {
      const vs = createVectorStore(searchConfig.vector);
      store.setVectorStore(vs);
    }
    const provider = await createEmbeddingProvider({ embeddingConfig: searchConfig?.embedding });
    const reranker = await createReranker({
      apiKey: searchConfig?.reranker?.apiKey || searchConfig?.embedding?.apiKey,
      model: searchConfig?.reranker?.model,
    });
    results = await hybridSearch(
      store,
      { query, limit, collection, minScore, projectHash, tags, since, until },
      { embedder: provider, reranker }
    );
    reranker?.dispose();
    provider?.dispose();
  }

  if (compact && format !== 'json') {
    const cache = new ResultCache();
    const cacheKey = cache.set(results, query);
    cliOutput(formatCompactResults(results, cacheKey));
  } else {
    cliOutput(formatSearchOutput(results, format));
  }
  store.close();
}

async function handleGet(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const id = commandArgs[0];

  if (!id) {
    cliError('Missing document id or path');
    process.exit(1);
  }

  let full = false;
  let fromLine: number | undefined;
  let maxLines: number | undefined;

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i];

    if (arg === '--full') {
      full = true;
    } else if (arg.startsWith('--from=')) {
      fromLine = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--lines=')) {
      maxLines = parseInt(arg.substring(8), 10);
    }
  }

  const store = await createStore(globalOpts.dbPath);
  const doc = store.findDocument(id);

  if (!doc) {
    cliError(`Document not found: ${id}`);
    store.close();
    process.exit(1);
  }

  cliOutput(`Document: ${doc.collection}/${doc.path}`);
  cliOutput(`Title: ${doc.title}`);
  cliOutput(`Docid: ${doc.hash.substring(0, 6)}`);
  cliOutput('');

  const body = store.getDocumentBody(doc.hash, fromLine, maxLines);
  if (body) {
    cliOutput(body);
  }

  store.close();
}

async function handleHarvest(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'harvest start');
  const sessionDir = resolveOpenCodeStorageDir();
  const outputDir = DEFAULT_OUTPUT_DIR;

  cliOutput('Harvesting sessions...');
  const sessions = await harvestSessions({ sessionDir, outputDir });

  cliOutput(`✅ Harvested ${sessions.length} sessions to ${outputDir}`);
}

async function handleWrite(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const content = commandArgs[0]

  if (!content) {
    cliError('Usage: write "content here" [--supersedes=<path-or-docid>] [--tags=<comma-separated>]')
    process.exit(1)
  }

  log('cli', 'write command contentLength=' + content.length);
  let supersedes: string | undefined
  let tags: string[] | undefined

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i]
    if (arg.startsWith('--supersedes=')) {
      supersedes = arg.substring(13)
    } else if (arg.startsWith('--tags=')) {
      tags = arg.substring(7).split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0)
    }
  }

  if (isRunningInContainer()) {
    const serverRunning = await detectRunningServerContainer(DEFAULT_HTTP_PORT);
    if (!serverRunning) {
      cliError('Error: Daemon not running. Start it on the host:');
      cliError('  npx nano-brain serve install && launchctl load ~/Library/LaunchAgents/com.nano-brain.server.plist');
      process.exit(1);
    }
    try {
      const result = await proxyPostContainer(DEFAULT_HTTP_PORT, '/api/write', {
        content,
        tags: tags?.join(','),
      });
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput(`✅ ${result.message}`);
      return;
    } catch (err) {
      cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const date = new Date().toISOString().split('T')[0]
  const memoryDir = DEFAULT_MEMORY_DIR
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }
  const targetPath = path.join(memoryDir, `${date}.md`)
  const timestamp = new Date().toISOString()
  const workspaceRoot = process.cwd()
  const workspaceName = path.basename(workspaceRoot)
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12)
  const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${projectHash})\n\n${content}\n`

  fs.appendFileSync(targetPath, entry, 'utf-8')

  let supersedeWarning = ''
  let tagInfo = ''
  const store = await createStore(globalOpts.dbPath)

  if (supersedes) {
    const targetDoc = store.findDocument(supersedes)
    if (targetDoc) {
      store.supersedeDocument(targetDoc.id, 0)
    } else {
      supersedeWarning = `\n⚠️ Supersede target not found: ${supersedes}`
    }
  }

  if (tags && tags.length > 0) {
    const fileContent = fs.readFileSync(targetPath, 'utf-8')
    const title = path.basename(targetPath, path.extname(targetPath))
    const hash = crypto.createHash('sha256').update(fileContent).digest('hex')
    store.insertContent(hash, fileContent)
    const stats = fs.statSync(targetPath)
    const docId = store.insertDocument({
      collection: 'memory',
      path: targetPath,
      title,
      hash,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      active: true,
      projectHash,
    })
    store.insertTags(docId, tags)
    tagInfo = `\n📌 Tags: ${tags.join(', ')}`
  }

  store.close()

  cliOutput(`✅ Written to ${targetPath} [${workspaceName}]${supersedeWarning}${tagInfo}`)
}

async function handleTags(globalOpts: GlobalOptions): Promise<void> {
  const store = await createStore(globalOpts.dbPath)
  const tags = store.listAllTags()

  if (tags.length === 0) {
    cliOutput('No tags found.')
    store.close()
    return
  }

  cliOutput('Tags:')
  for (const { tag, count } of tags) {
    cliOutput(`  ${tag}: ${count} document${count === 1 ? '' : 's'}`)
  }
  store.close()
}

async function handleFocus(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const filePath = commandArgs[0]

  if (!filePath) {
    cliError('Usage: focus <filepath>')
    process.exit(1)
  }

  log('cli', 'focus file=' + filePath);
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const dependencies = store.getFileDependencies(absolutePath, projectHash)
  const dependents = store.getFileDependents(absolutePath, projectHash)
  const centralityInfo = store.getDocumentCentrality(absolutePath)

  cliOutput(`File: ${absolutePath}`)
  cliOutput('')

  if (centralityInfo) {
    cliOutput(`Centrality: ${centralityInfo.centrality.toFixed(4)}`)
    if (centralityInfo.clusterId !== null) {
      const clusterMembers = store.getClusterMembers(centralityInfo.clusterId, projectHash)
      cliOutput(`Cluster ID: ${centralityInfo.clusterId} (${clusterMembers.length} members)`)
      if (clusterMembers.length > 0) {
        cliOutput('Cluster Members:')
        for (const member of clusterMembers.slice(0, 10)) {
          cliOutput(`  - ${member}`)
        }
        if (clusterMembers.length > 10) {
          cliOutput(`  ... and ${clusterMembers.length - 10} more`)
        }
      }
    }
  } else {
    cliOutput('Centrality: Not indexed')
  }
  cliOutput('')

  cliOutput(`Dependencies (imports): ${dependencies.length}`)
  for (const dep of dependencies) {
    cliOutput(`  → ${dep}`)
  }
  cliOutput('')

  cliOutput(`Dependents (imported by): ${dependents.length}`)
  for (const dep of dependents) {
    cliOutput(`  ← ${dep}`)
  }

  store.close()
}

async function handleGraphStats(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'graph-stats invoked');
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const stats = store.getGraphStats(projectHash)
  const edges = store.getFileEdges(projectHash)
  const cycles = findCycles(edges.map(e => ({ source: e.source_path, target: e.target_path })), 5)

  cliOutput('Graph Statistics')
  cliOutput('═══════════════════════════════════════════════════')
  cliOutput('')
  cliOutput(`Nodes: ${stats.nodeCount}`)
  cliOutput(`Edges: ${stats.edgeCount}`)
  cliOutput(`Clusters: ${stats.clusterCount}`)
  cliOutput('')

  if (stats.topCentrality.length > 0) {
    cliOutput('Top 10 by Centrality:')
    for (const { path: filePath, centrality } of stats.topCentrality) {
      cliOutput(`  ${centrality.toFixed(4)} - ${filePath}`)
    }
    cliOutput('')
  }

  if (cycles.length > 0) {
    cliOutput(`Cycles (length ≤ 5): ${cycles.length}`)
    for (const cycle of cycles.slice(0, 5)) {
      cliOutput(`  ${cycle.join(' → ')} → ${cycle[0]}`)
    }
    if (cycles.length > 5) {
      cliOutput(`  ... and ${cycles.length - 5} more`)
    }
  } else {
    cliOutput('Cycles: None detected')
  }

  store.close()
}

async function handleSymbols(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let type: string | undefined
  let pattern: string | undefined
  let repo: string | undefined
  let operation: string | undefined
  let format: 'text' | 'json' = 'text'

  for (const arg of commandArgs) {
    if (arg.startsWith('--type=')) {
      type = arg.substring(7)
    } else if (arg.startsWith('--pattern=')) {
      pattern = arg.substring(10)
    } else if (arg.startsWith('--repo=')) {
      repo = arg.substring(7)
    } else if (arg.startsWith('--operation=')) {
      operation = arg.substring(12)
    } else if (arg === '--json') {
      format = 'json'
    }
  }

  log('cli', 'symbols type=' + (type || '') + ' pattern=' + (pattern || '') + ' repo=' + (repo || '') + ' operation=' + (operation || ''));
  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.querySymbols({
    type,
    pattern,
    repo,
    operation,
    projectHash,
  })

  if (format === 'json') {
    cliOutput(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    cliOutput('No symbols found matching the criteria.')
    store.close()
    return
  }

  const grouped = new Map<string, Array<{ operation: string; repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    const key = `${r.type}:${r.pattern}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push({ operation: r.operation, repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  cliOutput(`Found ${results.length} symbol(s) across ${grouped.size} pattern(s)`)
  cliOutput('')

  for (const [key, items] of grouped) {
    const [symbolType, symbolPattern] = key.split(':')
    cliOutput(`${symbolType}: ${symbolPattern}`)
    for (const item of items) {
      cliOutput(`  [${item.operation}] ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    cliOutput('')
  }

  store.close()
}

async function handleImpact(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let type: string | undefined
  let pattern: string | undefined
  let format: 'text' | 'json' = 'text'

  for (const arg of commandArgs) {
    if (arg.startsWith('--type=')) {
      type = arg.substring(7)
    } else if (arg.startsWith('--pattern=')) {
      pattern = arg.substring(10)
    } else if (arg === '--json') {
      format = 'json'
    }
  }

  log('cli', 'impact type=' + (type || '') + ' pattern=' + (pattern || ''));
  if (!type || !pattern) {
    cliError('Usage: impact --type=<type> --pattern=<pattern> [--json]')
    cliError('Types: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue')
    process.exit(1)
  }

  const store = await createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.getSymbolImpact(type, pattern, projectHash)

  if (format === 'json') {
    cliOutput(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    cliOutput(`No symbols found for ${type}: ${pattern}`)
    store.close()
    return
  }

  const byOperation = new Map<string, Array<{ repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    if (!byOperation.has(r.operation)) byOperation.set(r.operation, [])
    byOperation.get(r.operation)!.push({ repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  cliOutput(`Impact Analysis: ${type} "${pattern}"`)
  cliOutput('')

  const operationLabels: Record<string, string> = {
    read: 'Readers',
    write: 'Writers',
    publish: 'Publishers',
    subscribe: 'Subscribers',
    define: 'Definitions',
    call: 'Callers',
    produce: 'Producers',
    consume: 'Consumers',
  }

  for (const [op, items] of byOperation) {
    const label = operationLabels[op] || op
    cliOutput(`${label} (${items.length}):`)
    for (const item of items) {
      cliOutput(`  ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    cliOutput('')
  }

  store.close()
}

function warnIfEmptySymbolGraph(db: Database.Database, projectHash: string): boolean {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number };
  if (count.cnt === 0) {
    cliError('⚠️  Symbol graph is empty. Run `npx nano-brain reindex` first.');
    return true;
  }
  return false;
}

async function handleContext(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let name: string | undefined;
  let filePath: string | undefined;
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--file=')) {
      filePath = arg.substring(7);
    } else if (arg === '--json') {
      format = 'json';
    } else if (!arg.startsWith('-')) {
      name = arg;
    }
  }

  if (!name) {
    cliError('Usage: context <symbol-name> [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'context name=' + name + ' file=' + (filePath || ''));
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleContext({ name, filePath, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      cliOutput(`Multiple symbols named "${name}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        cliOutput(`  ${s.kind} ${s.name} — ${s.filePath}:${s.startLine}`);
      }
    } else {
      cliOutput(`Symbol "${name}" not found.`);
    }
    db.close();
    return;
  }

  const sym = result.symbol!;
  cliOutput(`${sym.kind} ${sym.name}`);
  cliOutput(`  File: ${sym.filePath}:${sym.startLine}-${sym.endLine}`);
  cliOutput(`  Exported: ${sym.exported ? 'yes' : 'no'}`);
  if (result.clusterLabel) {
    cliOutput(`  Cluster: ${result.clusterLabel}`);
  }
  cliOutput('');

  if (result.incoming && result.incoming.length > 0) {
    cliOutput(`Callers (${result.incoming.length}):`);
    for (const e of result.incoming) {
      cliOutput(`  ← ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    cliOutput('');
  }

  if (result.outgoing && result.outgoing.length > 0) {
    cliOutput(`Callees (${result.outgoing.length}):`);
    for (const e of result.outgoing) {
      cliOutput(`  → ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    cliOutput('');
  }

  if (result.flows && result.flows.length > 0) {
    cliOutput(`Flows (${result.flows.length}):`);
    for (const f of result.flows) {
      cliOutput(`  ${f.flowType}: ${f.label} (step ${f.stepIndex})`);
    }
    cliOutput('');
  }

  if (result.infrastructureSymbols && result.infrastructureSymbols.length > 0) {
    cliOutput(`Infrastructure:`);
    for (const s of result.infrastructureSymbols) {
      cliOutput(`  [${s.operation}] ${s.type}: ${s.pattern}`);
    }
  }

  db.close();
}

async function handleCodeImpact(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let target: string | undefined;
  let direction: 'upstream' | 'downstream' = 'upstream';
  let maxDepth = 5;
  let minConfidence = 0;
  let filePath: string | undefined;
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--direction=')) {
      const val = arg.substring(12);
      if (val === 'upstream' || val === 'downstream') direction = val;
    } else if (arg.startsWith('--max-depth=')) {
      maxDepth = parseInt(arg.substring(12), 10);
    } else if (arg.startsWith('--min-confidence=')) {
      minConfidence = parseFloat(arg.substring(17));
    } else if (arg.startsWith('--file=')) {
      filePath = arg.substring(7);
    } else if (arg === '--json') {
      format = 'json';
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  if (!target) {
    cliError('Usage: code-impact <symbol-name> [--direction=upstream|downstream] [--max-depth=N] [--min-confidence=N] [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'code-impact target=' + target + ' direction=' + direction + ' depth=' + maxDepth);
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleImpact({ target, direction, maxDepth, minConfidence, filePath, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      cliOutput(`Multiple symbols named "${target}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        cliOutput(`  ${s.kind} ${s.name} — ${s.filePath}`);
      }
    } else {
      cliOutput(`Symbol "${target}" not found.`);
    }
    db.close();
    return;
  }

  const t = result.target!;
  cliOutput(`Impact Analysis: ${t.kind} ${t.name} (${t.filePath})`);
  cliOutput(`  Direction: ${direction}`);
  cliOutput(`  Risk: ${result.risk}`);
  cliOutput(`  Direct deps: ${result.summary.directDeps}, Total affected: ${result.summary.totalAffected}, Flows: ${result.summary.flowsAffected}`);
  cliOutput('');

  for (const [depth, symbols] of Object.entries(result.byDepth)) {
    if (symbols.length > 0) {
      cliOutput(`Depth ${depth} (${symbols.length}):`);
      for (const s of symbols) {
        cliOutput(`  ${s.kind} ${s.name} (${s.filePath}) [${s.edgeType}, confidence=${s.confidence}]`);
      }
    }
  }

  if (result.affectedFlows.length > 0) {
    cliOutput('');
    cliOutput(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      cliOutput(`  ${f.flowType}: ${f.label}`);
    }
  }

  db.close();
}

async function handleDetectChanges(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let scope: 'unstaged' | 'staged' | 'all' = 'all';
  let format: 'text' | 'json' = 'text';

  for (const arg of commandArgs) {
    if (arg.startsWith('--scope=')) {
      const val = arg.substring(8);
      if (val === 'unstaged' || val === 'staged' || val === 'all') scope = val;
    } else if (arg === '--json') {
      format = 'json';
    }
  }

  log('cli', 'detect-changes scope=' + scope);
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = openDatabase(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleDetectChanges({ scope, workspaceRoot, projectHash });

  if (format === 'json') {
    cliOutput(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (result.changedFiles.length === 0) {
    cliOutput('No changed files detected.');
    db.close();
    return;
  }

  cliOutput(`Risk Level: ${result.riskLevel}`);
  cliOutput('');

  cliOutput(`Changed Files (${result.changedFiles.length}):`);
  for (const f of result.changedFiles) {
    cliOutput(`  ${f}`);
  }
  cliOutput('');

  if (result.changedSymbols.length > 0) {
    cliOutput(`Changed Symbols (${result.changedSymbols.length}):`);
    for (const s of result.changedSymbols) {
      cliOutput(`  ${s.kind} ${s.name} (${s.filePath})`);
    }
    cliOutput('');
  }

  if (result.affectedFlows.length > 0) {
    cliOutput(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      cliOutput(`  ${f.flowType}: ${f.label}`);
    }
  }

  db.close();
}

async function handleReindex(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let root = process.cwd();

  for (const arg of commandArgs) {
    if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    }
  }

  log('cli', 'reindex root=' + root);

  if (isRunningInContainer()) {
    const serverRunning = await detectRunningServerContainer(DEFAULT_HTTP_PORT);
    if (!serverRunning) {
      cliError('Error: Daemon not running. Start it on the host:');
      cliError('  npx nano-brain serve install && launchctl load ~/Library/LaunchAgents/com.nano-brain.server.plist');
      process.exit(1);
    }
    try {
      const result = await proxyPostContainer(DEFAULT_HTTP_PORT, '/api/reindex', { root });
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput(`✅ Reindex started in background on daemon for ${result.root}`);
      return;
    } catch (err) {
      cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, root);
  const store = await createStore(resolvedDbPath);
  const projectHash = crypto.createHash('sha256').update(root).digest('hex').substring(0, 12);

  const config = loadCollectionConfig(globalOpts.configPath);
  const wsConfig = getWorkspaceConfig(config, root);
  const codebaseConfig = wsConfig?.codebase ?? { enabled: true };

  cliOutput(`Reindexing codebase: ${root}`);
  const db = openDatabase(resolvedDbPath);
  const stats = await indexCodebase(store, root, codebaseConfig, projectHash, undefined, db);
  cliOutput(`  Files: ${stats.filesIndexed} indexed, ${stats.filesSkippedUnchanged} unchanged`);

  // Report symbol graph stats
  const symbolCount = (db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  cliOutput(`  Symbols: ${symbolCount}, Edges: ${edgeCount}`);

  if (symbolCount === 0 && isTreeSitterAvailable()) {
    cliOutput('  ⚠️  No symbols indexed. Check if your files contain supported languages.');
  } else if (!isTreeSitterAvailable()) {
    cliOutput('  ⚠️  Tree-sitter not available — symbol graph skipped.');
  }

  db.close();
  store.close();
  cliOutput('✅ Reindex complete.');
}

async function handleCache(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing cache subcommand (clear, stats)');
    process.exit(1);
  }

  log('cli', 'cache subcommand=' + subcommand);
  const store = await createStore(globalOpts.dbPath);

  switch (subcommand) {
    case 'clear': {
      let all = false;
      let type: string | undefined;

      for (const arg of commandArgs.slice(1)) {
        if (arg === '--all') {
          all = true;
        } else if (arg.startsWith('--type=')) {
          type = arg.substring(7);
        }
      }

      if (type) {
        const typeMap: Record<string, string> = { embed: 'qembed', expand: 'expand', rerank: 'rerank' };
        if (!typeMap[type]) {
          cliError(`Invalid cache type "${type}". Valid types: embed, expand, rerank`);
          store.close();
          process.exit(1);
        }
        type = typeMap[type];
      }

      let deleted: number;
      if (all) {
        deleted = store.clearCache(undefined, type);
        cliOutput(`Cleared all cache entries${type ? ` of type ${type}` : ''} (${deleted} total)`);
      } else {
        const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12);
        deleted = store.clearCache(projectHash, type);
        cliOutput(`Cleared ${deleted} cache entries for workspace ${resolveProjectLabel(projectHash)}${type ? ` (type: ${type})` : ''}`);
      }
      break;
    }

    case 'stats': {
      const stats = store.getCacheStats();
      if (stats.length === 0) {
        cliOutput('No cache entries');
      } else {
        cliOutput('Cache Statistics:');
        cliOutput('  Type        Project                         Count');
        cliOutput('  ──────────  ──────────────────────────────  ─────');
        for (const row of stats) {
          cliOutput(`  ${row.type.padEnd(10)}  ${resolveProjectLabel(row.projectHash).padEnd(30)}  ${row.count}`);
        }
      }
      break;
    }

    default:
      cliError(`Unknown cache subcommand: ${subcommand}`);
      store.close();
      process.exit(1);
  }

  store.close();
}

async function handleLogs(commandArgs: string[]): Promise<void> {
  const logsDir = path.join(os.homedir(), '.nano-brain', 'logs');

  if (commandArgs[0] === 'path') {
    cliOutput(logsDir);
    return;
  }

  let follow = false;
  let lines = 50;
  let date = new Date().toISOString().split('T')[0];
  let clear = false;
  let logFile: string | null = null;

  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-n' && i + 1 < commandArgs.length) {
      lines = parseInt(commandArgs[++i], 10);
    } else if (arg.startsWith('--date=')) {
      date = arg.substring(7);
    } else if (arg === '--clear') {
      clear = true;
    } else if (!arg.startsWith('-')) {
      logFile = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    }
  }

  log('cli', 'logs follow=' + follow + ' lines=' + lines + ' date=' + date + ' clear=' + clear);

  if (clear) {
    if (!fs.existsSync(logsDir)) {
      cliOutput('No logs directory');
      return;
    }
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('nano-brain-') && f.endsWith('.log'));
    for (const file of files) {
      fs.unlinkSync(path.join(logsDir, file));
    }
    cliOutput('Cleared ' + files.length + ' log file(s)');
    return;
  }

  if (!logFile) {
    logFile = path.join(logsDir, 'nano-brain-' + date + '.log');
  }

  if (!fs.existsSync(logFile)) {
    cliOutput('No log file: ' + logFile);
    cliOutput('Enable logging: set logging.enabled: true in ~/.nano-brain/config.yml');
    return;
  }

  if (follow) {
    const { spawn } = await import('child_process');
    const tail = spawn('tail', ['-f', '-n', String(lines), logFile], { stdio: 'inherit' });
    tail.on('error', () => {
      cliError('tail command not available, showing last ' + lines + ' lines instead');
      printLastLines(logFile!, lines);
    });
    await new Promise<void>((resolve) => {
      tail.on('close', () => resolve());
      process.on('SIGINT', () => { tail.kill(); resolve(); });
    });
  } else {
    printLastLines(logFile, lines);
  }
}

function printLastLines(filePath: string, n: number): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(l => l.length > 0);
  const start = Math.max(0, allLines.length - n);
  const selected = allLines.slice(start);
  if (start > 0) {
    cliOutput('... (' + start + ' earlier lines omitted, use -n to show more)');
  }
  for (const line of selected) {
    cliOutput(line);
  }
}

interface VectorConfigSection {
  provider: 'sqlite-vec' | 'qdrant';
  url?: string;
  apiKey?: string;
  collection?: string;
}

async function handleQdrant(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing qdrant subcommand (up, down, status, migrate, verify, activate, cleanup, recreate)');
    process.exit(1);
  }

  log('cli', 'qdrant subcommand=' + subcommand);

  const composeSource = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docker-compose.qdrant.yml');
  const composeTarget = path.join(NANO_BRAIN_HOME, 'docker-compose.qdrant.yml');

  switch (subcommand) {
    case 'up': {
      if (!fs.existsSync(composeTarget)) {
        if (!fs.existsSync(composeSource)) {
          cliError('❌ docker-compose.qdrant.yml not found in package');
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(composeTarget), { recursive: true });
        fs.copyFileSync(composeSource, composeTarget);
      }

      cliOutput('Starting Qdrant...');
      try {
        execSync(`docker compose -f "${composeTarget}" up -d`, { stdio: 'inherit' });
      } catch {
        cliError('❌ Failed to start Qdrant. Is Docker running?');
        process.exit(1);
      }

      const healthUrl = resolveHostUrl('http://localhost:6333/healthz');
      let healthy = false;
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const res = await fetch(healthUrl);
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
        }
        cliOutput(`Waiting for Qdrant... (${i + 1}/5)`);
      }

      if (!healthy) {
        cliError('❌ Qdrant failed to start. Check: docker logs nano-brain-qdrant');
        process.exit(1);
      }

      let config = loadCollectionConfig(globalOpts.configPath);
      if (!config) {
        config = { collections: {} };
      }
      const vectorConfig: VectorConfigSection = {
        provider: 'qdrant',
        url: 'http://localhost:6333',
        collection: 'nano-brain',
      };
      config.vector = vectorConfig;
      saveCollectionConfig(globalOpts.configPath, config);

      cliOutput('✅ Qdrant is running. Dashboard: http://localhost:6333/dashboard');
      break;
    }

    case 'down': {
      cliOutput('Stopping Qdrant...');
      try {
        execSync(`docker compose -f "${composeTarget}" down`, { stdio: 'inherit' });
      } catch {
        cliError('❌ Failed to stop Qdrant');
        process.exit(1);
      }

      let config = loadCollectionConfig(globalOpts.configPath);
      if (config) {
        const vectorConfig: VectorConfigSection = { provider: 'sqlite-vec' };
        config.vector = vectorConfig;
        saveCollectionConfig(globalOpts.configPath, config);
      }

      cliOutput('✅ Qdrant stopped. Vector provider switched to sqlite-vec. Data persists in Docker volume.');
      break;
    }

    case 'status': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const currentProvider = vectorConfig?.provider || 'sqlite-vec';

      cliOutput('Qdrant Status');
      cliOutput('═══════════════════════════════════════════════════');
      if (currentProvider === 'qdrant') {
        cliOutput(`Active provider: qdrant ✓`);
      } else {
        cliOutput(`Active provider: sqlite-vec (default)`);
      }
      cliOutput('');

      let containerStatus = 'unknown';
      try {
        const output = execSync(`docker compose -f "${composeTarget}" ps --format json`, { encoding: 'utf-8' });
        const lines = output.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const info = JSON.parse(line);
            if (info.Name === 'nano-brain-qdrant' || info.Service === 'qdrant') {
              containerStatus = info.State || info.Status || 'running';
              break;
            }
          } catch {
          }
        }
      } catch {
        containerStatus = 'not running';
      }

      cliOutput(`Container: ${containerStatus}`);

      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
        cliOutput(`Health: ✅ reachable at ${resolvedUrl}`);

        try {
          const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
          if (collectionRes.ok) {
            const collectionData = await collectionRes.json();
            const result = collectionData.result || collectionData;
            cliOutput(`Collection: nano-brain`);
            cliOutput(`  Vectors: ${result.points_count ?? result.vectors_count ?? 'unknown'}`);
            cliOutput(`  Dimensions: ${result.config?.params?.vectors?.size ?? 'unknown'}`);
          } else {
            cliOutput('Collection: nano-brain (not created yet)');
          }
        } catch {
          cliOutput('Collection: nano-brain (not created yet)');
        }
      } catch {
        cliOutput(`Health: ❌ Qdrant is not reachable at ${resolvedUrl}`);
        if (resolvedUrl !== qdrantUrl) {
          cliOutput(`   (config URL ${qdrantUrl} resolved to ${resolvedUrl} inside container)`);
        }
        cliOutput('   Run `npx nano-brain qdrant up` to start.');
      }
      break;
    }

    case 'migrate': {
      let workspaceFilter: string | undefined;
      let batchSize = 500;
      let dryRun = false;
      let activateAfter = false;

      for (const arg of commandArgs.slice(1)) {
        if (arg.startsWith('--workspace=')) {
          workspaceFilter = arg.substring(12);
        } else if (arg.startsWith('--batch-size=')) {
          batchSize = parseInt(arg.substring(13), 10);
        } else if (arg === '--dry-run') {
          dryRun = true;
        } else if (arg === '--activate') {
          activateAfter = true;
        }
      }

      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
      } catch {
        cliError(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        cliError('   Run `npx nano-brain qdrant up` first.');
        cliError('   If running inside a container, Qdrant must be accessible at host.docker.internal:6333.');
        process.exit(1);
      }

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        cliOutput('No databases found in ' + dataDir);
        return;
      }

      let sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (workspaceFilter) {
        sqliteFiles = sqliteFiles.filter(f => f.includes(workspaceFilter));
      }

      if (sqliteFiles.length === 0) {
        cliOutput('No matching databases found');
        return;
      }

      cliOutput(`Found ${sqliteFiles.length} database(s) to migrate`);
      if (dryRun) {
        cliOutput('(dry-run mode - no vectors will be written)');
      }

      const startTime = Date.now();
      let totalVectors = 0;
      let dbCount = 0;

      const sqliteVec = await import('sqlite-vec');

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const db = openDatabase(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          cliOutput(`[${sqliteFile}] sqlite-vec not available, skipping`);
          db.close();
          continue;
        }

        let vectorCount = 0;
        try {
          const countStmt = db.prepare(`
            SELECT COUNT(*) as cnt FROM content_vectors cv
            JOIN vectors_vec vv ON cv.hash || ':' || cv.seq = vv.hash_seq
          `);
          const countRow = countStmt.get() as { cnt: number };
          vectorCount = countRow.cnt;
        } catch {
          cliOutput(`[${sqliteFile}] no vector tables, skipping`);
          db.close();
          continue;
        }

        if (vectorCount === 0) {
          cliOutput(`[${sqliteFile}] 0 vectors, skipping`);
          db.close();
          continue;
        }

        if (dryRun) {
          cliOutput(`[${sqliteFile}] ${vectorCount} vectors (dry-run)`);
          totalVectors += vectorCount;
          dbCount++;
          db.close();
          continue;
        }

        const qdrantStore = new QdrantVecStore({
          url: resolvedUrl,
          collection: vectorConfig?.collection || 'nano-brain',
        });

        const selectStmt = db.prepare(`
          SELECT cv.hash, cv.seq, cv.pos, cv.model, vv.embedding,
                 MIN(d.collection) as collection, MIN(d.project_hash) as project_hash
          FROM content_vectors cv
          JOIN vectors_vec vv ON cv.hash || ':' || cv.seq = vv.hash_seq
          LEFT JOIN documents d ON cv.hash = d.hash AND d.active = 1
          GROUP BY cv.hash, cv.seq
        `);

        const rows = selectStmt.all() as Array<{
          hash: string;
          seq: number;
          pos: number;
          model: string;
          project_hash: string | null;
          embedding: Buffer;
          collection: string | null;
        }>;

        let migrated = 0;
        const batch: VectorPoint[] = [];

        for (const row of rows) {
          const embeddingArray = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));

          const point: VectorPoint = {
            id: `${row.hash}:${row.seq}`,
            embedding: embeddingArray,
            metadata: {
              hash: row.hash,
              seq: row.seq,
              pos: row.pos,
              model: row.model,
              collection: row.collection || undefined,
              projectHash: row.project_hash || undefined,
            },
          };

          batch.push(point);

          if (batch.length >= batchSize) {
            await qdrantStore.batchUpsert(batch);
            migrated += batch.length;
            cliOutput(`[${sqliteFile}] ${migrated}/${vectorCount} vectors migrated...`);
            batch.length = 0;
          }
        }

        if (batch.length > 0) {
          await qdrantStore.batchUpsert(batch);
          migrated += batch.length;
        }

        cliOutput(`[${sqliteFile}] ${migrated}/${vectorCount} vectors migrated`);
        totalVectors += migrated;
        dbCount++;

        await qdrantStore.close();
        db.close();
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (dryRun) {
        cliOutput(`\n📊 Dry-run complete: ${totalVectors} vectors in ${dbCount} database(s)`);
      } else {
        cliOutput(`\n✅ Migrated ${totalVectors} vectors from ${dbCount} database(s) in ${elapsed}s`);

        const currentProvider = config?.vector?.provider || 'sqlite-vec';
        if (currentProvider !== 'qdrant') {
          if (activateAfter) {
            let updatedConfig = loadCollectionConfig(globalOpts.configPath);
            if (!updatedConfig) {
              updatedConfig = { collections: {} };
            }
            const newVectorConfig: VectorConfigSection = {
              provider: 'qdrant',
              url: vectorConfig?.url || 'http://localhost:6333',
              collection: vectorConfig?.collection || 'nano-brain',
            };
            updatedConfig.vector = newVectorConfig;
            saveCollectionConfig(globalOpts.configPath, updatedConfig);
            cliOutput('\n✅ Switched to Qdrant provider');
          } else {
            cliOutput(`\nProvider is currently: ${currentProvider}`);
            cliOutput('To use Qdrant for searches, run: npx nano-brain qdrant activate');
            cliOutput('Or re-run with: npx nano-brain qdrant migrate --activate');
          }
        }
      }
      break;
    }

    case 'verify': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
      } catch {
        cliError(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        cliError('   Run `npx nano-brain qdrant up` first.');
        cliError('   If running inside a container, Qdrant must be accessible at host.docker.internal:6333.');
        process.exit(1);
      }

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        cliOutput('No databases found in ' + dataDir);
        return;
      }

      const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (sqliteFiles.length === 0) {
        cliOutput('No SQLite databases found');
        return;
      }

      cliOutput('Verifying migration...');
      cliOutput('═══════════════════════════════════════════════════');

      const sqliteVec = await import('sqlite-vec');

      let totalVectors = 0;
      let dbCount = 0;
      const uniqueKeys = new Set<string>();
      let sawVectorTables = false;

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const db = openDatabase(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          cliOutput(`[${sqliteFile}] sqlite-vec not available, skipping`);
          db.close();
          continue;
        }

        let vectorCount = 0;
        try {
          const countStmt = db.prepare(`
            SELECT COUNT(*) as cnt FROM content_vectors cv
            JOIN vectors_vec vv ON cv.hash || ':' || cv.seq = vv.hash_seq
          `);
          const countRow = countStmt.get() as { cnt: number };
          vectorCount = countRow.cnt;
        } catch {
          cliOutput(`[${sqliteFile}] no vector tables, skipping`);
          db.close();
          continue;
        }

        sawVectorTables = true;

        if (vectorCount === 0) {
          cliOutput(`[${sqliteFile}] 0 vectors`);
          db.close();
          continue;
        }

        const keyStmt = db.prepare(`
          SELECT DISTINCT cv.hash || ':' || cv.seq as key FROM content_vectors cv
          JOIN vectors_vec vv ON cv.hash || ':' || cv.seq = vv.hash_seq
        `);
        const rows = keyStmt.all() as Array<{ key: string }>;
        for (const row of rows) {
          uniqueKeys.add(row.key);
        }

        cliOutput(`[${sqliteFile}] ${vectorCount.toLocaleString()} vectors in SQLite`);
        totalVectors += vectorCount;
        dbCount++;
        db.close();
      }

      if (!sawVectorTables || totalVectors === 0) {
        let pointsCount = 0;
        try {
          const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
          if (collectionRes.ok) {
            const collectionData = await collectionRes.json();
            const result = collectionData.result || collectionData;
            pointsCount = result.points_count ?? result.vectors_count ?? 0;
          }
        } catch {
          cliError('❌ Failed to check Qdrant collection');
          process.exit(1);
        }

        cliOutput('SQLite: no vector data (already cleaned up)');
        cliOutput(`Qdrant: ${pointsCount.toLocaleString()} vectors`);
        cliOutput(`ℹ️  Cannot verify — SQLite vectors already cleaned. Qdrant has ${pointsCount.toLocaleString()} vectors.`);
        break;
      }

      cliOutput('───────────────────────────────────────────────────');
      cliOutput(`SQLite total: ${totalVectors.toLocaleString()} vectors (across ${dbCount} databases)`);

      let pointsCount = 0;
      try {
        const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
        if (collectionRes.ok) {
          const collectionData = await collectionRes.json();
          const result = collectionData.result || collectionData;
          pointsCount = result.points_count ?? result.vectors_count ?? 0;
        }
      } catch {
        cliError('❌ Failed to check Qdrant collection');
        process.exit(1);
      }

      const uniqueCount = uniqueKeys.size;
      cliOutput(`Qdrant total: ${pointsCount.toLocaleString()} unique vectors`);
      const difference = totalVectors - pointsCount;
      cliOutput(`Difference: ${difference.toLocaleString()} (expected — cross-workspace duplicates share the same hash:seq key)`);
      cliOutput('');

      if (uniqueCount > pointsCount) {
        const missing = uniqueCount - pointsCount;
        cliOutput(`⚠️  Found ${missing.toLocaleString()} vectors in SQLite not present in Qdrant. Run \`npx nano-brain qdrant migrate\` to sync.`);
      } else {
        cliOutput('✅ Migration verified: Qdrant has all unique vectors');
      }
      break;
    }

    case 'activate': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
      } catch {
        cliError(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        cliError('   Run `npx nano-brain qdrant up` first.');
        process.exit(1);
      }

      let updatedConfig = loadCollectionConfig(globalOpts.configPath);
      if (!updatedConfig) {
        updatedConfig = { collections: {} };
      }
      const newVectorConfig: VectorConfigSection = {
        provider: 'qdrant',
        url: qdrantUrl,
        collection: vectorConfig?.collection || 'nano-brain',
      };
      updatedConfig.vector = newVectorConfig;
      saveCollectionConfig(globalOpts.configPath, updatedConfig);

      cliOutput('✅ Switched to Qdrant provider');
      cliOutput(`   URL: ${qdrantUrl}`);
      cliOutput(`   Collection: ${newVectorConfig.collection}`);
      break;
    }

    case 'cleanup': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const currentProvider = vectorConfig?.provider || 'sqlite-vec';

      if (currentProvider !== 'qdrant') {
        cliError('❌ Cannot cleanup: provider is not set to qdrant');
        cliError(`   Current provider: ${currentProvider}`);
        cliError('   Run `npx nano-brain qdrant activate` first.');
        process.exit(1);
      }

      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
      } catch {
        cliError(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        cliError('   Cannot cleanup without verifying Qdrant has vectors.');
        process.exit(1);
      }

      let pointsCount = 0;
      try {
        const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
        if (collectionRes.ok) {
          const collectionData = await collectionRes.json();
          const result = collectionData.result || collectionData;
          pointsCount = result.points_count ?? result.vectors_count ?? 0;
        }
      } catch {
        cliError('❌ Failed to check Qdrant collection');
        process.exit(1);
      }

      if (pointsCount === 0) {
        cliError('❌ Cannot cleanup: Qdrant collection has no vectors');
        cliError('   Run `npx nano-brain qdrant migrate` first to migrate vectors.');
        process.exit(1);
      }

      cliOutput(`Qdrant has ${pointsCount} vectors. Proceeding with SQLite cleanup...`);

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        cliOutput('No databases found in ' + dataDir);
        return;
      }

      const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (sqliteFiles.length === 0) {
        cliOutput('No SQLite databases found');
        return;
      }

      const sqliteVec = await import('sqlite-vec');

      let cleanedCount = 0;
      let totalSpaceSaved = 0;

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const statBefore = fs.statSync(dbPath);
        const db = openDatabase(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          cliOutput(`[${sqliteFile}] sqlite-vec not available, skipping`);
          db.close();
          continue;
        }

        let hasVectorTables = false;
        try {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vectors_vec', 'content_vectors')").all() as Array<{ name: string }>;
          hasVectorTables = tables.length > 0;
        } catch {
          db.close();
          continue;
        }

        if (!hasVectorTables) {
          cliOutput(`[${sqliteFile}] no vector tables, skipping`);
          db.close();
          continue;
        }

        try {
          db.exec('DROP TABLE IF EXISTS vectors_vec');
          db.exec('DELETE FROM content_vectors');
          db.exec('VACUUM');
          cleanedCount++;

          const statAfter = fs.statSync(dbPath);
          const spaceSaved = statBefore.size - statAfter.size;
          totalSpaceSaved += Math.max(0, spaceSaved);

          cliOutput(`[${sqliteFile}] cleaned`);
        } catch (err) {
          cliError(`[${sqliteFile}] cleanup failed:`, err);
        }

        db.close();
      }

      const spaceMB = (totalSpaceSaved / (1024 * 1024)).toFixed(2);
      cliOutput(`\n✅ Cleaned ${cleanedCount} database(s), ~${spaceMB} MB freed`);
      break;
    }

    case 'recreate': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      if (!vectorConfig) {
        cliError('❌ Qdrant not configured. Run `npx nano-brain qdrant activate` first.');
        process.exit(1);
      }

      const qdrantUrl = vectorConfig.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);
      const collectionName = vectorConfig.collection || 'nano-brain';

      const embedderResult = await createEmbeddingProvider({
        embeddingConfig: config?.embedding,
      });
      if (!embedderResult) {
        cliError('❌ No embedding provider available. Configure embedding in config.yml.');
        process.exit(1);
      }
      const newDimensions = embedderResult.getDimensions();

      if (!commandArgs.includes('--force')) {
        cliOutput(`⚠️  This will DELETE all vectors in collection "${collectionName}" and recreate with ${newDimensions} dimensions.`);
        cliOutput('   Run with --force to skip this prompt.');
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question('Continue? (y/N) ', resolve));
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          cliOutput('Aborted.');
          process.exit(0);
        }
      }

      const qdrantStore = new QdrantVecStore({
        url: resolvedUrl,
        apiKey: vectorConfig.apiKey,
        collection: collectionName,
        dimensions: newDimensions,
      });

      try {
        const { QdrantClient } = await import('@qdrant/js-client-rest');
        const client = new QdrantClient({ url: resolvedUrl, apiKey: vectorConfig.apiKey });

        cliOutput(`Deleting collection "${collectionName}"...`);
        try {
          await client.deleteCollection(collectionName);
        } catch {
          cliOutput('Collection did not exist, creating fresh.');
        }

        cliOutput(`Creating collection "${collectionName}" with ${newDimensions} dimensions...`);
        await client.createCollection(collectionName, {
          vectors: { size: newDimensions, distance: 'Cosine' },
        });
        await client.createPayloadIndex(collectionName, { field_name: 'hash', field_schema: 'keyword' });
        await client.createPayloadIndex(collectionName, { field_name: 'collection', field_schema: 'keyword' });
        await client.createPayloadIndex(collectionName, { field_name: 'projectHash', field_schema: 'keyword' });

        const dataDir = path.join(NANO_BRAIN_HOME, 'data');
        if (fs.existsSync(dataDir)) {
          const dbFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.db'));
          for (const dbFile of dbFiles) {
            const dbPath = path.join(dataDir, dbFile);
            try {
              const db = new Database(dbPath);
              db.exec('DELETE FROM content_vectors');
              const llmCacheExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cache'").get();
              if (llmCacheExists) {
                db.exec('DELETE FROM llm_cache');
              }
              db.close();
              cliOutput(`  Cleared vectors + cache in ${dbFile}`);
            } catch {
              cliError(`  Skipped ${dbFile} (could not open)`);
            }
          }
        }

        cliOutput('');
        cliOutput('✅ Collection recreated successfully.');
        cliOutput(`   Collection: ${collectionName}`);
        cliOutput(`   Dimensions: ${newDimensions}`);
        cliOutput('');
        cliOutput('Next step: Run `npx nano-brain embed` to re-embed all documents.');
      } catch (err) {
        cliError('❌ Failed to recreate collection:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      await qdrantStore.close();
      embedderResult.dispose();
      break;
    }

    default:
      cliError(`Unknown qdrant subcommand: ${subcommand}`);
      cliError('Available: up, down, status, migrate, verify, activate, cleanup, recreate');
      process.exit(1);
  }
}

export function resolveWorkspaceIdentifier(
  identifier: string,
  config: CollectionConfig | null,
  store: Store
): { projectHash: string; workspacePath: string | null } {
  const hexPrefixRegex = /^[a-f0-9]{4,12}$/;

  if (path.isAbsolute(identifier)) {
    const projectHash = crypto.createHash('sha256').update(identifier).digest('hex').substring(0, 12);
    return { projectHash, workspacePath: identifier };
  }

  if (hexPrefixRegex.test(identifier)) {
    const stats = store.getWorkspaceStats();
    const matches = stats.filter(s => s.projectHash.startsWith(identifier));

    if (matches.length === 1) {
      let workspacePath: string | null = null;
      if (config?.workspaces) {
        for (const [wsPath] of Object.entries(config.workspaces)) {
          const hash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
          if (hash === matches[0].projectHash) {
            workspacePath = wsPath;
            break;
          }
        }
      }
      return { projectHash: matches[0].projectHash, workspacePath };
    }

    if (matches.length > 1) {
      const details = matches.map(m => `  ${m.projectHash} (${m.count} docs)`).join('\n');
      throw new Error(`Ambiguous hash prefix "${identifier}" matches ${matches.length} workspaces:\n${details}\nUse a longer prefix or the full workspace path.`);
    }
  }

  if (config?.workspaces) {
    const nameMatches: Array<{ wsPath: string; projectHash: string }> = [];
    for (const wsPath of Object.keys(config.workspaces)) {
      if (path.basename(wsPath) === identifier) {
        const projectHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
        nameMatches.push({ wsPath, projectHash });
      }
    }

    if (nameMatches.length === 1) {
      return { projectHash: nameMatches[0].projectHash, workspacePath: nameMatches[0].wsPath };
    }

    if (nameMatches.length > 1) {
      const details = nameMatches.map(m => `  ${m.wsPath} (${m.projectHash})`).join('\n');
      throw new Error(`Ambiguous name "${identifier}" matches ${nameMatches.length} workspaces:\n${details}\nUse the full path or hash prefix instead.`);
    }
  }

  throw new Error(`No workspace found matching "${identifier}". Run "nano-brain rm --list" to see available workspaces.`);
}

async function handleReset(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'reset command invoked');
  const confirm = commandArgs.includes('--confirm');
  const dryRun = commandArgs.includes('--dry-run');
  const flagDatabases = commandArgs.includes('--databases');
  const flagSessions = commandArgs.includes('--sessions');
  const flagMemory = commandArgs.includes('--memory');
  const flagLogs = commandArgs.includes('--logs');
  const flagVectors = commandArgs.includes('--vectors');

  const hasAnyFlag = flagDatabases || flagSessions || flagMemory || flagLogs || flagVectors;
  const deleteDatabases = !hasAnyFlag || flagDatabases;
  const deleteSessions = !hasAnyFlag || flagSessions;
  const deleteMemory = !hasAnyFlag || flagMemory;
  const deleteLogs = !hasAnyFlag || flagLogs;
  const deleteVectors = !hasAnyFlag || flagVectors;

  if (!confirm && !dryRun) {
    cliError('⚠️  This will permanently delete nano-brain data.');
    cliError('   Run with --confirm to proceed, or --dry-run to preview.');
    process.exit(1);
  }

  const dataDir = DEFAULT_DB_DIR;
  const sessionsDir = DEFAULT_OUTPUT_DIR;
  const memoryDir = DEFAULT_MEMORY_DIR;
  const logsDir = DEFAULT_LOGS_DIR;

  let sqliteFiles: string[] = [];
  if (fs.existsSync(dataDir)) {
    sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
  }

  const sessionsExist = fs.existsSync(sessionsDir);
  const memoryExists = fs.existsSync(memoryDir);
  const logsExist = fs.existsSync(logsDir);

  const config = loadCollectionConfig(globalOpts.configPath);
  const vectorConfig = config?.vector;
  const qdrantUrl = resolveHostUrl(vectorConfig?.url || 'http://localhost:6333');
  let qdrantReachable = false;
  let qdrantPointsCount = 0;

  if (deleteVectors) {
    try {
      const healthRes = await fetch(`${qdrantUrl}/healthz`);
      if (healthRes.ok) {
        qdrantReachable = true;
        const collectionRes = await fetch(`${qdrantUrl}/collections/nano-brain`);
        if (collectionRes.ok) {
          const data = await collectionRes.json();
          const result = data.result || data;
          qdrantPointsCount = result.points_count ?? result.vectors_count ?? 0;
        }
      }
    } catch {
      qdrantReachable = false;
    }
  }

  if (dryRun) {
    cliOutput('Dry run — would delete:');
    cliOutput('');
    if (deleteDatabases) {
      cliOutput(`  SQLite databases:    ${sqliteFiles.length} files in ${dataDir}`);
    }
    if (deleteSessions) {
      cliOutput(`  Harvested sessions:  ${sessionsExist ? sessionsDir : '(not found)'}`);
    }
    if (deleteMemory) {
      cliOutput(`  Memory notes:        ${memoryExists ? memoryDir : '(not found)'}`);
    }
    if (deleteLogs) {
      cliOutput(`  Log files:           ${logsExist ? logsDir : '(not found)'}`);
    }
    if (deleteVectors) {
      if (qdrantReachable) {
        cliOutput(`  Qdrant collection:   nano-brain (${qdrantPointsCount} vectors)`);
      } else {
        cliOutput(`  Qdrant collection:   (not reachable at ${qdrantUrl})`);
      }
    }
    return;
  }

  if (deleteDatabases) {
    for (const file of sqliteFiles) {
      fs.unlinkSync(path.join(dataDir, file));
    }
    if (sqliteFiles.length > 0) {
      cliOutput(`🗑️  Deleted ${sqliteFiles.length} database files from ${dataDir}`);
    } else {
      cliOutput(`ℹ️  No database files found in ${dataDir}`);
    }
  }

  if (deleteSessions) {
    if (sessionsExist) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted harvested sessions from ${sessionsDir}`);
    } else {
      cliOutput(`ℹ️  No harvested sessions directory found`);
    }
  }

  if (deleteMemory) {
    if (memoryExists) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted memory notes from ${memoryDir}`);
    } else {
      cliOutput(`ℹ️  No memory directory found`);
    }
  }

  if (deleteLogs) {
    if (logsExist) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      cliOutput(`🗑️  Deleted log files from ${logsDir}`);
    } else {
      cliOutput(`ℹ️  No logs directory found`);
    }
  }

  if (deleteVectors) {
    if (qdrantReachable) {
      try {
        const deleteRes = await fetch(`${qdrantUrl}/collections/nano-brain`, { method: 'DELETE' });
        if (deleteRes.ok) {
          cliOutput(`🗑️  Deleted Qdrant collection 'nano-brain' (${qdrantPointsCount} vectors)`);
        } else {
          cliError(`⚠️  Failed to delete Qdrant collection: HTTP ${deleteRes.status}`);
        }
      } catch (err) {
        cliError(`⚠️  Failed to delete Qdrant collection: ${err}`);
      }
    } else {
      cliOutput(`ℹ️  Qdrant not reachable at ${qdrantUrl} — skipping vector cleanup`);
    }
  }

  cliOutput('');
  cliOutput('✅ Reset complete.');
}

async function handleRm(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'rm command invoked');
  const config = loadCollectionConfig(globalOpts.configPath);
  let dryRun = false;
  let listMode = false;
  let identifier: string | null = null;

  for (const arg of commandArgs) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--list') {
      listMode = true;
    } else if (!arg.startsWith('-')) {
      identifier = arg;
    }
  }

  if (listMode) {
    const dataDir = path.dirname(globalOpts.dbPath);
    let dbFiles: string[] = [];
    try {
      dbFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite')).map(f => path.join(dataDir, f));
    } catch {
      cliError(`Cannot read data directory: ${dataDir}`);
      process.exit(1);
    }

    if (dbFiles.length === 0) {
      cliOutput('No workspaces found.');
      return;
    }

    cliOutput('Known workspaces:');
    cliOutput('');
    cliOutput('  Name                 Hash          Path                                           Docs');
    cliOutput('  ───────────────────  ────────────  ─────────────────────────────────────────────  ────');

    for (const dbFile of dbFiles) {
      const wsName = extractWorkspaceName(dbFile);
      let docs = 0;
      try {
        const readDb = openDatabase(dbFile, { readonly: true });
        try {
          docs = (readDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
        } catch { /* ignore */ }
        readDb.close();
      } catch { /* ignore */ }

      let wsPath = '';
      const fileHash = path.basename(dbFile, '.sqlite').split('-').pop() || '';
      if (config?.workspaces) {
        for (const [p] of Object.entries(config.workspaces)) {
          const h = crypto.createHash('sha256').update(p).digest('hex').substring(0, 12);
          if (h === fileHash) {
            wsPath = p;
            break;
          }
        }
      }

      cliOutput(`  ${wsName.padEnd(21)}  ${fileHash.padEnd(12)}  ${(wsPath || '(unknown)').padEnd(45)}  ${docs}`);
    }
    return;
  }

  if (!identifier) {
    cliError('Usage: nano-brain rm <workspace> [--dry-run]');
    cliError('       nano-brain rm --list');
    cliError('');
    cliError('<workspace> can be: absolute path, hash prefix, or workspace name');
    process.exit(1);
  }

  const store = await createStore(globalOpts.dbPath);
  try {
    const resolved = resolveWorkspaceIdentifier(identifier, config, store);
    const { projectHash, workspacePath } = resolved;

    if (dryRun) {
      const db = openDatabase(globalOpts.dbPath, { readonly: true });
      const count = (table: string, col: string = 'project_hash') => {
        try {
          return (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} = ?`).get(projectHash) as { cnt: number }).cnt;
        } catch { return 0; }
      };

      cliOutput(`Dry run — would remove workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}:`);
      cliOutput('');
      cliOutput(`  documents:        ${count('documents')}`);
      cliOutput(`  file_edges:       ${count('file_edges')}`);
      cliOutput(`  symbols:          ${count('symbols')}`);
      cliOutput(`  code_symbols:     ${count('code_symbols')}`);
      cliOutput(`  symbol_edges:     ${count('symbol_edges')}`);
      cliOutput(`  execution_flows:  ${count('execution_flows')}`);
      cliOutput(`  llm_cache:        ${count('llm_cache')}`);
      if (workspacePath && config?.workspaces?.[workspacePath]) {
        cliOutput(`  config entry:     ${workspacePath}`);
      }
      if (workspacePath && config?.collections) {
        const normalizedWs = workspacePath.replace(/\/$/, '');
        const affectedCollections = Object.entries(config.collections)
          .filter(([, coll]) => {
            const collPath = coll.path.startsWith('~') ? coll.path.replace('~', os.homedir()) : coll.path;
            return collPath.startsWith(normalizedWs + '/') || collPath === normalizedWs;
          })
          .map(([name]) => name);
        if (affectedCollections.length > 0) {
          cliOutput(`  collections:      ${affectedCollections.join(', ')}`);
        }
      }
      if (workspacePath) {
        const dataDir = path.dirname(globalOpts.dbPath);
        const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
        if (fs.existsSync(wsDbPath)) {
          cliOutput(`  database file:    ${path.basename(wsDbPath)}`);
        }
      }
      cliOutput('');
      cliOutput('Run without --dry-run to execute.');
      db.close();
      return;
    }

    cliOutput(`Removing workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}...`);
    const result = store.removeWorkspace(projectHash);

    let configRemoved = false;
    if (workspacePath) {
      configRemoved = removeWorkspaceConfig(globalOpts.configPath, workspacePath);
    }

    let collectionsRemoved = 0;
    if (workspacePath && config?.collections) {
      const normalizedWs = workspacePath.replace(/\/$/, '');
      const toRemove: string[] = [];
      for (const [name, coll] of Object.entries(config.collections)) {
        const collPath = coll.path.startsWith('~') ? coll.path.replace('~', os.homedir()) : coll.path;
        if (collPath.startsWith(normalizedWs + '/') || collPath === normalizedWs) {
          toRemove.push(name);
        }
      }
      for (const name of toRemove) {
        removeCollection(globalOpts.configPath, name);
        collectionsRemoved++;
      }
    }

    const totalDeleted = result.documentsDeleted + result.embeddingsDeleted + result.contentDeleted
      + result.cacheDeleted + result.fileEdgesDeleted + result.symbolsDeleted
      + result.codeSymbolsDeleted + result.symbolEdgesDeleted + result.executionFlowsDeleted;

    cliOutput('');
    cliOutput('Removed:');
    cliOutput(`  documents:        ${result.documentsDeleted}`);
    cliOutput(`  embeddings:       ${result.embeddingsDeleted}`);
    cliOutput(`  content:          ${result.contentDeleted}`);
    cliOutput(`  cache:            ${result.cacheDeleted}`);
    cliOutput(`  file_edges:       ${result.fileEdgesDeleted}`);
    cliOutput(`  symbols:          ${result.symbolsDeleted}`);
    cliOutput(`  code_symbols:     ${result.codeSymbolsDeleted}`);
    cliOutput(`  symbol_edges:     ${result.symbolEdgesDeleted}`);
    cliOutput(`  execution_flows:  ${result.executionFlowsDeleted}`);
    if (configRemoved) {
      cliOutput(`  config entry:     ${workspacePath}`);
    }
    if (collectionsRemoved > 0) {
      cliOutput(`  collections:      ${collectionsRemoved} removed`);
    }
    cliOutput(`  total rows:       ${totalDeleted}`);

    const db = openDatabase(globalOpts.dbPath, { readonly: true });
    const tables = ['documents', 'file_edges', 'symbols', 'code_symbols', 'symbol_edges', 'execution_flows', 'llm_cache'];
    let remaining = 0;
    for (const table of tables) {
      try {
        remaining += (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project_hash = ?`).get(projectHash) as { cnt: number }).cnt;
      } catch { /* table may not exist */ }
    }
    db.close();

    cliOutput('');
    if (remaining === 0) {
      cliOutput('✅ Verified: zero rows remain for this workspace.');
    } else {
      cliOutput(`⚠️  Warning: ${remaining} rows still found for ${resolveProjectLabel(projectHash)}. Partial removal.`);
    }

    if (workspacePath) {
      const dataDir = path.dirname(globalOpts.dbPath);
      const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
      if (fs.existsSync(wsDbPath) && wsDbPath !== globalOpts.dbPath) {
        try {
          const wsDb = openDatabase(wsDbPath, { readonly: true });
          let wsRemaining = 0;
          try {
            wsRemaining = (wsDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
          } catch { /* ignore */ }
          wsDb.close();
          if (wsRemaining === 0) {
            fs.unlinkSync(wsDbPath);
            try { fs.unlinkSync(wsDbPath + '-wal'); } catch { /* ignore */ }
            try { fs.unlinkSync(wsDbPath + '-shm'); } catch { /* ignore */ }
            cliOutput(`  database file:    ${path.basename(wsDbPath)} deleted`);
          }
        } catch {
          cliError(`  ⚠️  Could not clean up database file: ${path.basename(wsDbPath)}`);
        }
      }
    }
  } catch (err) {
    cliError((err as Error).message);
    process.exit(1);
  } finally {
    store.close();
  }
}

async function handleCategorizeBackfill(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  let batchSize = 50;
  let rateLimit = 10;
  let dryRun = false;
  let workspace: string | undefined;

  for (const arg of commandArgs) {
    if (arg.startsWith('--batch-size=')) {
      batchSize = parseInt(arg.substring(13), 10);
    } else if (arg.startsWith('--rate-limit=')) {
      rateLimit = parseInt(arg.substring(13), 10);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.substring(12);
    }
  }

  log('cli', 'categorize-backfill batch=' + batchSize + ' rate=' + rateLimit + ' dry=' + dryRun);

  const config = loadCollectionConfig(globalOpts.configPath);
  if (!config?.consolidation) {
    cliError('No consolidation config found. Set consolidation section in config.yml');
    process.exit(1);
  }

  const consolidationConfig = config.consolidation as ConsolidationConfig;
  const llmProvider = createLLMProvider(consolidationConfig);
  if (!llmProvider) {
    cliError('No LLM provider configured. Set consolidation.apiKey in config.yml or CONSOLIDATION_API_KEY env var');
    process.exit(1);
  }

  const categorizationConfig = {
    llm_enabled: config?.categorization?.llm_enabled ?? true,
    confidence_threshold: config?.categorization?.confidence_threshold ?? 0.6,
    max_content_length: config?.categorization?.max_content_length ?? 2000,
  };

  const store = await createStore(globalOpts.dbPath);
  const projectHash = workspace
    ? crypto.createHash('sha256').update(workspace).digest('hex').substring(0, 12)
    : undefined;

  const uncategorized = store.getUncategorizedDocuments(batchSize, projectHash);
  const total = uncategorized.length;

  if (total === 0) {
    cliOutput('No uncategorized documents found.');
    store.close();
    return;
  }

  cliOutput(`Found ${total} uncategorized document(s)${dryRun ? ' (dry run)' : ''}`);

  const tagCounts = new Map<string, number>();
  let processed = 0;
  let categorized = 0;
  const delayMs = Math.ceil(1000 / rateLimit);

  for (const doc of uncategorized) {
    processed++;
    const truncatedContent = doc.body.slice(0, categorizationConfig.max_content_length);

    if (dryRun) {
      cliOutput(`[${processed}/${total}] Would categorize: ${doc.path}`);
      continue;
    }

    try {
      const { categorizeMemory } = await import('./llm-categorizer.js');
      const tags = await categorizeMemory(truncatedContent, llmProvider, categorizationConfig);

      if (tags.length > 0) {
        store.insertTags(doc.id, tags);
        categorized++;
        for (const tag of tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      const tagStr = tags.length > 0 ? tags.join(', ') : '(no tags)';
      cliOutput(`[${processed}/${total}] ${doc.path}: ${tagStr}`);

      if (processed < total) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      cliError(`[${processed}/${total}] Error categorizing ${doc.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  store.close();

  cliOutput('');
  if (dryRun) {
    cliOutput(`Dry run complete. Would process ${total} document(s).`);
  } else {
    cliOutput(`Categorization complete: ${categorized}/${processed} documents tagged`);
    if (tagCounts.size > 0) {
      cliOutput('Tag distribution:');
      const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [tag, count] of sorted) {
        cliOutput(`  ${tag}: ${count}`);
      }
    }
  }
}

async function handleConsolidate(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'consolidate');
  const store = await createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);

  if (!config?.consolidation?.enabled) {
    cliOutput('Consolidation is not enabled. Set consolidation.enabled=true in config.yml');
    store.close();
    return;
  }

  try {
    const consolidationConfig = config.consolidation as ConsolidationConfig;
    const provider = createLLMProvider(consolidationConfig);

    if (!provider) {
      cliOutput('No API key configured. Set consolidation.apiKey in config.yml or CONSOLIDATION_API_KEY env var');
      return;
    }

    const agent = new ConsolidationAgent(store, {
      llmProvider: provider,
      maxMemoriesPerCycle: consolidationConfig.max_memories_per_cycle,
      minMemoriesThreshold: consolidationConfig.min_memories_threshold,
      confidenceThreshold: consolidationConfig.confidence_threshold,
    });

    const results = await agent.runConsolidationCycle();

    if (results.length === 0) {
      cliOutput('No memories to consolidate');
    } else {
      cliOutput(`Consolidation complete: ${results.length} consolidation(s) created`);
    }
  } catch (err) {
    cliError('Consolidation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    store.close();
  }
}

async function handleLearning(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (subcommand === 'rollback') {
    const versionId = commandArgs[1] ? parseInt(commandArgs[1], 10) : undefined;
    const store = await createStore(globalOpts.dbPath);
    try {
      if (versionId) {
        const version = store.getConfigVersion(versionId);
        if (!version) {
          cliError('Config version ' + versionId + ' not found');
          process.exit(1);
        }
        cliOutput('Config version ' + versionId + ' (created ' + version.created_at + ')');
        cliOutput('Config:', version.config_json);
      } else {
        const latest = store.getLatestConfigVersion();
        if (!latest) {
          cliOutput('No config versions found. Learning has not been active.');
        } else {
          cliOutput('Latest config version: ' + latest.version_id + ' (created ' + latest.created_at + ')');
          cliOutput('Config:', latest.config_json);
          cliOutput('\nUse: nano-brain learning rollback <version_id>');
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  cliError('Usage: nano-brain learning rollback [version_id]');
  cliError('');
  cliError('Commands:');
  cliError('  rollback [version_id]  View or rollback to a previous config version');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  const globalOpts = parseGlobalOptions(args);

  const cliConfig = loadCollectionConfig(globalOpts.configPath);
  initLogger(cliConfig ?? undefined);

  const command = globalOpts.remaining[0] || 'mcp';
  const commandArgs = globalOpts.remaining.slice(1);

  log('cli', 'command=' + command);

  // Resolve per-workspace DB path.
  // Daemon mode (serve or mcp --daemon) skips early resolution — startServer() resolves
  // using the correct workspace root from config.yml instead of process.cwd()
  const isDaemonMode = command === 'serve' || (command === 'mcp' && commandArgs.includes('--daemon'));
  if (command !== 'init' && !isDaemonMode) {
    globalOpts.dbPath = resolveDbPath(globalOpts.dbPath, process.cwd());
  }

  switch (command) {
    case 'mcp':
      return handleMcp(globalOpts, commandArgs);
    case 'serve':
      return handleServe(globalOpts, commandArgs);
    case 'init':
      return handleInit(globalOpts, commandArgs);
    case 'collection':
      return handleCollection(globalOpts, commandArgs);
    case 'status':
      return handleStatus(globalOpts, commandArgs);
    case 'update':
      return handleUpdate(globalOpts);
    case 'embed':
      return handleEmbed(globalOpts, commandArgs);
    case 'search':
      return handleSearch(globalOpts, commandArgs, 'fts');
    case 'vsearch':
      return handleSearch(globalOpts, commandArgs, 'vec');
    case 'query':
      return handleSearch(globalOpts, commandArgs, 'hybrid');
    case 'get':
      return handleGet(globalOpts, commandArgs);
    case 'harvest':
      return handleHarvest(globalOpts);
    case 'cache':
      return handleCache(globalOpts, commandArgs);
    case 'write':
      return handleWrite(globalOpts, commandArgs);
    case 'bench':
      return handleBench(globalOpts, commandArgs);
    case 'tags':
      return handleTags(globalOpts);
    case 'focus':
      return handleFocus(globalOpts, commandArgs);
    case 'graph-stats':
      return handleGraphStats(globalOpts);
    case 'symbols':
      return handleSymbols(globalOpts, commandArgs);
    case 'impact':
      return handleImpact(globalOpts, commandArgs);
    case 'logs':
      return handleLogs(commandArgs);
    case 'qdrant':
      return handleQdrant(globalOpts, commandArgs);
    case 'reset':
      return handleReset(globalOpts, commandArgs);
    case 'rm':
      return handleRm(globalOpts, commandArgs);
    case 'context':
      return handleContext(globalOpts, commandArgs);
    case 'code-impact':
      return handleCodeImpact(globalOpts, commandArgs);
    case 'detect-changes':
      return handleDetectChanges(globalOpts, commandArgs);
    case 'reindex':
      return handleReindex(globalOpts, commandArgs);
    case 'consolidate':
      return handleConsolidate(globalOpts, commandArgs);
    case 'categorize-backfill':
      return handleCategorizeBackfill(globalOpts, commandArgs);
    case 'learning':
      return handleLearning(globalOpts, commandArgs);
    default:
      cliError(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('cli.js') ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch(err => {
    cliError('Fatal error:', err);
    process.exit(1);
  });
}
