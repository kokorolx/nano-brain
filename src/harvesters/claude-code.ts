// src/harvesters/claude-code.ts
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { SessionSourceAdapter, AdapterResult } from './types.js';
import type { HarvestState } from './shared.js';
import { writeSession, sessionToMarkdown, saveHarvestState } from './shared.js';
import type { ExtractionConfig, Store, HarvestedSession, ConsolidationConfig } from '../types.js';
import { log } from '../logger.js';
import { extractFactsFromSession, storeExtractedFact } from '../extraction.js';
import { createLLMProvider } from '../llm-provider.js';

const DEFAULT_SESSION_DIR = join(homedir(), '.claude/projects');
const MAX_EXTRACTED_FACTS = 10000;

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      typeof item === 'object' && item !== null &&
      (item as Record<string, unknown>).type === 'text'
    )
    .map(item => item.text)
    .join('\n');
}

export class ClaudeCodeAdapter implements SessionSourceAdapter {
  readonly name = 'claude-code';

  constructor(private sessionDir: string = DEFAULT_SESSION_DIR) {}

  isAvailable(): boolean {
    return existsSync(this.sessionDir);
  }

  async readNewSessions(
    state: HarvestState,
    outputDir: string,
    extractionConfig?: ExtractionConfig,
    store?: Store,
  ): Promise<AdapterResult> {
    const sessions: HarvestedSession[] = [];
    let stateChanged = false;
    const stats = { processed: 0, skipped: 0, incremental: 0, errors: 0 };
    const extractionStats = { factsExtracted: 0, duplicatesSkipped: 0, errors: 0 };
    const projectNames = new Map<string, string>();

    // Build LLM provider once, outside all loops (Fix: was created per-session)
    const provider = (extractionConfig?.enabled && store) ? (() => {
      const llmConfig: ConsolidationConfig = {
        enabled: true,
        interval_ms: 0,
        model: extractionConfig.model,
        endpoint: extractionConfig.endpoint,
        apiKey: extractionConfig.apiKey,
        max_memories_per_cycle: 0,
        min_memories_threshold: 0,
        confidence_threshold: 0,
      };
      return createLLMProvider(llmConfig);
    })() : null;

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(this.sessionDir);
    } catch {
      return { sessions, stateChanged, stats };
    }

    for (const projectSlug of projectDirs) {
      const projectDir = join(this.sessionDir, projectSlug);
      const indexPath = join(projectDir, 'sessions-index.json');

      let entries: SessionIndexEntry[] = [];

      if (existsSync(indexPath)) {
        try {
          const raw = readFileSync(indexPath, 'utf-8');
          const index = JSON.parse(raw) as { entries?: SessionIndexEntry[] };
          entries = (index.entries ?? []).filter(e => !e.isSidechain);
        } catch {
          log('claude-harvester', `Failed to parse sessions-index.json in ${projectSlug}`, 'warn');
          continue;
        }
      } else {
        // Fallback: scan .jsonl files directly
        try {
          const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
          entries = files.map(f => ({
            sessionId: f.replace('.jsonl', ''),
            fullPath: f,
            fileMtime: 0,
            firstPrompt: '',
            messageCount: 0,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            gitBranch: '',
            projectPath: projectSlug.replace(/^-/, '/').replace(/-/g, '/'),
            isSidechain: false,
          }));
        } catch {
          continue;
        }
      }

      for (const entry of entries) {
        const { sessionId, fileMtime, firstPrompt, projectPath, created } = entry;

        // State check
        const existingState = state[sessionId];
        if (
          existingState &&
          existingState.mtime >= fileMtime &&
          existingState.messageCount !== undefined
        ) {
          stats.skipped++;
          continue;
        }

        const jsonlFile = entry.fullPath.endsWith('.jsonl') ? entry.fullPath : `${sessionId}.jsonl`;
        const jsonlPath = join(projectDir, jsonlFile);
        if (!existsSync(jsonlPath)) {
          stats.skipped++;
          continue;
        }

        try {
          const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
          let title = firstPrompt || 'untitled';
          const messages: Array<{ role: 'user' | 'assistant'; agent?: string; text: string }> = [];

          for (const line of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              const type = event.type as string;

              if (type === 'ai-title') {
                title = (event.aiTitle as string) || title;
                continue;
              }

              if (type !== 'user' && type !== 'assistant') continue;

              const msg = event.message as { role?: string; content?: unknown } | undefined;
              if (!msg) continue;

              const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant';
              const text = extractTextFromContent(msg.content);

              if (!text.trim()) continue;

              messages.push({
                role,
                agent: role === 'assistant' ? 'claude-code' : undefined,
                text,
              });
            } catch {
              // malformed line — skip
            }
          }

          if (messages.length === 0) {
            state[sessionId] = { mtime: fileMtime, messageCount: 0, skipped: true };
            stateChanged = true;
            stats.skipped++;
            continue;
          }

          const dateStr = created.split('T')[0];
          const slug = sessionId.substring(0, 8);
          const projectHash = createHash('sha256').update(projectPath).digest('hex').substring(0, 12);

          const harvestedSession: HarvestedSession = {
            sessionId,
            slug,
            title,
            agent: 'claude-code',
            date: dateStr,
            project: projectPath,
            projectHash,
            messages,
          };

          writeSession(harvestedSession, outputDir, projectNames);

          sessions.push(harvestedSession);
          state[sessionId] = { mtime: fileMtime, messageCount: messages.length };
          stateChanged = true;
          stats.processed++;

          // Optional LLM extraction (provider created once before loops)
          if (provider && store) {
            try {
              const health = store.getIndexHealth();
              if ((health.extractedFacts ?? 0) < MAX_EXTRACTED_FACTS) {
                const result = await extractFactsFromSession(
                  sessionToMarkdown(harvestedSession),
                  provider,
                  extractionConfig!,
                );
                for (const fact of result.facts) {
                  const stored = storeExtractedFact(store, fact, sessionId, projectHash);
                  if (stored) extractionStats.factsExtracted++;
                  else extractionStats.duplicatesSkipped++;
                }
              }
            } catch (err) {
              extractionStats.errors++;
              log('claude-harvester', `Extraction failed for ${sessionId}: ${String(err)}`, 'warn');
            }
          }
        } catch (err) {
          stats.errors++;
          log('claude-harvester', `Failed to process session ${sessionId}: ${String(err)}`, 'warn');
        }
      }
    }

    if (stateChanged) {
      saveHarvestState(join(outputDir, '.harvest-state-claude-code.json'), state);
    }

    log('claude-harvester', `Harvest complete: ${stats.processed} processed, ${stats.skipped} skipped, ${stats.errors} errors`);

    return { sessions, stateChanged, stats: { ...stats, extractionStats } };
  }
}
