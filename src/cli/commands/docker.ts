import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { NANO_BRAIN_HOME, getHttpHost } from '../utils.js';

export async function handleDocker(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const subcommand = commandArgs[0];

  if (!subcommand) {
    cliError('Missing docker subcommand (start, stop, restart, status)');
    process.exit(1);
  }

  log('cli', 'docker subcommand=' + subcommand);

  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
  const composeFile = path.join(packageRoot, 'docker-compose.yml');

  if (!fs.existsSync(composeFile)) {
    cliError('docker-compose.yml not found at ' + composeFile);
    process.exit(1);
  }

  const env = {
    ...process.env,
    NANO_BRAIN_APP: packageRoot,
    NANO_BRAIN_HOME: NANO_BRAIN_HOME,
  };

  switch (subcommand) {
    case 'start': {
      const configTarget = path.join(NANO_BRAIN_HOME, 'config.yml');
      const defaultConfig = path.join(packageRoot, 'config.default.yml');
      if (!fs.existsSync(configTarget) && fs.existsSync(defaultConfig)) {
        fs.mkdirSync(NANO_BRAIN_HOME, { recursive: true });
        fs.copyFileSync(defaultConfig, configTarget);
        cliOutput('Created default config at ' + configTarget);
      }

      for (const dir of ['data', 'memory', 'sessions', 'logs']) {
        fs.mkdirSync(path.join(NANO_BRAIN_HOME, dir), { recursive: true });
      }

      try {
        const configYmlPath = path.join(NANO_BRAIN_HOME, 'config.yml');
        const rawConfig = fs.readFileSync(configYmlPath, 'utf-8');
        const config = parseYaml(rawConfig) as Record<string, any>;
        if (config?.vector?.url === 'http://host.docker.internal:6333') {
          config.vector.url = 'http://qdrant:6333';
          fs.writeFileSync(configYmlPath, stringifyYaml(config), 'utf-8');
          cliOutput('[nano-brain] Migrated vector.url from host.docker.internal:6333 → qdrant:6333');
        }
      } catch {}

      cliOutput('Starting nano-brain + qdrant...');
      try {
        execSync(`docker compose -f "${composeFile}" up -d`, { stdio: 'inherit', env });
      } catch {
        cliError('Failed to start. Is Docker running?');
        process.exit(1);
      }

      const healthUrl = `http://${getHttpHost()}:3100/health`;
      let healthy = false;
      const maxRetries = 20;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const res = await fetch(healthUrl);
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {}
        cliOutput(`Waiting for nano-brain... (${i + 1}/${maxRetries})`);
      }

      if (healthy) {
        cliOutput('✅ nano-brain is running on http://localhost:3100');
      } else {
        cliError('nano-brain did not become healthy. Check: docker logs nano-brain-server');
      }
      break;
    }

    case 'stop': {
      cliOutput('Stopping nano-brain + qdrant...');
      try {
        execSync(`docker compose -f "${composeFile}" down`, { stdio: 'inherit', env });
      } catch {
        cliError('Failed to stop containers');
        process.exit(1);
      }
      cliOutput('✅ Stopped. Data persists in ~/.nano-brain and Docker volumes.');
      break;
    }

    case 'restart': {
      const target = commandArgs[1] || '';
      if (target && target !== 'nano-brain' && target !== 'qdrant') {
        cliError(`Unknown service: ${target}. Use: nano-brain, qdrant, or omit for all`);
        process.exit(1);
      }

      const service = target || '';
      const label = service || 'nano-brain + qdrant';
      cliOutput(`Restarting ${label}...`);
      try {
        execSync(`docker compose -f "${composeFile}" restart ${service}`, { stdio: 'inherit', env });
      } catch {
        cliError('Failed to restart. Is Docker running?');
        process.exit(1);
      }

      const restartHealthUrl = `http://${getHttpHost()}:3100/health`;
      let healthy = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const res = await fetch(restartHealthUrl);
          if (res.ok) {
            const data = await res.json() as { ready?: boolean };
            if (data.ready) {
              healthy = true;
              break;
            }
          }
        } catch {}
        cliOutput(`Waiting for nano-brain... (${i + 1}/15)`);
      }

      if (healthy) {
        cliOutput('✅ nano-brain restarted and ready on http://localhost:3100');
      } else {
        cliError('nano-brain did not become healthy. Check: docker logs nano-brain-server');
      }
      break;
    }

    case 'status': {
      let containerOutput = '';
      try {
        containerOutput = execSync(
          `docker compose -f "${composeFile}" ps --format json 2>/dev/null`,
          { env, encoding: 'utf-8' }
        ).trim();
      } catch {
      }

      cliOutput('nano-brain Docker Status');
      cliOutput('═══════════════════════════════════════════════════');

      if (containerOutput) {
        const lines = containerOutput.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const info = JSON.parse(line);
            const name = info.Name || info.Service || 'unknown';
            const state = info.State || info.Status || 'unknown';
            const health = info.Health || '';
            const icon = state === 'running' ? '✅' : '❌';
            cliOutput(`  ${icon} ${name}: ${state}${health ? ` (${health})` : ''}`);
          } catch {
            cliOutput(`  ${line}`);
          }
        }
      } else {
        cliOutput('  ❌ No containers running');
      }

      cliOutput('');
      try {
        const res = await fetch(`http://${getHttpHost()}:3100/health`);
        if (res.ok) {
          cliOutput('  API: ✅ http://localhost:3100');
        } else {
          cliOutput('  API: ❌ unhealthy (status ' + res.status + ')');
        }
      } catch {
        cliOutput('  API: ❌ not reachable');
      }

      try {
        const res = await fetch('http://localhost:6333/healthz');
        if (res.ok) {
          cliOutput('  Qdrant: ✅ http://localhost:6333');
        } else {
          cliOutput('  Qdrant: ❌ unhealthy');
        }
      } catch {
        cliOutput('  Qdrant: ❌ not reachable');
      }

      break;
    }

    default:
      cliError(`Unknown docker subcommand: ${subcommand}. Use: start, stop, restart, status`);
      process.exit(1);
  }
}
