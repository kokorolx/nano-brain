import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import { loadCollectionConfig, saveCollectionConfig } from '../collections.js';
import type { EmbeddingConfig, RerankerConfig, ConsolidationConfig, ExtractionConfig } from '../types.js';
import { checkOllamaHealth } from '../embeddings.js';
import { DEFAULT_MEMORY_DIR, DEFAULT_OUTPUT_DIR } from './utils.js';

// ── TTY helpers ──────────────────────────────────────────────────────────────

function createRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string, defaultVal = ''): Promise<string> {
  const hint = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${hint}: `, ans => resolve(ans.trim() || defaultVal));
  });
}

function askYN(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise(resolve => {
    rl.question(`${question} ${hint}: `, ans => {
      const a = ans.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

async function askSecret(question: string, existing?: string): Promise<string> {
  if (existing) {
    const masked = existing.slice(0, 6) + '…';
    process.stdout.write(`${question} [${masked}]: `);
  } else {
    process.stdout.write(`${question}: `);
  }

  if (!process.stdin.isTTY) {
    return new Promise(resolve => {
      let val = '';
      const onData = (chunk: Buffer) => {
        val += chunk.toString();
        if (val.includes('\n')) {
          process.stdin.removeListener('data', onData);
          resolve(val.replace(/\r?\n.*/, '').trim() || existing || '');
        }
      };
      process.stdin.on('data', onData);
    });
  }

  return new Promise(resolve => {
    let val = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onKey = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        process.stdout.write('\n');
        resolve(val || existing || '');
      } else if (ch === '') {
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '') {
        if (val.length > 0) { val = val.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        val += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onKey);
  });
}

interface Choice { label: string; value: string; hint?: string }

async function askChoice(
  rl: readline.Interface,
  question: string,
  choices: Choice[],
  defaultIdx = 0,
): Promise<string> {
  process.stdout.write(`\n? ${question}\n`);
  choices.forEach((c, i) => {
    const arrow = i === defaultIdx ? '❯' : ' ';
    const hint = c.hint ? `  — ${c.hint}` : '';
    process.stdout.write(`  ${arrow} ${i + 1}. ${c.label}${hint}\n`);
  });
  const raw = await ask(rl, `Enter choice`, String(defaultIdx + 1));
  const idx = parseInt(raw, 10) - 1;
  return (idx >= 0 && idx < choices.length) ? choices[idx].value : choices[defaultIdx].value;
}

// ── Section wizards ──────────────────────────────────────────────────────────

async function setupEmbedding(
  rl: readline.Interface,
  existing?: EmbeddingConfig,
): Promise<{ embedding?: EmbeddingConfig; reranker?: RerankerConfig } | null> {
  const envVoyage = process.env.VOYAGE_API_KEY;
  const envOpenAI = process.env.OPENAI_API_KEY;

  const defaultIdx = envVoyage ? 0 : envOpenAI ? 1 : 2;

  const choice = await askChoice(rl, 'Embedding provider (semantic search):', [
    { label: 'VoyageAI', value: 'voyage', hint: 'best quality, API key needed' },
    { label: 'OpenAI', value: 'openai', hint: 'good quality, API key needed' },
    { label: 'Ollama', value: 'ollama', hint: 'local & free, needs Ollama running' },
    { label: 'Custom URL', value: 'custom', hint: 'any OpenAI-compatible endpoint' },
    { label: 'Skip', value: 'skip', hint: 'BM25 text search only' },
  ], defaultIdx);

  if (choice === 'skip') return { embedding: existing };

  if (choice === 'voyage') {
    const apiKey = await askSecret('  VoyageAI API key', envVoyage || existing?.apiKey);
    if (!apiKey) { process.stdout.write('  ⚠️  No key provided — skipping\n'); return null; }
    const model = await ask(rl, '  Model', 'voyage-code-3');
    process.stdout.write('  ✅ VoyageAI embedding + reranker configured\n');
    return {
      embedding: { provider: 'openai', url: 'https://api.voyageai.com/v1', model, apiKey, maxChars: 16000 },
      reranker: { provider: 'voyageai', apiKey, model: 'rerank-2.5-lite' },
    };
  }

  if (choice === 'openai') {
    const apiKey = await askSecret('  OpenAI API key', envOpenAI || existing?.apiKey);
    if (!apiKey) { process.stdout.write('  ⚠️  No key provided — skipping\n'); return null; }
    const model = await ask(rl, '  Model', 'text-embedding-3-small');
    process.stdout.write('  ✅ OpenAI embedding configured\n');
    return { embedding: { provider: 'openai', url: 'https://api.openai.com/v1', model, apiKey } };
  }

  if (choice === 'ollama') {
    const defaultUrl = existing?.url || process.env.OLLAMA_HOST || 'http://localhost:11434';
    const url = await ask(rl, '  Ollama URL', defaultUrl);
    const health = await checkOllamaHealth(url);
    if (!health.reachable) process.stdout.write(`  ⚠️  Ollama not reachable at ${url} — check it's running\n`);
    else process.stdout.write(`  ✅ Ollama reachable\n`);
    const model = await ask(rl, '  Model', 'nomic-embed-text');
    return { embedding: { provider: 'ollama', url, model } };
  }

  if (choice === 'custom') {
    const url = await ask(rl, '  Endpoint URL (OpenAI-compatible)', existing?.url || '');
    if (!url) { process.stdout.write('  ⚠️  URL required — skipping\n'); return null; }
    const model = await ask(rl, '  Model name', existing?.model || '');
    const needsKey = await askYN(rl, '  Requires API key?', true);
    let apiKey: string | undefined;
    if (needsKey) { apiKey = await askSecret('  API key', existing?.apiKey); }
    const maxChars = parseInt(await ask(rl, '  Max chars per chunk', '8000'), 10);
    process.stdout.write('  ✅ Custom embedding configured\n');
    return { embedding: { provider: 'openai', url, model, apiKey, maxChars } };
  }

  return null;
}

