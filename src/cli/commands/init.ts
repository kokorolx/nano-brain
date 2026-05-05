import { createStore, indexDocument, extractProjectHashFromPath, openDatabase } from '../../store.js';
import { loadCollectionConfig, saveCollectionConfig, getCollections, scanCollectionFiles, getWorkspaceConfig } from '../../collections.js';
import { harvestSessions } from '../../harvester.js';
import { createEmbeddingProvider, detectOllamaUrl, checkOllamaHealth } from '../../embeddings.js';
import { indexCodebase } from '../../codebase.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_MEMORY_DIR,
  detectRunningServer,
  proxyPost,
  isRunningInContainer,
  resolveDbPath,
  resolveOpenCodeStorageDir,
} from '../utils.js';

export async function handleInit(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  if (isRunningInContainer()) {
    cliError('Error: Destructive operations must be run on the host, not from containers.');
    cliError('Run this command directly on the host: npx nano-brain init --force');
    process.exit(1);
  }

  let root = process.cwd();
  let force = false;
  let all = false;

  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg.startsWith('--root=')) {
      root = arg.substring(7);
    } else if (arg === '--root' && commandArgs[i + 1]) {
      root = commandArgs[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--all') {
      all = true;
    }
  }

  log('cli', 'init start root=' + root + ' force=' + force + ' all=' + all);

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
  cliOutput('🧠 Generating embeddings...');
  const embeddingConfig = config.embedding;
  const provider = await createEmbeddingProvider({ embeddingConfig });
  const INIT_EMBED_CAP = 50;
  if (provider) {
    store.ensureVecTable(provider.getDimensions());
    let embedded = 0;
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
  const snippetPath = path.join(path.dirname(import.meta.url.replace('file://', '')), '..', '..', '..', 'AGENTS_SNIPPET.md');
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

  const commandsDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'commands');
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

  if (force && serverRunning) {
    cliOutput('');
    cliOutput('🔄 Triggering full reindex + embed (force mode)...');
    try {
      await proxyPost(DEFAULT_HTTP_PORT, '/api/reindex', { root });
      cliOutput('  Reindex started in background');
    } catch (err) {
      cliOutput('  ⚠️  Could not trigger reindex — run `npx nano-brain reindex` manually');
    }
    try {
      await proxyPost(DEFAULT_HTTP_PORT, '/api/embed', { path: root });
      cliOutput('  Embed started in background');
    } catch (err) {
      cliOutput('  ⚠️  Could not trigger embed — run `npx nano-brain embed` manually');
    }
    cliOutput('  (Check progress with `npx nano-brain status`)');
  }

  cliOutput('');
  cliOutput('nano-brain initialized! Run `npx nano-brain status` to verify.');
}
