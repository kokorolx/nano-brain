import { loadCollectionConfig, saveCollectionConfig } from '../../collections.js';
import { createEmbeddingProvider } from '../../embeddings.js';
import { resolveHostUrl } from '../../host.js';
import { QdrantVecStore } from '../../providers/qdrant.js';
import { openDatabase } from '../../store.js';
import type { VectorPoint } from '../../vector-store.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { NANO_BRAIN_HOME, DEFAULT_DB_DIR } from '../utils.js';

interface VectorConfigSection {
  provider: 'sqlite-vec' | 'qdrant';
  url?: string;
  apiKey?: string;
  collection?: string;
}

export async function handleQdrant(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing qdrant subcommand (up, down, status, migrate, verify, activate, cleanup, recreate)');
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
      const collectionName = vectorConfig?.collection || 'nano-brain';
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
          const collectionRes = await fetch(`${resolvedUrl}/collections/${encodeURIComponent(collectionName)}`);
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
        const collectionRes = await fetch(`${resolvedUrl}/collections/${encodeURIComponent(collectionName)}`);
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
      const collectionName = vectorConfig?.collection || 'nano-brain';
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
        const collectionRes = await fetch(`${resolvedUrl}/collections/${encodeURIComponent(collectionName)}`);
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