async function setupLLM(
  rl: readline.Interface,
  existingConsolidation?: Partial<ConsolidationConfig>,
  existingExtraction?: Partial<ExtractionConfig>,
): Promise<{ consolidation?: Partial<ConsolidationConfig>; extraction?: Partial<ExtractionConfig> } | null> {
  const envOpenAI = process.env.OPENAI_API_KEY;
  const envAnthropic = process.env.ANTHROPIC_API_KEY;

  process.stdout.write('\n');
  const choice = await askChoice(rl, 'LLM for memory consolidation & entity extraction:', [
    { label: 'OpenAI', value: 'openai', hint: 'gpt-4o-mini (recommended)' },
    { label: 'Custom URL', value: 'custom', hint: 'Ollama, local LLM, Anthropic proxy, etc.' },
    { label: 'Skip', value: 'skip', hint: 'disable auto-consolidation' },
  ], envOpenAI ? 0 : 2);

  if (choice === 'skip') {
    return {
      consolidation: { enabled: false },
      extraction: { enabled: false },
    };
  }

  let endpoint: string;
  let model: string;
  let apiKey: string | undefined;

  if (choice === 'openai') {
    endpoint = 'https://api.openai.com/v1';
    model = 'gpt-4o-mini';
    apiKey = await askSecret('  OpenAI API key', envOpenAI || existingConsolidation?.apiKey);
    if (!apiKey) { process.stdout.write('  ⚠️  No key provided — skipping LLM\n'); return null; }
    process.stdout.write('  ✅ OpenAI LLM configured\n');
  } else {
    endpoint = await ask(rl, '  Endpoint URL (OpenAI-compatible)', existingConsolidation?.endpoint || 'http://localhost:11434/v1');
    model = await ask(rl, '  Model name', existingConsolidation?.model || 'llama3');
    const needsKey = await askYN(rl, '  Requires API key?', false);
    if (needsKey) {
      apiKey = await askSecret('  API key', envAnthropic || existingConsolidation?.apiKey);
    }
    process.stdout.write('  ✅ Custom LLM configured\n');
  }

  const llmBase = { enabled: true as const, provider: 'openai' as const, endpoint, model, apiKey };
  return {
    consolidation: {
      ...llmBase,
      max_memories_per_cycle: existingConsolidation?.max_memories_per_cycle ?? 20,
      min_memories_threshold: existingConsolidation?.min_memories_threshold ?? 2,
      confidence_threshold: existingConsolidation?.confidence_threshold ?? 0.6,
      interval_ms: existingConsolidation?.interval_ms ?? 3600000,
    },
    extraction: {
      enabled: true,
      model,
      endpoint,
      apiKey,
      maxFactsPerSession: existingExtraction?.maxFactsPerSession ?? 20,
    },
  };
}

