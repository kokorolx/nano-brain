import { loadCollectionConfig, saveCollectionConfig } from '../../collections.js';
import { createEmbeddingProvider } from '../../embeddings.js';
import { resolveHostUrl } from '../../host.js';
import { QdrantVecStore } from '../../providers/qdrant.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { NANO_BRAIN_HOME } from '../utils.js';

interface VectorConfigSection {
  provider: 'qdrant';
  url?: string;
  apiKey?: string;
  collection?: string;
}

export async function handleQdrant(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing qdrant subcommand (up, down, status, activate, recreate)');
    process.exit(1);
  }

  log('cli', 'qdrant subcommand=' + subcommand);

  const composeSource = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'docker-compose.yml');
  const composeTarget = path.join(NANO_BRAIN_HOME, 'docker-compose.yml');

  switch (subcommand) {
    case 'up': {
      if (!fs.existsSync(composeTarget)) {
        if (!fs.existsSync(composeSource)) {
          cliError('❌ docker-compose.yml not found in package');
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
      const existingCollection = config.vector?.collection || 'nano-brain';
      const vectorConfig: VectorConfigSection = {
        provider: 'qdrant',
        url: 'http://localhost:6333',
        collection: existingCollection,
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
        delete config.vector;
        saveCollectionConfig(globalOpts.configPath, config);
      }

      cliOutput('✅ Qdrant stopped. Data persists in Docker volume.');
      break;
    }

    case 'status': {
      const config = loadCollectionConfig(globalOpts.configPath);
      const vectorConfig = config?.vector;
      const currentProvider = vectorConfig?.provider || 'qdrant';

      cliOutput('Qdrant Status');
      cliOutput('═══════════════════════════════════════════════════');
      if (currentProvider === 'qdrant') {
        cliOutput(`Active provider: qdrant ✓`);
      } else {
        cliOutput(`Active provider: ${currentProvider}`);
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

        const collectionName = vectorConfig?.collection || 'nano-brain';
        try {
          const collectionRes = await fetch(`${resolvedUrl}/collections/${encodeURIComponent(collectionName)}`);
          if (collectionRes.ok) {
            const collectionData = await collectionRes.json();
            const result = collectionData.result || collectionData;
            cliOutput(`Collection: ${collectionName}`);
            cliOutput(`  Vectors: ${result.points_count ?? result.vectors_count ?? 'unknown'}`);
            cliOutput(`  Dimensions: ${result.config?.params?.vectors?.size ?? 'unknown'}`);
          } else {
            cliOutput(`Collection: ${collectionName} (not created yet)`);
          }
        } catch {
          cliOutput(`Collection: ${collectionName} (not created yet)`);
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
      cliError('Available: up, down, status, activate, recreate');
      process.exit(1);
  }
}
