import { startServer } from './server.js';
import { createStore, computeHash, indexDocument, extractProjectHashFromPath, resolveWorkspaceDbPath, resolveProjectLabel, setProjectLabelDataDir } from './store.js';
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
import type { SearchResult, CollectionConfig, Store } from './types.js';
import { ResultCache } from './cache.js';
import { formatCompactResults } from './server.js';
import type { VectorPoint, VectorStoreHealth } from './vector-store.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import { log, initLogger } from './logger.js';

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
  console.log(`
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
    stop            Stop running server
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
  learning          Manage self-learning system
    rollback [id]   View or rollback to a previous config version
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
    console.log(`nano-brain v${pkg.version}`);
  } catch {
    console.log('nano-brain (unknown version)');
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
      console.log('Daemon stop not implemented yet');
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
    try {
      const pid = parseInt(fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      fs.unlinkSync(SERVE_PID_FILE);
      console.log(`Stopped nano-brain server (PID: ${pid})`);
    } catch {
      console.log('No running server found');
    }
    return;
  }

  // serve status
  if (subcommand === 'status') {
    try {
      const pid = parseInt(fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 0); // check if alive
      console.log(`nano-brain server is running (PID: ${pid}, port: ${port})`);
    } catch {
      console.log('nano-brain server is not running');
    }
    return;
  }

  // serve install
  if (subcommand === 'install') {
    const result = installService({ force, port });
    if (result.success) {
      console.log(`✅ ${result.message}`);
      console.log(`   The server will start automatically on login.`);
      console.log(`   Port: ${port}`);
    } else {
      console.error(`❌ ${result.message}`);
      process.exit(1);
    }
    return;
  }

  // serve uninstall
  if (subcommand === 'uninstall') {
    const result = uninstallService();
    if (result.success) {
      console.log(`✅ ${result.message}`);
    } else {
      console.error(`❌ ${result.message}`);
      process.exit(1);
    }
    return;
  }

  // serve (start)
  if (foreground) {
    return handleMcp(globalOpts, ['--http', `--port=${port}`, '--host=0.0.0.0', '--daemon', ...(root ? [`--root=${root}`] : [])]);
  }

  // Check if already running
  try {
    const existingPid = parseInt(fs.readFileSync(SERVE_PID_FILE, 'utf-8').trim(), 10);
    process.kill(existingPid, 0);
    console.log(`Server already running (PID: ${existingPid}). Stop first: npx nano-brain serve stop`);
    return;
  } catch {
    // Not running, proceed
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
    console.log(`nano-brain server started on http://0.0.0.0:${port} (PID: ${child.pid})`);
    console.log(`  SSE endpoint: http://localhost:${port}/sse`);
    console.log(`  Health check: http://localhost:${port}/health`);
    console.log(`  Logs: ${SERVE_LOG_FILE}`);
    console.log(`  Stop: npx nano-brain serve stop`);
  } else {
    console.error('Failed to start server');
    process.exit(1);
  }

  fs.closeSync(logFd);
  process.exit(0);
}

async function handleCollection(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];
  
  if (!subcommand) {
    console.error('Missing collection subcommand (add, remove, list, rename)');
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
        console.error('Usage: collection add <name> <path> [--pattern=<glob>]');
        process.exit(1);
      }
      
      addCollection(globalOpts.configPath, name, collectionPath, pattern);
      console.log(`✅ Added collection "${name}"`);
      break;
    }
    
    case 'remove': {
      const name = commandArgs[1];
      if (!name) {
        console.error('Usage: collection remove <name>');
        process.exit(1);
      }
      
      removeCollection(globalOpts.configPath, name);
      console.log(`✅ Removed collection "${name}"`);
      break;
    }
    
    case 'list': {
      const config = loadCollectionConfig(globalOpts.configPath);
      if (!config) {
        console.log('No collections configured');
        return;
      }
      
      const names = listCollections(config);
      if (names.length === 0) {
        console.log('No collections configured');
      } else {
        console.log('Collections:');
        for (const name of names) {
          const coll = config.collections[name];
          console.log(`  ${name}: ${coll.path} (${coll.pattern || '**/*.md'})`);
        }
      }
      break;
    }
    
    case 'rename': {
      const oldName = commandArgs[1];
      const newName = commandArgs[2];
      
      if (!oldName || !newName) {
        console.error('Usage: collection rename <old> <new>');
        process.exit(1);
      }
      
      renameCollection(globalOpts.configPath, oldName, newName);
      console.log(`✅ Renamed collection "${oldName}" to "${newName}"`);
      break;
    }
    
    default:
      console.error(`Unknown collection subcommand: ${subcommand}`);
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
  console.log('Vector Store:');
  if (vectorHealth) {
    console.log(`  Provider:   ${vectorHealth.provider}`);
    if (vectorHealth.ok) {
      console.log(`  Status:     ✅ connected`);
      console.log(`  Vectors:    ${vectorHealth.vectorCount.toLocaleString()}`);
      if (vectorHealth.dimensions) {
        console.log(`  Dimensions: ${vectorHealth.dimensions}`);
      }
    } else {
      console.log(`  Status:     ❌ unreachable (${vectorHealth.error || 'unknown'})`);
    }
  } else {
    console.log(`  Provider:   sqlite-vec (built-in)`);
    console.log(`  Vectors:    ${(sqliteVecCount ?? 0).toLocaleString()}`);
  }
  console.log('');
}

function printTokenUsageSection(tokenUsage: Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }>): void {
  if (tokenUsage.length === 0) return;
  console.log('Token Usage:');
  for (const usage of tokenUsage) {
    console.log(`  ${usage.model.padEnd(25)} ${usage.totalTokens.toLocaleString()} tokens (${usage.requestCount.toLocaleString()} requests)`);
  }
  console.log('');
}