async function setupQdrant(
  rl: readline.Interface,
  existing?: { url?: string },
): Promise<{ url: string; collection: string } | null> {
  const envQdrant = process.env.QDRANT_URL;

  process.stdout.write('\n');
  const choice = await askChoice(rl, 'Vector search (Qdrant):', [
    { label: 'Local (localhost:6333)', value: 'local', hint: 'already running or use Docker' },
    { label: 'Custom URL', value: 'custom', hint: 'external Qdrant instance' },
    { label: 'Skip', value: 'skip', hint: 'disable vector search' },
  ], envQdrant || existing?.url ? (existing?.url?.includes('localhost') ? 0 : 1) : 0);

  if (choice === 'skip') return null;

  const defaultUrl = envQdrant || existing?.url || 'http://localhost:6333';

  if (choice === 'local') {
    process.stdout.write('  ✅ Qdrant at localhost:6333\n');
    return { url: 'http://localhost:6333', collection: 'nano-brain' };
  }

  const url = await ask(rl, '  Qdrant URL', defaultUrl);
  const collection = await ask(rl, '  Collection name', 'nano-brain');
  process.stdout.write(`  ✅ Qdrant at ${url}\n`);
  return { url, collection };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runSetupWizard(configPath: string, cwd: string): Promise<void> {
  const rl = createRl();

  process.stdout.write('\n🧠 nano-brain — Setup Wizard\n');
  process.stdout.write('━'.repeat(40) + '\n\n');

  const existing = loadCollectionConfig(configPath) ?? {};

  // 1. Workspace
  const addWorkspace = await askYN(rl, `? Add "${cwd}" as workspace?`, true);

  // 2. Embedding
  process.stdout.write('\n');
  const embResult = await setupEmbedding(rl, existing.embedding);

  // 3. LLM
  const llmResult = await setupLLM(rl, existing.consolidation, existing.extraction);

  // 4. Qdrant
  const qdrantResult = await setupQdrant(rl, existing.vector);

  rl.close();

  // ── Build updated config ──────────────────────────────────────────────────

  const config = { ...existing };

  // Default collections if brand new
  if (!config.collections) {
    config.collections = {
      memory: { path: DEFAULT_MEMORY_DIR, pattern: '**/*.md', update: 'auto' },
      sessions: { path: DEFAULT_OUTPUT_DIR, pattern: '**/*.md', update: 'auto' },
    };
  }

  if (addWorkspace) {
    if (!config.workspaces) config.workspaces = {};
    config.workspaces[cwd] = { codebase: { enabled: true } };
  }

  if (embResult?.embedding) config.embedding = embResult.embedding;
  if (embResult?.reranker) config.reranker = embResult.reranker;

  if (llmResult?.consolidation) config.consolidation = llmResult.consolidation as ConsolidationConfig;
  if (llmResult?.extraction) config.extraction = llmResult.extraction as ExtractionConfig;

  if (qdrantResult) {
    config.vector = { provider: 'qdrant', url: qdrantResult.url, collection: qdrantResult.collection };
  }

  saveCollectionConfig(configPath, config);

  process.stdout.write('\n✅ Config saved → ' + configPath + '\n');
  process.stdout.write('Run `npx nano-brain init` to index your workspace.\n\n');
}

export async function promptAddWorkspace(configPath: string, cwd: string): Promise<boolean> {
  const config = loadCollectionConfig(configPath);
  if (!config || config.workspaces?.[cwd]) return false; // already configured

  const rl = createRl();
  process.stdout.write(`\n💡 "${cwd}" is not tracked by nano-brain.\n`);
  const yes = await askYN(rl, '   Add as workspace?', true);
  rl.close();

  if (yes) {
    if (!config.workspaces) config.workspaces = {};
    config.workspaces[cwd] = { codebase: { enabled: true } };
    saveCollectionConfig(configPath, config);
    process.stdout.write('✅ Workspace added. Run `npx nano-brain init` to index it.\n\n');
  }

  return yes;
}
