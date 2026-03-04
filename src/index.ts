import { startServer } from './server.js';
import { createStore, computeHash, indexDocument, extractProjectHashFromPath } from './store.js';
import { loadCollectionConfig, addCollection, removeCollection, renameCollection, listCollections, getCollections, scanCollectionFiles, saveCollectionConfig } from './collections.js';
import { harvestSessions } from './harvester.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth } from './embeddings.js';
import { hybridSearch } from './search.js';
import { indexCodebase, embedPendingCodebase } from './codebase.js';
import { handleBench } from './bench.js';
import type { SearchResult } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

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
const DEFAULT_CONFIG = path.join(NANO_BRAIN_HOME, 'config.yml');
const DEFAULT_OUTPUT_DIR = path.join(NANO_BRAIN_HOME, 'sessions');
const DEFAULT_MEMORY_DIR = path.join(NANO_BRAIN_HOME, 'memory');

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
    --daemon        Run as background daemon
    stop            Stop running daemon
  status            Show index health, embedding server status, and stats
  collection        Manage collections
    add <name> <path> [--pattern=<glob>]
    remove <name>
    list
    rename <old> <new>
  embed             Generate embeddings for unembedded chunks
    --force         Re-embed all chunks
    -n <limit>      Max results (default: 10)
    -c <collection> Filter by collection
    --json          Output as JSON
    --files         Show file paths only
  query <query>     Full hybrid search (same options as search)
    --min-score=<n> Minimum score threshold
    --full          Show full content
    --from=<line>   Start line
    --lines=<n>     Number of lines
  harvest           Manually trigger session harvesting
  cache             Manage LLM cache
    clear           Clear cache for current workspace
      --all         Clear all cache entries across all workspaces
      --type=<type> Filter by type (embed, expand, rerank)
    stats           Show cache entry counts by type and workspace
  bench             Run performance benchmarks
    --suite=<name>  Run specific suite (search, embed, cache, store)
    --iterations=<n> Override iteration count
    --json          Output as JSON
    --save          Save results as baseline
    --compare       Compare with last saved baseline
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
  let daemon = false;
  
  for (const arg of commandArgs) {
    if (arg === '--http') {
      useHttp = true;
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.substring(7), 10);
    } else if (arg === '--daemon') {
      daemon = true;
    } else if (arg === 'stop') {
      console.log('Daemon stop not implemented yet');
      return;
    }
  }
  
  await startServer({
    dbPath: globalOpts.dbPath,
    configPath: globalOpts.configPath,
  });
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

