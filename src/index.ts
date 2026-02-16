import { startServer } from './server.js';
import { createStore, computeHash, indexDocument } from './store.js';
import { loadCollectionConfig, addCollection, removeCollection, renameCollection, listCollections, getCollections, scanCollectionFiles } from './collections.js';
import { harvestSessions } from './harvester.js';
import { createEmbeddingProvider } from './embeddings.js';
import { hybridSearch } from './search.js';
import type { SearchResult } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.cache', 'opencode-memory');
const DEFAULT_CONFIG = path.join(os.homedir(), '.config', 'opencode-memory', 'config.yml');
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.opencode-memory', 'sessions');
const DEFAULT_MEMORY_DIR = path.join(os.homedir(), '.opencode-memory', 'memory');

interface GlobalOptions {
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

export function showHelp(): void {
  console.log(`
opencode-memory - Memory system with hybrid search

Usage:
  opencode-memory [global-options] <command> [command-options]

Global Options:
  --db=<path>       SQLite database path (default: ~/.cache/opencode-memory/default.sqlite)
  --config=<path>   Config YAML path (default: ~/.config/opencode-memory/config.yml)
  --help, -h        Show help
  --version, -v     Show version

Commands:
  mcp               Start MCP server (default command if no args)
    --http          Use HTTP transport instead of stdio
    --port=<n>      HTTP port (default: 8282)
    --daemon        Run as background daemon
    stop            Stop running daemon

  collection        Manage collections
    add <name> <path> [--pattern=<glob>]
    remove <name>
    list
    rename <old> <new>

  status            Show index health and stats
  update            Re-scan and reindex all collections
  embed             Generate embeddings for unembedded chunks
    --force         Re-embed all chunks

  search <query>    BM25 keyword search
    -n <limit>      Max results (default: 10)
    -c <collection> Filter by collection
    --json          Output as JSON
    --files         Show file paths only

  vsearch <query>   Vector semantic search (same options as search)
  query <query>     Full hybrid search (same options as search)
    --min-score=<n> Minimum score threshold

  get <id>          Get document by path or docid
    --full          Show full content
    --from=<line>   Start line
    --lines=<n>     Number of lines

  harvest           Manually trigger session harvesting
`);
}

export function showVersion(): void {
  console.log('opencode-memory v0.1.0');
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
  const health = store.getIndexHealth();
  
  console.log('Index Health:');
  console.log(`  Documents: ${health.documentCount}`);
  console.log(`  Chunks: ${health.chunkCount}`);
  console.log(`  Pending embeddings: ${health.pendingEmbeddings}`);
  console.log(`  Database size: ${(health.databaseSize / 1024 / 1024).toFixed(2)} MB`);
  console.log('');
  console.log('Collections:');
  for (const coll of health.collections) {
    console.log(`  ${coll.name}: ${coll.documentCount} documents`);
  }
  console.log('');
  console.log('Model Status:');
  console.log(`  Embedding: ${health.modelStatus.embedding}`);
  console.log(`  Reranker: ${health.modelStatus.reranker}`);
  console.log(`  Expander: ${health.modelStatus.expander}`);
  
  store.close();
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
      const result = indexDocument(store, collection.name, file, content, title);
      
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
  
  console.log('Generating embeddings...');
  
  for (let i = 0; i < hashes.length; i++) {
    const { hash, body } = hashes[i];
    const result = await provider.embed(body);
    store.insertEmbedding(hash, 0, 0, result.embedding, result.model);
    
    if ((i + 1) % 10 === 0) {
      console.log(`  Progress: ${i + 1}/${hashes.length}`);
    }
  }
  
  console.log(`✅ Generated ${hashes.length} embeddings`);
  
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
  const sessionDir = path.join(os.homedir(), '.opencode', 'storage');
  const outputDir = DEFAULT_OUTPUT_DIR;
  
  console.log('Harvesting sessions...');
  const sessions = await harvestSessions({ sessionDir, outputDir });
  
  console.log(`✅ Harvested ${sessions.length} sessions to ${outputDir}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  const globalOpts = parseGlobalOptions(args);
  
  const command = globalOpts.remaining[0] || 'mcp';
  const commandArgs = globalOpts.remaining.slice(1);
  
  switch (command) {
    case 'mcp':
      return handleMcp(globalOpts, commandArgs);
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