async function printEmbeddingServerStatus(config: ReturnType<typeof loadCollectionConfig>): Promise<void> {
  const embeddingConfig = config?.embedding;
  const url = embeddingConfig?.url || detectOllamaUrl();
  const model = embeddingConfig?.model || 'nomic-embed-text';
  const provider = embeddingConfig?.provider || 'ollama';

  console.log('Embedding Server:');
  console.log(`  Provider:  ${provider}`);
  console.log(`  URL:       ${url}`);
  console.log(`  Model:     ${model}`);

  if (provider === 'openai') {
    const openAiHealth = await checkOpenAIHealth(url, embeddingConfig?.apiKey || '', model);
    if (openAiHealth.reachable) {
      console.log(`  Status:    ✅ connected`);
    } else {
      console.log(`  Status:    ❌ unreachable (${openAiHealth.error})`);
    }
  } else if (provider !== 'local') {
    const ollamaHealth = await checkOllamaHealth(url);
    if (ollamaHealth.reachable) {
      console.log(`  Status:    ✅ connected`);
    } else {
      console.log(`  Status:    ❌ unreachable (${ollamaHealth.error})`);
    }
  } else {
    console.log(`  Status:    local GGUF mode`);
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
      console.error(`Cannot read data directory: ${dataDir}`);
      return;
    }

    if (dbFiles.length === 0) {
      console.log('No workspaces found.');
      return;
    }

    console.log('nano-brain Status — All Workspaces');
    console.log('═══════════════════════════════════════════════════');
    console.log('');

    if (serverInfo) {
      const uptimeSec = Math.floor(serverInfo.uptime);
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const secs = uptimeSec % 60;
      const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      console.log('Server:');
      console.log(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
      console.log(`  Uptime:   ${uptimeStr}`);
      console.log(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
      console.log('');
    }

    const header = '  Workspace              Documents  Embedded  Pending  DB Size';
    const divider = '  ─────────────────────  ─────────  ────────  ───────  ───────';
    console.log(header);
    console.log(divider);

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
        const readDb = new Database(dbFile, { readonly: true });
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
      console.log(`  ${name}  ${docsStr}  ${embeddedStr}  ${pendingStr}  ${sizeStr}`);
    }

    console.log('');
    console.log(`  Total: ${dbFiles.length} workspaces, ${totalDocs.toLocaleString()} documents, ${totalPending.toLocaleString()} pending embeddings, ${formatBytes(totalSize)}`);
    console.log('');

    await printEmbeddingServerStatus(config);
    console.log('');

    const vectorHealth = await getVectorStoreHealth(config);
    printVectorStoreSection(vectorHealth);

    const allTokenUsage = new Map<string, { totalTokens: number; requestCount: number; lastUpdated: string }>();
    for (const dbFile of dbFiles) {
      try {
        const readDb = new Database(dbFile, { readonly: true });
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

  const store = createStore(resolvedDbPath);
  const health = store.getIndexHealth();

  console.log(`nano-brain Status — ${workspaceName}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  if (serverInfo) {
    const uptimeSec = Math.floor(serverInfo.uptime);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    console.log('Server:');
    console.log(`  Status:   running (port ${DEFAULT_HTTP_PORT})`);
    console.log(`  Uptime:   ${uptimeStr}`);
    console.log(`  Ready:    ${serverInfo.ready ? 'yes' : 'no'}`);
    console.log('');
  }

  console.log('Database:');
  console.log(`  Path:     ${resolvedDbPath.replace(os.homedir(), '~')}`);
  console.log(`  Size:     ${formatBytes(dbSize)} (on disk)`);
  console.log('');

  console.log('Index:');
  console.log(`  Documents:          ${health.documentCount.toLocaleString()}`);
  console.log(`  Embedded:           ${health.embeddedCount.toLocaleString()}`);
  console.log(`  Pending embeddings: ${health.pendingEmbeddings.toLocaleString()}`);
  console.log('');

  if (health.collections.length > 0) {
    console.log('Collections:');
    for (const coll of health.collections) {
      console.log(`  ${coll.name.padEnd(10)} ${coll.documentCount.toLocaleString()} documents`);
    }
    console.log('');
  }

  const wsConfig = getWorkspaceConfig(config, workspaceRoot);
  const codebaseStats = getCodebaseStats(store, wsConfig?.codebase, workspaceRoot);
  if (codebaseStats) {
    console.log('Codebase:');
    console.log(`  Enabled:    ${codebaseStats.enabled}`);
    console.log(`  Storage:    ${formatBytes(codebaseStats.storageUsed)} / ${formatBytes(codebaseStats.maxSize)}`);
    console.log(`  Extensions: ${codebaseStats.extensions.join(', ') || 'auto-detect'}`);
    console.log(`  Excludes:   ${codebaseStats.excludeCount} patterns`);
    console.log('');
  }

  // Code Intelligence (symbol graph)
  try {
    const symbolDb = new Database(resolvedDbPath);
    const symbolCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    const edgeCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    let flowCount = 0;
    try {
      flowCount = (symbolDb.prepare('SELECT COUNT(*) as cnt FROM execution_flows WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
    } catch { /* table may not exist */ }
    symbolDb.close();

    console.log('Code Intelligence:');
    console.log(`  Symbols:    ${symbolCount.toLocaleString()}`);
    console.log(`  Edges:      ${edgeCount.toLocaleString()}`);
    console.log(`  Flows:      ${flowCount.toLocaleString()}`);
    if (symbolCount === 0) {
      console.log('  ⚠️  Empty — run `npx nano-brain reindex` to populate');
    }
    console.log('');
  } catch { /* code_symbols table may not exist in older DBs */ }

  await printEmbeddingServerStatus(config);
  console.log('');

  const vectorHealth = await getVectorStoreHealth(config);
  printVectorStoreSection(vectorHealth, vectorHealth ? undefined : store.getSqliteVecCount());

  printTokenUsageSection(store.getTokenUsage());

  console.log('Models:');
  console.log(`  Embedding: ${health.modelStatus.embedding}`);
  console.log(`  Reranker:  ${health.modelStatus.reranker}`);
  console.log(`  Expander:  ${health.modelStatus.expander}`);
  store.close();
}

async function handleInit(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
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
    console.log(`✅ Created config: ${configPath}`);
  } else if (!config.embedding) {
    config.embedding = {
      provider: 'ollama',
      url: detectOllamaUrl(),
      model: 'nomic-embed-text'
    };
    saveCollectionConfig(configPath, config);
    console.log(`✅ Updated config with embedding section`);
  } else {
    console.log(`ℹ️  Config exists: ${configPath}`);
  }
  
  if (config.embedding?.provider !== 'openai') {
    const ollamaUrl = config.embedding?.url || detectOllamaUrl();
    const ollamaHealth = await checkOllamaHealth(ollamaUrl);
    
    if (ollamaHealth.reachable) {
      console.log(`✅ Ollama reachable at ${ollamaUrl}`);
    } else {
      console.log(`⚠️  Ollama not reachable at ${ollamaUrl} — will use local GGUF fallback`);
    }
  }

  if (all && !force) {
    console.log('⚠️  --all ignored without --force');
  }

  if (force && all) {
    const dataDir = path.dirname(globalOpts.dbPath);
    let deletedCount = 0;
    if (fs.existsSync(dataDir)) {
      const sqliteFiles = fs.readdirSync(dataDir).filter(file => file.endsWith('.sqlite'));
      for (const file of sqliteFiles) {
        fs.unlinkSync(path.join(dataDir, file));
      }
      deletedCount = sqliteFiles.length;
    }
    console.log(`🗑️  Force --all: deleted ${deletedCount} database files from ${dataDir}`);
  }
  
  const store = createStore(globalOpts.dbPath);
  if (!config.workspaces) {
    config.workspaces = {};
  }
  if (!config.workspaces[root]) {
    config.workspaces[root] = {
      codebase: { enabled: true }
    };
    saveCollectionConfig(configPath, config);
    console.log(`✅ Enabled codebase indexing for workspace: ${root}`);
  } else {
    console.log(`ℹ️  Workspace already configured: ${root}`);
  }
  const projectHash = crypto.createHash('sha256').update(root).digest('hex').substring(0, 12);
  if (force && !all) {
    console.log('🗑️  Force mode: clearing workspace memory...');
    const cleared = store.clearWorkspace(projectHash);
    console.log(`   Deleted ${cleared.documentsDeleted} documents, ${cleared.embeddingsDeleted} embeddings`);
  }
  console.log('📂 Indexing codebase...');
  const wsConfig = config.workspaces[root];
  const codebaseConfig = wsConfig?.codebase ?? { enabled: true };
  const db = new Database(globalOpts.dbPath);
  const codebaseStats = await indexCodebase(store, root, codebaseConfig, projectHash, undefined, db);
  db.close();
  console.log(`✅ Indexed ${codebaseStats.filesIndexed} files (${codebaseStats.filesSkippedUnchanged} unchanged)`);
  
  console.log('📜 Harvesting sessions...');
  const sessionDir = resolveOpenCodeStorageDir();
  const sessions = await harvestSessions({ sessionDir, outputDir: DEFAULT_OUTPUT_DIR });
  console.log(`✅ Harvested ${sessions.length} sessions`);
  
  console.log('📚 Indexing collections...');
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
    console.log(`  ${collection.name}: ${files.length} files (${collIndexed} new)`);
  }
  if (skippedCount > 0) {
    console.log(`  (${skippedCount} other collection(s) deferred to MCP watcher)`);
  }
  console.log(`✅ Indexed ${totalIndexed} documents from collections`);
  // Generate embeddings — cap at 50 during init, MCP server handles the rest
  console.log('🧠 Generating embeddings...');
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
    console.log(`✅ Embedded ${embedded} documents${remaining > 0 ? ` (${remaining} remaining — MCP server will continue in background)` : ''}`);
    provider.dispose();
  } else {
    const pending = store.getHashesNeedingEmbedding();
    console.log(`⚠️  No embedding provider available — ${pending.length} documents pending`);
    console.log(`   Run 'npx nano-brain embed' later to generate embeddings`);
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
        console.log(`✅ Updated AGENTS.md with memory snippet`);
      } else {
        fs.appendFileSync(agentsPath, '\n\n' + snippet);
        console.log(`✅ Appended memory snippet to AGENTS.md`);
      }
    } else {
      fs.writeFileSync(agentsPath, snippet);
      console.log(`✅ Created AGENTS.md with memory snippet`);
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
    console.log(`✅ Installed ${commandFiles.length} slash commands (global + project)`);
  }
  console.log('');
  console.log('nano-brain initialized! Run `npx nano-brain status` to verify.');
}

async function handleUpdate(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'update start');
  const store = createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);
  
  if (!config) {
    console.error('No config file found');
    store.close();
    process.exit(1);
  }
  
  const collections = getCollections(config);
  let totalIndexed = 0;
  let totalSkipped = 0;
  
  for (const collection of collections) {
    console.log(`Scanning collection: ${collection.name}`);
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
  
  console.log(`✅ Indexed ${totalIndexed} documents, skipped ${totalSkipped}`);
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
  const store = createStore(globalOpts.dbPath);
  const hashes = store.getHashesNeedingEmbedding();
  
  if (hashes.length === 0) {
    console.log('No chunks need embedding');
    store.close();
    return;
  }
  
  log('cli', 'embed pending count=' + hashes.length);
  console.log(`Found ${hashes.length} chunks needing embeddings`);
  console.log('Loading embedding model...');
  
  const config = loadCollectionConfig(globalOpts.configPath);
  const provider = await createEmbeddingProvider({ embeddingConfig: config?.embedding });
  
  if (!provider) {
    console.error('Failed to load embedding provider');
    store.close();
    process.exit(1);
  }
  
  store.ensureVecTable(provider.getDimensions());
  console.log('Generating embeddings...');
  
  const embedded = await embedPendingCodebase(store, provider, 50);
  
  console.log(`✅ Embedded ${embedded} documents`);
  
  provider.dispose();
  store.close();
}

async function handleSearch(
  globalOpts: GlobalOptions,
  commandArgs: string[],
  mode: 'fts' | 'vec' | 'hybrid'
): Promise<void> {
  log('cli', 'search mode=' + mode + ' query=' + (commandArgs[0] || ''));
  const query = commandArgs[0];
  
  if (!query) {
    console.error('Missing query argument');
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
  
  const serverRunning = await detectRunningServer(DEFAULT_HTTP_PORT);
  if (serverRunning) {
    try {
      const endpoint = mode === 'fts' ? '/api/search' : '/api/query';
      const data = await proxyPost(DEFAULT_HTTP_PORT, endpoint, { query, limit, tags: tags?.join(','), scope });
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else if (format === 'files') {
        console.log(data.results?.map((r: any) => r.path).join('\n') || '');
      } else if (compact) {
        const cache = new ResultCache();
        const cacheKey = cache.set(data.results || [], query);
        console.log(formatCompactResults(data.results || [], cacheKey));
      } else {
        console.log(formatSearchOutput(data.results || [], 'text'));
      }
      return;
    } catch (err) {
      log('cli', 'HTTP proxy failed, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  
  const workspaceRoot = process.cwd();
  const projectHash = scope === 'all' ? 'all' : crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  
  const store = createStore(globalOpts.dbPath);
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
      console.error('Vector search requires embedding model');
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
    console.log(formatCompactResults(results, cacheKey));
  } else {
    console.log(formatSearchOutput(results, format));
  }
  store.close();
}

async function handleGet(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const id = commandArgs[0];
  
  if (!id) {
    console.error('Missing document id or path');
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
  
  const store = createStore(globalOpts.dbPath);
  const doc = store.findDocument(id);
  
  if (!doc) {
    console.error(`Document not found: ${id}`);
    store.close();
    process.exit(1);
  }
  
  console.log(`Document: ${doc.collection}/${doc.path}`);
  console.log(`Title: ${doc.title}`);
  console.log(`Docid: ${doc.hash.substring(0, 6)}`);
  console.log('');
  
  const body = store.getDocumentBody(doc.hash, fromLine, maxLines);
  if (body) {
    console.log(body);
  }
  
  store.close();
}

async function handleHarvest(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'harvest start');
  const sessionDir = resolveOpenCodeStorageDir();
  const outputDir = DEFAULT_OUTPUT_DIR;
  
  console.log('Harvesting sessions...');
  const sessions = await harvestSessions({ sessionDir, outputDir });
  
  console.log(`✅ Harvested ${sessions.length} sessions to ${outputDir}`);
}

async function handleWrite(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const content = commandArgs[0]
  
  if (!content) {
    console.error('Usage: write "content here" [--supersedes=<path-or-docid>] [--tags=<comma-separated>]')
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
  const store = createStore(globalOpts.dbPath)
  
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
  
  console.log(`✅ Written to ${targetPath} [${workspaceName}]${supersedeWarning}${tagInfo}`)
}

async function handleTags(globalOpts: GlobalOptions): Promise<void> {
  const store = createStore(globalOpts.dbPath)
  const tags = store.listAllTags()
  
  if (tags.length === 0) {
    console.log('No tags found.')
    store.close()
    return
  }
  
  console.log('Tags:')
  for (const { tag, count } of tags) {
    console.log(`  ${tag}: ${count} document${count === 1 ? '' : 's'}`)
  }
  store.close()
}

async function handleFocus(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const filePath = commandArgs[0]
  
  if (!filePath) {
    console.error('Usage: focus <filepath>')
    process.exit(1)
  }
  
  log('cli', 'focus file=' + filePath);
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  const store = createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)
  
  const dependencies = store.getFileDependencies(absolutePath, projectHash)
  const dependents = store.getFileDependents(absolutePath, projectHash)
  const centralityInfo = store.getDocumentCentrality(absolutePath)
  
  console.log(`File: ${absolutePath}`)
  console.log('')
  
  if (centralityInfo) {
    console.log(`Centrality: ${centralityInfo.centrality.toFixed(4)}`)
    if (centralityInfo.clusterId !== null) {
      const clusterMembers = store.getClusterMembers(centralityInfo.clusterId, projectHash)
      console.log(`Cluster ID: ${centralityInfo.clusterId} (${clusterMembers.length} members)`)
      if (clusterMembers.length > 0) {
        console.log('Cluster Members:')
        for (const member of clusterMembers.slice(0, 10)) {
          console.log(`  - ${member}`)
        }
        if (clusterMembers.length > 10) {
          console.log(`  ... and ${clusterMembers.length - 10} more`)
        }
      }
    }
  } else {
    console.log('Centrality: Not indexed')
  }
  console.log('')
  
  console.log(`Dependencies (imports): ${dependencies.length}`)
  for (const dep of dependencies) {
    console.log(`  → ${dep}`)
  }
  console.log('')
  
  console.log(`Dependents (imported by): ${dependents.length}`)
  for (const dep of dependents) {
    console.log(`  ← ${dep}`)
  }
  
  store.close()
}

async function handleGraphStats(globalOpts: GlobalOptions): Promise<void> {
  log('cli', 'graph-stats invoked');
  const store = createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)
  
  const stats = store.getGraphStats(projectHash)
  const edges = store.getFileEdges(projectHash)
  const cycles = findCycles(edges.map(e => ({ source: e.source_path, target: e.target_path })), 5)
  
  console.log('Graph Statistics')
  console.log('═══════════════════════════════════════════════════')
  console.log('')
  console.log(`Nodes: ${stats.nodeCount}`)
  console.log(`Edges: ${stats.edgeCount}`)
  console.log(`Clusters: ${stats.clusterCount}`)
  console.log('')
  
  if (stats.topCentrality.length > 0) {
    console.log('Top 10 by Centrality:')
    for (const { path: filePath, centrality } of stats.topCentrality) {
      console.log(`  ${centrality.toFixed(4)} - ${filePath}`)
    }
    console.log('')
  }
  
  if (cycles.length > 0) {
    console.log(`Cycles (length ≤ 5): ${cycles.length}`)
    for (const cycle of cycles.slice(0, 5)) {
      console.log(`  ${cycle.join(' → ')} → ${cycle[0]}`)
    }
    if (cycles.length > 5) {
      console.log(`  ... and ${cycles.length - 5} more`)
    }
  } else {
    console.log('Cycles: None detected')
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
  const store = createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.querySymbols({
    type,
    pattern,
    repo,
    operation,
    projectHash,
  })

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    console.log('No symbols found matching the criteria.')
    store.close()
    return
  }

  const grouped = new Map<string, Array<{ operation: string; repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    const key = `${r.type}:${r.pattern}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push({ operation: r.operation, repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  console.log(`Found ${results.length} symbol(s) across ${grouped.size} pattern(s)`)
  console.log('')

  for (const [key, items] of grouped) {
    const [symbolType, symbolPattern] = key.split(':')
    console.log(`${symbolType}: ${symbolPattern}`)
    for (const item of items) {
      console.log(`  [${item.operation}] ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    console.log('')
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
    console.error('Usage: impact --type=<type> --pattern=<pattern> [--json]')
    console.error('Types: redis_key, pubsub_channel, mysql_table, api_endpoint, http_call, bull_queue')
    process.exit(1)
  }

  const store = createStore(globalOpts.dbPath)
  const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12)

  const results = store.getSymbolImpact(type, pattern, projectHash)

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2))
    store.close()
    return
  }

  if (results.length === 0) {
    console.log(`No symbols found for ${type}: ${pattern}`)
    store.close()
    return
  }

  const byOperation = new Map<string, Array<{ repo: string; filePath: string; lineNumber: number }>>()
  for (const r of results) {
    if (!byOperation.has(r.operation)) byOperation.set(r.operation, [])
    byOperation.get(r.operation)!.push({ repo: r.repo, filePath: r.filePath, lineNumber: r.lineNumber })
  }

  console.log(`Impact Analysis: ${type} "${pattern}"`)
  console.log('')

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
    console.log(`${label} (${items.length}):`)
    for (const item of items) {
      console.log(`  ${item.repo}: ${item.filePath}:${item.lineNumber}`)
    }
    console.log('')
  }

  store.close()
}

function warnIfEmptySymbolGraph(db: Database.Database, projectHash: string): boolean {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number };
  if (count.cnt === 0) {
    console.error('⚠️  Symbol graph is empty. Run `npx nano-brain reindex` first.');
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
    console.error('Usage: context <symbol-name> [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'context name=' + name + ' file=' + (filePath || ''));
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = new Database(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleContext({ name, filePath, projectHash });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      console.log(`Multiple symbols named "${name}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        console.log(`  ${s.kind} ${s.name} — ${s.filePath}:${s.startLine}`);
      }
    } else {
      console.log(`Symbol "${name}" not found.`);
    }
    db.close();
    return;
  }

  const sym = result.symbol!;
  console.log(`${sym.kind} ${sym.name}`);
  console.log(`  File: ${sym.filePath}:${sym.startLine}-${sym.endLine}`);
  console.log(`  Exported: ${sym.exported ? 'yes' : 'no'}`);
  if (result.clusterLabel) {
    console.log(`  Cluster: ${result.clusterLabel}`);
  }
  console.log('');

  if (result.incoming && result.incoming.length > 0) {
    console.log(`Callers (${result.incoming.length}):`);
    for (const e of result.incoming) {
      console.log(`  ← ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    console.log('');
  }

  if (result.outgoing && result.outgoing.length > 0) {
    console.log(`Callees (${result.outgoing.length}):`);
    for (const e of result.outgoing) {
      console.log(`  → ${e.kind} ${e.name} (${e.filePath}) [${e.edgeType}]`);
    }
    console.log('');
  }

  if (result.flows && result.flows.length > 0) {
    console.log(`Flows (${result.flows.length}):`);
    for (const f of result.flows) {
      console.log(`  ${f.flowType}: ${f.label} (step ${f.stepIndex})`);
    }
    console.log('');
  }

  if (result.infrastructureSymbols && result.infrastructureSymbols.length > 0) {
    console.log(`Infrastructure:`);
    for (const s of result.infrastructureSymbols) {
      console.log(`  [${s.operation}] ${s.type}: ${s.pattern}`);
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
    console.error('Usage: code-impact <symbol-name> [--direction=upstream|downstream] [--max-depth=N] [--min-confidence=N] [--file=<path>] [--json]');
    process.exit(1);
  }

  log('cli', 'code-impact target=' + target + ' direction=' + direction + ' depth=' + maxDepth);
  const workspaceRoot = process.cwd();
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, workspaceRoot);
  const db = new Database(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleImpact({ target, direction, maxDepth, minConfidence, filePath, projectHash });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (!result.found) {
    if (result.disambiguation) {
      console.log(`Multiple symbols named "${target}". Use --file= to disambiguate:`);
      for (const s of result.disambiguation) {
        console.log(`  ${s.kind} ${s.name} — ${s.filePath}`);
      }
    } else {
      console.log(`Symbol "${target}" not found.`);
    }
    db.close();
    return;
  }

  const t = result.target!;
  console.log(`Impact Analysis: ${t.kind} ${t.name} (${t.filePath})`);
  console.log(`  Direction: ${direction}`);
  console.log(`  Risk: ${result.risk}`);
  console.log(`  Direct deps: ${result.summary.directDeps}, Total affected: ${result.summary.totalAffected}, Flows: ${result.summary.flowsAffected}`);
  console.log('');

  for (const [depth, symbols] of Object.entries(result.byDepth)) {
    if (symbols.length > 0) {
      console.log(`Depth ${depth} (${symbols.length}):`);
      for (const s of symbols) {
        console.log(`  ${s.kind} ${s.name} (${s.filePath}) [${s.edgeType}, confidence=${s.confidence}]`);
      }
    }
  }

  if (result.affectedFlows.length > 0) {
    console.log('');
    console.log(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      console.log(`  ${f.flowType}: ${f.label}`);
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
  const db = new Database(resolvedDbPath);

  if (warnIfEmptySymbolGraph(db, projectHash)) {
    db.close();
    return;
  }

  const graph = new SymbolGraph(db);
  const result = graph.handleDetectChanges({ scope, workspaceRoot, projectHash });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    db.close();
    return;
  }

  if (result.changedFiles.length === 0) {
    console.log('No changed files detected.');
    db.close();
    return;
  }

  console.log(`Risk Level: ${result.riskLevel}`);
  console.log('');

  console.log(`Changed Files (${result.changedFiles.length}):`);
  for (const f of result.changedFiles) {
    console.log(`  ${f}`);
  }
  console.log('');

  if (result.changedSymbols.length > 0) {
    console.log(`Changed Symbols (${result.changedSymbols.length}):`);
    for (const s of result.changedSymbols) {
      console.log(`  ${s.kind} ${s.name} (${s.filePath})`);
    }
    console.log('');
  }

  if (result.affectedFlows.length > 0) {
    console.log(`Affected Flows (${result.affectedFlows.length}):`);
    for (const f of result.affectedFlows) {
      console.log(`  ${f.flowType}: ${f.label}`);
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
  const resolvedDbPath = resolveDbPath(globalOpts.dbPath, root);
  const store = createStore(resolvedDbPath);
  const projectHash = crypto.createHash('sha256').update(root).digest('hex').substring(0, 12);

  const config = loadCollectionConfig(globalOpts.configPath);
  const wsConfig = getWorkspaceConfig(config, root);
  const codebaseConfig = wsConfig?.codebase ?? { enabled: true };

  console.log(`Reindexing codebase: ${root}`);
  const db = new Database(resolvedDbPath);
  const stats = await indexCodebase(store, root, codebaseConfig, projectHash, undefined, db);
  console.log(`  Files: ${stats.filesIndexed} indexed, ${stats.filesSkippedUnchanged} unchanged`);

  // Report symbol graph stats
  const symbolCount = (db.prepare('SELECT COUNT(*) as cnt FROM code_symbols WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbol_edges WHERE project_hash = ?').get(projectHash) as { cnt: number }).cnt;
  console.log(`  Symbols: ${symbolCount}, Edges: ${edgeCount}`);

  if (symbolCount === 0 && isTreeSitterAvailable()) {
    console.log('  ⚠️  No symbols indexed. Check if your files contain supported languages.');
  } else if (!isTreeSitterAvailable()) {
    console.log('  ⚠️  Tree-sitter not available — symbol graph skipped.');
  }

  db.close();
  store.close();
  console.log('✅ Reindex complete.');
}

async function handleCache(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    console.error('Missing cache subcommand (clear, stats)');
    process.exit(1);
  }

  log('cli', 'cache subcommand=' + subcommand);
  const store = createStore(globalOpts.dbPath);

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
          console.error(`Invalid cache type "${type}". Valid types: embed, expand, rerank`);
          store.close();
          process.exit(1);
        }
        type = typeMap[type];
      }

      let deleted: number;
      if (all) {
        deleted = store.clearCache(undefined, type);
        console.log(`Cleared all cache entries${type ? ` of type ${type}` : ''} (${deleted} total)`);
      } else {
        const projectHash = crypto.createHash('sha256').update(process.cwd()).digest('hex').substring(0, 12);
        deleted = store.clearCache(projectHash, type);
        console.log(`Cleared ${deleted} cache entries for workspace ${resolveProjectLabel(projectHash)}${type ? ` (type: ${type})` : ''}`);
      }
      break;
    }

    case 'stats': {
      const stats = store.getCacheStats();
      if (stats.length === 0) {
        console.log('No cache entries');
      } else {
        console.log('Cache Statistics:');
        console.log('  Type        Project                         Count');
        console.log('  ──────────  ──────────────────────────────  ─────');
        for (const row of stats) {
          console.log(`  ${row.type.padEnd(10)}  ${resolveProjectLabel(row.projectHash).padEnd(30)}  ${row.count}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown cache subcommand: ${subcommand}`);
      store.close();
      process.exit(1);
  }

  store.close();
}

async function handleLogs(commandArgs: string[]): Promise<void> {
  const logsDir = path.join(os.homedir(), '.nano-brain', 'logs');

  if (commandArgs[0] === 'path') {
    console.log(logsDir);
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
      console.log('No logs directory');
      return;
    }
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('nano-brain-') && f.endsWith('.log'));
    for (const file of files) {
      fs.unlinkSync(path.join(logsDir, file));
    }
    console.log('Cleared ' + files.length + ' log file(s)');
    return;
  }

  if (!logFile) {
    logFile = path.join(logsDir, 'nano-brain-' + date + '.log');
  }

  if (!fs.existsSync(logFile)) {
    console.log('No log file: ' + logFile);
    console.log('Enable logging: set logging.enabled: true in ~/.nano-brain/config.yml');
    return;
  }

  if (follow) {
    const { spawn } = await import('child_process');
    const tail = spawn('tail', ['-f', '-n', String(lines), logFile], { stdio: 'inherit' });
    tail.on('error', () => {
      console.error('tail command not available, showing last ' + lines + ' lines instead');
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
    console.log('... (' + start + ' earlier lines omitted, use -n to show more)');
  }
  for (const line of selected) {
    console.log(line);
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
    console.error('Missing qdrant subcommand (up, down, status, migrate, verify, activate, cleanup)');
    process.exit(1);
  }

  log('cli', 'qdrant subcommand=' + subcommand);

  const composeSource = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docker-compose.qdrant.yml');
  const composeTarget = path.join(NANO_BRAIN_HOME, 'docker-compose.qdrant.yml');

  switch (subcommand) {
    case 'up': {
      if (!fs.existsSync(composeTarget)) {
        if (!fs.existsSync(composeSource)) {
          console.error('❌ docker-compose.qdrant.yml not found in package');
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(composeTarget), { recursive: true });
        fs.copyFileSync(composeSource, composeTarget);
      }

      console.log('Starting Qdrant...');
      try {
        execSync(`docker compose -f "${composeTarget}" up -d`, { stdio: 'inherit' });
      } catch {
        console.error('❌ Failed to start Qdrant. Is Docker running?');
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
        console.log(`Waiting for Qdrant... (${i + 1}/5)`);
      }

      if (!healthy) {
        console.error('❌ Qdrant failed to start. Check: docker logs nano-brain-qdrant');
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

      console.log('✅ Qdrant is running. Dashboard: http://localhost:6333/dashboard');
      break;
    }

    case 'down': {
      console.log('Stopping Qdrant...');
      try {
        execSync(`docker compose -f "${composeTarget}" down`, { stdio: 'inherit' });
      } catch {
        console.error('❌ Failed to stop Qdrant');
        process.exit(1);
      }

      let config = loadCollectionConfig(globalOpts.configPath);
      if (config) {
        const vectorConfig: VectorConfigSection = { provider: 'sqlite-vec' };
        config.vector = vectorConfig;
        saveCollectionConfig(globalOpts.configPath, config);
      }

      console.log('✅ Qdrant stopped. Vector provider switched to sqlite-vec. Data persists in Docker volume.');
      break;
    }

    case 'status': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const currentProvider = vectorConfig?.provider || 'sqlite-vec';

      console.log('Qdrant Status');
      console.log('═══════════════════════════════════════════════════');
      if (currentProvider === 'qdrant') {
        console.log(`Active provider: qdrant ✓`);
      } else {
        console.log(`Active provider: sqlite-vec (default)`);
      }
      console.log('');

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

      console.log(`Container: ${containerStatus}`);

      const qdrantUrl = vectorConfig?.url || 'http://localhost:6333';
      const resolvedUrl = resolveHostUrl(qdrantUrl);

      try {
        const healthRes = await fetch(`${resolvedUrl}/healthz`);
        if (!healthRes.ok) {
          throw new Error(`HTTP ${healthRes.status}`);
        }
        console.log(`Health: ✅ reachable at ${resolvedUrl}`);

        try {
          const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
          if (collectionRes.ok) {
            const collectionData = await collectionRes.json();
            const result = collectionData.result || collectionData;
            console.log(`Collection: nano-brain`);
            console.log(`  Vectors: ${result.points_count ?? result.vectors_count ?? 'unknown'}`);
            console.log(`  Dimensions: ${result.config?.params?.vectors?.size ?? 'unknown'}`);
          } else {
            console.log('Collection: nano-brain (not created yet)');
          }
        } catch {
          console.log('Collection: nano-brain (not created yet)');
        }
      } catch {
        console.log(`Health: ❌ Qdrant is not reachable at ${resolvedUrl}`);
        if (resolvedUrl !== qdrantUrl) {
          console.log(`   (config URL ${qdrantUrl} resolved to ${resolvedUrl} inside container)`);
        }
        console.log('   Run `npx nano-brain qdrant up` to start.');
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
        console.error(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        console.error('   Run `npx nano-brain qdrant up` first.');
        console.error('   If running inside a container, Qdrant must be accessible at host.docker.internal:6333.');
        process.exit(1);
      }

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        console.log('No databases found in ' + dataDir);
        return;
      }

      let sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (workspaceFilter) {
        sqliteFiles = sqliteFiles.filter(f => f.includes(workspaceFilter));
      }

      if (sqliteFiles.length === 0) {
        console.log('No matching databases found');
        return;
      }

      console.log(`Found ${sqliteFiles.length} database(s) to migrate`);
      if (dryRun) {
        console.log('(dry-run mode - no vectors will be written)');
      }

      const startTime = Date.now();
      let totalVectors = 0;
      let dbCount = 0;

      const Database = (await import('better-sqlite3')).default;
      const sqliteVec = await import('sqlite-vec');

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const db = new Database(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          console.log(`[${sqliteFile}] sqlite-vec not available, skipping`);
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
          console.log(`[${sqliteFile}] no vector tables, skipping`);
          db.close();
          continue;
        }

        if (vectorCount === 0) {
          console.log(`[${sqliteFile}] 0 vectors, skipping`);
          db.close();
          continue;
        }

        if (dryRun) {
          console.log(`[${sqliteFile}] ${vectorCount} vectors (dry-run)`);
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
            console.log(`[${sqliteFile}] ${migrated}/${vectorCount} vectors migrated...`);
            batch.length = 0;
          }
        }

        if (batch.length > 0) {
          await qdrantStore.batchUpsert(batch);
          migrated += batch.length;
        }

        console.log(`[${sqliteFile}] ${migrated}/${vectorCount} vectors migrated`);
        totalVectors += migrated;
        dbCount++;

        await qdrantStore.close();
        db.close();
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (dryRun) {
        console.log(`\n📊 Dry-run complete: ${totalVectors} vectors in ${dbCount} database(s)`);
      } else {
        console.log(`\n✅ Migrated ${totalVectors} vectors from ${dbCount} database(s) in ${elapsed}s`);

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
            console.log('\n✅ Switched to Qdrant provider');
          } else {
            console.log(`\nProvider is currently: ${currentProvider}`);
            console.log('To use Qdrant for searches, run: npx nano-brain qdrant activate');
            console.log('Or re-run with: npx nano-brain qdrant migrate --activate');
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
        console.error(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        console.error('   Run `npx nano-brain qdrant up` first.');
        console.error('   If running inside a container, Qdrant must be accessible at host.docker.internal:6333.');
        process.exit(1);
      }

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        console.log('No databases found in ' + dataDir);
        return;
      }

      const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (sqliteFiles.length === 0) {
        console.log('No SQLite databases found');
        return;
      }

      console.log('Verifying migration...');
      console.log('═══════════════════════════════════════════════════');

      const Database = (await import('better-sqlite3')).default;
      const sqliteVec = await import('sqlite-vec');

      let totalVectors = 0;
      let dbCount = 0;
      const uniqueKeys = new Set<string>();
      let sawVectorTables = false;

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const db = new Database(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          console.log(`[${sqliteFile}] sqlite-vec not available, skipping`);
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
          console.log(`[${sqliteFile}] no vector tables, skipping`);
          db.close();
          continue;
        }

        sawVectorTables = true;

        if (vectorCount === 0) {
          console.log(`[${sqliteFile}] 0 vectors`);
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

        console.log(`[${sqliteFile}] ${vectorCount.toLocaleString()} vectors in SQLite`);
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
          console.error('❌ Failed to check Qdrant collection');
          process.exit(1);
        }

        console.log('SQLite: no vector data (already cleaned up)');
        console.log(`Qdrant: ${pointsCount.toLocaleString()} vectors`);
        console.log(`ℹ️  Cannot verify — SQLite vectors already cleaned. Qdrant has ${pointsCount.toLocaleString()} vectors.`);
        break;
      }

      console.log('───────────────────────────────────────────────────');
      console.log(`SQLite total: ${totalVectors.toLocaleString()} vectors (across ${dbCount} databases)`);

      let pointsCount = 0;
      try {
        const collectionRes = await fetch(`${resolvedUrl}/collections/nano-brain`);
        if (collectionRes.ok) {
          const collectionData = await collectionRes.json();
          const result = collectionData.result || collectionData;
          pointsCount = result.points_count ?? result.vectors_count ?? 0;
        }
      } catch {
        console.error('❌ Failed to check Qdrant collection');
        process.exit(1);
      }

      const uniqueCount = uniqueKeys.size;
      console.log(`Qdrant total: ${pointsCount.toLocaleString()} unique vectors`);
      const difference = totalVectors - pointsCount;
      console.log(`Difference: ${difference.toLocaleString()} (expected — cross-workspace duplicates share the same hash:seq key)`);
      console.log('');

      if (uniqueCount > pointsCount) {
        const missing = uniqueCount - pointsCount;
        console.log(`⚠️  Found ${missing.toLocaleString()} vectors in SQLite not present in Qdrant. Run \`npx nano-brain qdrant migrate\` to sync.`);
      } else {
        console.log('✅ Migration verified: Qdrant has all unique vectors');
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
        console.error(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        console.error('   Run `npx nano-brain qdrant up` first.');
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

      console.log('✅ Switched to Qdrant provider');
      console.log(`   URL: ${qdrantUrl}`);
      console.log(`   Collection: ${newVectorConfig.collection}`);
      break;
    }

    case 'cleanup': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const currentProvider = vectorConfig?.provider || 'sqlite-vec';

      if (currentProvider !== 'qdrant') {
        console.error('❌ Cannot cleanup: provider is not set to qdrant');
        console.error(`   Current provider: ${currentProvider}`);
        console.error('   Run `npx nano-brain qdrant activate` first.');
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
        console.error(`❌ Qdrant is not reachable at ${resolvedUrl}.`);
        console.error('   Cannot cleanup without verifying Qdrant has vectors.');
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
        console.error('❌ Failed to check Qdrant collection');
        process.exit(1);
      }

      if (pointsCount === 0) {
        console.error('❌ Cannot cleanup: Qdrant collection has no vectors');
        console.error('   Run `npx nano-brain qdrant migrate` first to migrate vectors.');
        process.exit(1);
      }

      console.log(`Qdrant has ${pointsCount} vectors. Proceeding with SQLite cleanup...`);

      const dataDir = DEFAULT_DB_DIR;
      if (!fs.existsSync(dataDir)) {
        console.log('No databases found in ' + dataDir);
        return;
      }

      const sqliteFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite'));
      if (sqliteFiles.length === 0) {
        console.log('No SQLite databases found');
        return;
      }

      const Database = (await import('better-sqlite3')).default;
      const sqliteVec = await import('sqlite-vec');

      let cleanedCount = 0;
      let totalSpaceSaved = 0;

      for (const sqliteFile of sqliteFiles) {
        const dbPath = path.join(dataDir, sqliteFile);
        const statBefore = fs.statSync(dbPath);
        const db = new Database(dbPath);

        try {
          sqliteVec.load(db);
        } catch {
          console.log(`[${sqliteFile}] sqlite-vec not available, skipping`);
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
          console.log(`[${sqliteFile}] no vector tables, skipping`);
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

          console.log(`[${sqliteFile}] cleaned`);
        } catch (err) {
          console.error(`[${sqliteFile}] cleanup failed:`, err);
        }

        db.close();
      }

      const spaceMB = (totalSpaceSaved / (1024 * 1024)).toFixed(2);
      console.log(`\n✅ Cleaned ${cleanedCount} database(s), ~${spaceMB} MB freed`);
      break;
    }

    default:
      console.error(`Unknown qdrant subcommand: ${subcommand}`);
      console.error('Available: up, down, status, migrate, verify, activate, cleanup');
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
    console.error('⚠️  This will permanently delete nano-brain data.');
    console.error('   Run with --confirm to proceed, or --dry-run to preview.');
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
    console.log('Dry run — would delete:');
    console.log('');
    if (deleteDatabases) {
      console.log(`  SQLite databases:    ${sqliteFiles.length} files in ${dataDir}`);
    }
    if (deleteSessions) {
      console.log(`  Harvested sessions:  ${sessionsExist ? sessionsDir : '(not found)'}`);
    }
    if (deleteMemory) {
      console.log(`  Memory notes:        ${memoryExists ? memoryDir : '(not found)'}`);
    }
    if (deleteLogs) {
      console.log(`  Log files:           ${logsExist ? logsDir : '(not found)'}`);
    }
    if (deleteVectors) {
      if (qdrantReachable) {
        console.log(`  Qdrant collection:   nano-brain (${qdrantPointsCount} vectors)`);
      } else {
        console.log(`  Qdrant collection:   (not reachable at ${qdrantUrl})`);
      }
    }
    return;
  }

  if (deleteDatabases) {
    for (const file of sqliteFiles) {
      fs.unlinkSync(path.join(dataDir, file));
    }
    if (sqliteFiles.length > 0) {
      console.log(`🗑️  Deleted ${sqliteFiles.length} database files from ${dataDir}`);
    } else {
      console.log(`ℹ️  No database files found in ${dataDir}`);
    }
  }

  if (deleteSessions) {
    if (sessionsExist) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      console.log(`🗑️  Deleted harvested sessions from ${sessionsDir}`);
    } else {
      console.log(`ℹ️  No harvested sessions directory found`);
    }
  }

  if (deleteMemory) {
    if (memoryExists) {
      fs.rmSync(memoryDir, { recursive: true, force: true });
      console.log(`🗑️  Deleted memory notes from ${memoryDir}`);
    } else {
      console.log(`ℹ️  No memory directory found`);
    }
  }

  if (deleteLogs) {
    if (logsExist) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      console.log(`🗑️  Deleted log files from ${logsDir}`);
    } else {
      console.log(`ℹ️  No logs directory found`);
    }
  }

  if (deleteVectors) {
    if (qdrantReachable) {
      try {
        const deleteRes = await fetch(`${qdrantUrl}/collections/nano-brain`, { method: 'DELETE' });
        if (deleteRes.ok) {
          console.log(`🗑️  Deleted Qdrant collection 'nano-brain' (${qdrantPointsCount} vectors)`);
        } else {
          console.warn(`⚠️  Failed to delete Qdrant collection: HTTP ${deleteRes.status}`);
        }
      } catch (err) {
        console.warn(`⚠️  Failed to delete Qdrant collection: ${err}`);
      }
    } else {
      console.log(`ℹ️  Qdrant not reachable at ${qdrantUrl} — skipping vector cleanup`);
    }
  }

  console.log('');
  console.log('✅ Reset complete.');
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
      console.error(`Cannot read data directory: ${dataDir}`);
      process.exit(1);
    }

    if (dbFiles.length === 0) {
      console.log('No workspaces found.');
      return;
    }

    console.log('Known workspaces:');
    console.log('');
    console.log('  Name                 Hash          Path                                           Docs');
    console.log('  ───────────────────  ────────────  ─────────────────────────────────────────────  ────');

    for (const dbFile of dbFiles) {
      const wsName = extractWorkspaceName(dbFile);
      let docs = 0;
      try {
        const readDb = new Database(dbFile, { readonly: true });
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

      console.log(`  ${wsName.padEnd(21)}  ${fileHash.padEnd(12)}  ${(wsPath || '(unknown)').padEnd(45)}  ${docs}`);
    }
    return;
  }

  if (!identifier) {
    console.error('Usage: nano-brain rm <workspace> [--dry-run]');
    console.error('       nano-brain rm --list');
    console.error('');
    console.error('<workspace> can be: absolute path, hash prefix, or workspace name');
    process.exit(1);
  }

  const store = createStore(globalOpts.dbPath);
  try {
    const resolved = resolveWorkspaceIdentifier(identifier, config, store);
    const { projectHash, workspacePath } = resolved;

    if (dryRun) {
      const db = new Database(globalOpts.dbPath, { readonly: true });
      const count = (table: string, col: string = 'project_hash') => {
        try {
          return (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} = ?`).get(projectHash) as { cnt: number }).cnt;
        } catch { return 0; }
      };

      console.log(`Dry run — would remove workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}:`);
      console.log('');
      console.log(`  documents:        ${count('documents')}`);
      console.log(`  file_edges:       ${count('file_edges')}`);
      console.log(`  symbols:          ${count('symbols')}`);
      console.log(`  code_symbols:     ${count('code_symbols')}`);
      console.log(`  symbol_edges:     ${count('symbol_edges')}`);
      console.log(`  execution_flows:  ${count('execution_flows')}`);
      console.log(`  llm_cache:        ${count('llm_cache')}`);
      if (workspacePath && config?.workspaces?.[workspacePath]) {
        console.log(`  config entry:     ${workspacePath}`);
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
          console.log(`  collections:      ${affectedCollections.join(', ')}`);
        }
      }
      if (workspacePath) {
        const dataDir = path.dirname(globalOpts.dbPath);
        const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
        if (fs.existsSync(wsDbPath)) {
          console.log(`  database file:    ${path.basename(wsDbPath)}`);
        }
      }
      console.log('');
      console.log('Run without --dry-run to execute.');
      db.close();
      return;
    }

    console.log(`Removing workspace ${resolveProjectLabel(projectHash)}${workspacePath ? ` (${workspacePath})` : ''}...`);
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

    console.log('');
    console.log('Removed:');
    console.log(`  documents:        ${result.documentsDeleted}`);
    console.log(`  embeddings:       ${result.embeddingsDeleted}`);
    console.log(`  content:          ${result.contentDeleted}`);
    console.log(`  cache:            ${result.cacheDeleted}`);
    console.log(`  file_edges:       ${result.fileEdgesDeleted}`);
    console.log(`  symbols:          ${result.symbolsDeleted}`);
    console.log(`  code_symbols:     ${result.codeSymbolsDeleted}`);
    console.log(`  symbol_edges:     ${result.symbolEdgesDeleted}`);
    console.log(`  execution_flows:  ${result.executionFlowsDeleted}`);
    if (configRemoved) {
      console.log(`  config entry:     ${workspacePath}`);
    }
    if (collectionsRemoved > 0) {
      console.log(`  collections:      ${collectionsRemoved} removed`);
    }
    console.log(`  total rows:       ${totalDeleted}`);

    const db = new Database(globalOpts.dbPath, { readonly: true });
    const tables = ['documents', 'file_edges', 'symbols', 'code_symbols', 'symbol_edges', 'execution_flows', 'llm_cache'];
    let remaining = 0;
    for (const table of tables) {
      try {
        remaining += (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project_hash = ?`).get(projectHash) as { cnt: number }).cnt;
      } catch { /* table may not exist */ }
    }
    db.close();

    console.log('');
    if (remaining === 0) {
      console.log('✅ Verified: zero rows remain for this workspace.');
    } else {
      console.log(`⚠️  Warning: ${remaining} rows still found for ${resolveProjectLabel(projectHash)}. Partial removal.`);
    }

    if (workspacePath) {
      const dataDir = path.dirname(globalOpts.dbPath);
      const wsDbPath = resolveWorkspaceDbPath(dataDir, workspacePath);
      if (fs.existsSync(wsDbPath) && wsDbPath !== globalOpts.dbPath) {
        try {
          const wsDb = new Database(wsDbPath, { readonly: true });
          let wsRemaining = 0;
          try {
            wsRemaining = (wsDb.prepare('SELECT COUNT(*) as count FROM documents WHERE active = 1').get() as { count: number }).count;
          } catch { /* ignore */ }
          wsDb.close();
          if (wsRemaining === 0) {
            fs.unlinkSync(wsDbPath);
            try { fs.unlinkSync(wsDbPath + '-wal'); } catch { /* ignore */ }
            try { fs.unlinkSync(wsDbPath + '-shm'); } catch { /* ignore */ }
            console.log(`  database file:    ${path.basename(wsDbPath)} deleted`);
          }
        } catch {
          console.warn(`  ⚠️  Could not clean up database file: ${path.basename(wsDbPath)}`);
        }
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    store.close();
  }
}

async function handleConsolidate(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  log('cli', 'consolidate');
  const store = createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);
  
  if (!config?.consolidation?.enabled) {
    console.log('Consolidation is not enabled. Set consolidation.enabled=true in config.yml');
    store.close();
    return;
  }
  
  console.log('Consolidation requires an LLM provider. Configure consolidation.model and consolidation.endpoint in config.yml');
  store.close();
}

async function handleLearning(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];
  
  if (subcommand === 'rollback') {
    const versionId = commandArgs[1] ? parseInt(commandArgs[1], 10) : undefined;
    const store = createStore(globalOpts.dbPath);
    try {
      if (versionId) {
        const version = store.getConfigVersion(versionId);
        if (!version) {
          console.error('Config version ' + versionId + ' not found');
          process.exit(1);
        }
        console.log('Config version ' + versionId + ' (created ' + version.created_at + ')');
        console.log('Config:', version.config_json);
      } else {
        const latest = store.getLatestConfigVersion();
        if (!latest) {
          console.log('No config versions found. Learning has not been active.');
        } else {
          console.log('Latest config version: ' + latest.version_id + ' (created ' + latest.created_at + ')');
          console.log('Config:', latest.config_json);
          console.log('\nUse: nano-brain learning rollback <version_id>');
        }
      }
    } finally {
      store.close();
    }
    return;
  }
  
  console.error('Usage: nano-brain learning rollback [version_id]');
  console.error('');
  console.error('Commands:');
  console.error('  rollback [version_id]  View or rollback to a previous config version');
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
    case 'learning':
      return handleLearning(globalOpts, commandArgs);
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('cli.js') ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