async function handleStatus(globalOpts: GlobalOptions): Promise<void> {
  const store = createStore(globalOpts.dbPath);
  const config = loadCollectionConfig(globalOpts.configPath);
  const health = store.getIndexHealth();
  console.log('nano-brain Status');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Index:');
  console.log(`  Documents:          ${health.documentCount}`);
  console.log(`  Embedded:           ${health.embeddedCount}`);
  console.log(`  Pending embeddings: ${health.pendingEmbeddings}`);
  console.log(`  Database size:      ${(health.databaseSize / 1024 / 1024).toFixed(2)} MB`);
  console.log('');
  
  if (health.collections.length > 0) {
    console.log('Collections:');
    for (const coll of health.collections) {
      console.log(`  ${coll.name}: ${coll.documentCount} documents`);
    }
    console.log('');
  }
  
  const embeddingConfig = config?.embedding;
  const ollamaUrl = embeddingConfig?.url || detectOllamaUrl();
  const ollamaModel = embeddingConfig?.model || 'nomic-embed-text';
  const provider = embeddingConfig?.provider || 'ollama';
  
  console.log('Embedding Server:');
  console.log(`  Provider:  ${provider}`);
  console.log(`  URL:       ${ollamaUrl}`);
  console.log(`  Model:     ${ollamaModel}`);
  
  if (provider !== 'local') {
    const ollamaHealth = await checkOllamaHealth(ollamaUrl);
    if (ollamaHealth.reachable) {
      const hasModel = ollamaHealth.models?.some(m => m.startsWith(ollamaModel));
      console.log(`  Status:    ✅ connected`);
      console.log(`  Model:     ${hasModel ? '✅ available' : '❌ not found — run: ollama pull ' + ollamaModel}`);
      if (ollamaHealth.models && ollamaHealth.models.length > 0) {
        console.log(`  Available: ${ollamaHealth.models.join(', ')}`);
      }
    } else {
      console.log(`  Status:    ❌ unreachable (${ollamaHealth.error})`);
      console.log(`  Fallback:  local GGUF (node-llama-cpp)`);
    }
  } else {
    console.log(`  Status:    local GGUF mode`);
  }
  console.log('');
  
  console.log('Models:');
  console.log(`  Embedding: ${health.modelStatus.embedding}`);
  console.log(`  Reranker:  ${health.modelStatus.reranker}`);
  console.log(`  Expander: ${health.modelStatus.expander}`);
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
  
  const ollamaUrl = config.embedding?.url || detectOllamaUrl();
  const ollamaHealth = await checkOllamaHealth(ollamaUrl);
  
  if (ollamaHealth.reachable) {
    console.log(`✅ Ollama reachable at ${ollamaUrl}`);
  } else {
    console.log(`⚠️  Ollama not reachable at ${ollamaUrl} — will use local GGUF fallback`);
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
  const codebaseStats = await indexCodebase(store, root, codebaseConfig, projectHash);
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
  
  const store = createStore(globalOpts.dbPath);
  const hashes = store.getHashesNeedingEmbedding();
  
  if (hashes.length === 0) {
    console.log('No chunks need embedding');
    store.close();
    return;
  }
  
  console.log(`Found ${hashes.length} chunks needing embeddings`);
  console.log('Loading embedding model...');
  
  const provider = await createEmbeddingProvider();
  
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
  const query = commandArgs[0];
  
  if (!query) {
    console.error('Missing query argument');
    process.exit(1);
  }
  
  let limit = 10;
  let collection: string | undefined;
  let format: 'text' | 'json' | 'files' = 'text';
  let minScore = 0;
  
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
    } else if (arg.startsWith('--min-score=')) {
      minScore = parseFloat(arg.substring(12));
    }
  }
  
  const store = createStore(globalOpts.dbPath);
  let results: SearchResult[];
  
  if (mode === 'fts') {
    results = store.searchFTS(query, limit, collection);
  } else if (mode === 'vec') {
    const provider = await createEmbeddingProvider();
    if (!provider) {
      console.error('Vector search requires embedding model');
      store.close();
      process.exit(1);
    }
    
    const { embedding } = await provider.embed(query);
    results = store.searchVec(query, embedding, limit, collection);
    provider.dispose();
  } else {
    const provider = await createEmbeddingProvider();
    results = await hybridSearch(
      store,
      { query, limit, collection, minScore },
      { embedder: provider }
    );
    provider?.dispose();
  }
  
  console.log(formatSearchOutput(results, format));
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
  const sessionDir = resolveOpenCodeStorageDir();
  const outputDir = DEFAULT_OUTPUT_DIR;
  
  console.log('Harvesting sessions...');
  const sessions = await harvestSessions({ sessionDir, outputDir });
  
  console.log(`✅ Harvested ${sessions.length} sessions to ${outputDir}`);
}

async function handleCache(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    console.error('Missing cache subcommand (clear, stats)');
    process.exit(1);
  }

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
        console.log(`Cleared ${deleted} cache entries for workspace ${projectHash}${type ? ` (type: ${type})` : ''}`);
      }
      break;
    }

    case 'stats': {
      const stats = store.getCacheStats();
      if (stats.length === 0) {
        console.log('No cache entries');
      } else {
        console.log('Cache Statistics:');
        console.log('  Type        Project Hash    Count');
        console.log('  ──────────  ──────────────  ─────');
        for (const row of stats) {
          console.log(`  ${row.type.padEnd(10)}  ${row.projectHash.padEnd(14)}  ${row.count}`);
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

async function main() {
  const args = process.argv.slice(2);
  
  const globalOpts = parseGlobalOptions(args);
  

  const command = globalOpts.remaining[0] || 'mcp';
  const commandArgs = globalOpts.remaining.slice(1);

  // Resolve per-workspace DB path (init command handles this separately with --root)
  if (command !== 'init') {
    globalOpts.dbPath = resolveDbPath(globalOpts.dbPath, process.cwd());
  }
  
  switch (command) {
    case 'mcp':
      return handleMcp(globalOpts, commandArgs);
    case 'init':
      return handleInit(globalOpts, commandArgs);
    case 'collection':
      return handleCollection(globalOpts, commandArgs);
    case 'status':
      return handleStatus(globalOpts);
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
    case 'bench':
      return handleBench(globalOpts, commandArgs);
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
