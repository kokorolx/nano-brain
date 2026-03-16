import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HarvestedSession, ExtractionConfig, Store } from './types.js';
import { log } from './logger.js';
import { openDatabase } from './store.js';
import { createLLMProvider } from './llm-provider.js';
import { extractFactsFromSession, storeExtractedFact } from './extraction.js';
import type { ConsolidationConfig } from './types.js';

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

export interface HarvesterOptions {
  sessionDir: string;
  outputDir: string;
  stateFile?: string;
  extractionConfig?: ExtractionConfig;
  store?: Store;
}

export interface ExtractionStats {
  factsExtracted: number;
  duplicatesSkipped: number;
  errors: number;
  limitReached?: boolean;
}

const MAX_EXTRACTED_FACTS = 10000;

interface SessionMetadata {
  id: string;
  slug: string;
  title: string;
  projectID: string;
  directory: string;
  created: number;
}

interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant';
  agent?: string;
  created: number;
}

interface HarvestStateEntry {
  mtime: number;
  retries?: number;
  skipped?: boolean;
  messageCount?: number;
}

type HarvestState = Record<string, HarvestStateEntry>;

interface DbSession {
  id: string;
  slug: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface DbMessage {
  id: string;
  time_created: number;
  data: string;
}

interface DbPart {
  data: string;
}

interface HarvestFromDbResult {
  harvested: HarvestedSession[];
  stateChanged: boolean;
  processedCount: number;
  skippedCount: number;
  incrementalCount: number;
  extractionStats?: ExtractionStats;
  errorCount: number;
}

export function parseSession(sessionPath: string): SessionMetadata | null {
  try {
    if (!existsSync(sessionPath)) {
      return null;
    }
    
    const content = readFileSync(sessionPath, 'utf-8');
    const data = JSON.parse(content);
    
    return {
      id: data.id,
      slug: data.slug || data.id || 'untitled',
      title: data.title || '',
      projectID: data.projectID,
      directory: data.directory,
      created: data.time?.created || 0
    };
  } catch {
    return null;
  }
}

export async function parseMessages(sessionId: string, storageDir: string): Promise<ParsedMessage[]> {
  const messageDir = join(storageDir, 'message', sessionId);
  
  if (!existsSync(messageDir)) {
    return [];
  }
  
  const messages: ParsedMessage[] = [];
  
  try {
    const files = readdirSync(messageDir).filter(f => f.startsWith('msg_') && f.endsWith('.json'));
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = join(messageDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      messages.push({
        id: data.id,
        role: data.role,
        agent: data.agent,
        created: data.time?.created || 0
      });
      
      if (i % 50 === 0) await yieldToEventLoop();
    }
  } catch {
    return [];
  }
  
  messages.sort((a, b) => a.created - b.created);
  
  return messages;
}

export async function parseParts(messageId: string, storageDir: string): Promise<string> {
  const partDir = join(storageDir, 'part', messageId);
  
  if (!existsSync(partDir)) {
    return '';
  }
  
  const textParts: string[] = [];
  
  try {
    const files = readdirSync(partDir).filter(f => f.startsWith('prt_') && f.endsWith('.json'));
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = join(partDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      if (data.type === 'text' && !data.synthetic && data.text) {
        textParts.push(data.text);
      }
      
      if (i % 30 === 0) await yieldToEventLoop();
    }
  } catch {
    return '';
  }
  
  return textParts.join('\n');
}

export function sessionToMarkdown(session: HarvestedSession): string {
  const lines: string[] = [];
  
  lines.push('---');
  lines.push(`session: ${session.sessionId}`);
  lines.push(`agent: ${session.agent}`);
  lines.push(`date: "${session.date}"`);
  lines.push(`title: "${session.title}"`);
  lines.push(`project: ${session.project}`);
  lines.push(`projectHash: ${session.projectHash}`);
  lines.push('---');
  lines.push('');
  
  for (const message of session.messages) {
    if (message.role === 'user') {
      lines.push('## User');
    } else {
      const agentName = message.agent || 'assistant';
      lines.push(`## Assistant (${agentName})`);
    }
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  
  return lines.join('\n');
}

export function messagesToMarkdown(messages: Array<{ role: string; agent?: string; text: string }>): string {
  const lines: string[] = [];
  
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## User');
    } else {
      const agentName = message.agent || 'assistant';
      lines.push(`## Assistant (${agentName})`);
    }
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  
  return lines.join('\n');
}

export function getOutputPath(outputDir: string, projectPath: string, date: string, slug: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex');
  const projectHash = hash.substring(0, 12);
  
  const sanitizedSlug = (slug || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  
  return join(outputDir, projectHash, `${date}-${sanitizedSlug}.md`);
}

export function loadHarvestState(stateFile: string): HarvestState {
  try {
    if (!existsSync(stateFile)) {
      return {};
    }
    
    const content = readFileSync(stateFile, 'utf-8');
    const raw = JSON.parse(content);
    const state: HarvestState = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number') {
        state[key] = { mtime: value };
      } else {
        state[key] = value as HarvestStateEntry;
      }
    }
    return state;
  } catch {
    return {};
  }
}

export function saveHarvestState(stateFile: string, state: HarvestState): void {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

export function getMessageDirMtime(sessionId: string, storageDir: string): number | null {
  const messageDir = join(storageDir, 'message', sessionId);
  try {
    if (!existsSync(messageDir)) {
      return null;
    }
    const stat = statSync(messageDir);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function harvestFromDb(
  dbPath: string,
  outputDir: string,
  stateFile: string,
  state: HarvestState,
  extractionConfig?: ExtractionConfig,
  store?: Store
): Promise<HarvestFromDbResult> {
  const harvested: HarvestedSession[] = [];
  let stateChanged = false;
  let processedCount = 0;
  let skippedCount = 0;
  let incrementalCount = 0;
  let errorCount = 0;
  const extractionStats: ExtractionStats = { factsExtracted: 0, duplicatesSkipped: 0, errors: 0 };

  const db = openDatabase(dbPath, { readonly: true });

  try {
    const sessionsStmt = db.prepare<[], DbSession>(
      'SELECT id, slug, directory, title, time_created, time_updated FROM session'
    );
    const messagesStmt = db.prepare<[string], DbMessage>(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC'
    );
    const partsStmt = db.prepare<[string], DbPart>(
      'SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC'
    );
    const messageCountStmt = db.prepare<[string], { count: number }>(
      'SELECT count(*) as count FROM message WHERE session_id = ?'
    );

    const sessions = sessionsStmt.all();
    const totalSessions = sessions.length;

    for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex++) {
      const session = sessions[sessionIndex];
      const sessionId = session.id;
      
      if (sessionIndex % 5 === 0) await yieldToEventLoop();

      if (state[sessionId]?.skipped) {
        skippedCount++;
        continue;
      }

      if (
        state[sessionId] &&
        state[sessionId].mtime >= session.time_updated &&
        state[sessionId].messageCount !== undefined
      ) {
        const dbMsgCount = messageCountStmt.get(sessionId)?.count ?? 0;
        if (dbMsgCount <= (state[sessionId].messageCount ?? 0)) {
          skippedCount++;
          continue;
        }
      }

      const dbMessages = messagesStmt.all(sessionId);

      if (dbMessages.length === 0) {
        state[sessionId] = { mtime: session.time_updated, skipped: true };
        stateChanged = true;
        skippedCount++;
        continue;
      }

      const previousMessageCount = state[sessionId]?.messageCount ?? 0;

      const date = new Date(session.time_created);
      const dateStr = date.toISOString().split('T')[0];
      const outputPath = getOutputPath(outputDir, session.directory, dateStr, session.slug);
      const outputDirPath = dirname(outputPath);

      const isIncremental = previousMessageCount > 0 && existsSync(outputPath);
      const messagesToProcess = isIncremental
        ? dbMessages.slice(previousMessageCount)
        : dbMessages;

      if (messagesToProcess.length === 0) {
        skippedCount++;
        continue;
      }

      const parsedMessages: Array<{ role: 'user' | 'assistant'; agent?: string; text: string }> = [];

      for (const msg of messagesToProcess) {
        let role: 'user' | 'assistant' = 'assistant';
        let agent: string | undefined;

        try {
          const msgData = JSON.parse(msg.data);
          role = msgData.role === 'user' ? 'user' : 'assistant';
          agent = msgData.agent;
        } catch {
        }

        const parts = partsStmt.all(msg.id);
        const textParts: string[] = [];

        for (const part of parts) {
          try {
            const partData = JSON.parse(part.data);
            if (partData.type === 'text' && !partData.synthetic && partData.text) {
              textParts.push(partData.text);
            }
          } catch {
          }
        }

        parsedMessages.push({
          role,
          agent,
          text: textParts.join('\n')
        });
      }

      const hasContent = parsedMessages.some(m => m.text.trim().length > 0);
      if (!hasContent) {
        state[sessionId] = { mtime: session.time_updated, skipped: true };
        stateChanged = true;
        skippedCount++;
        continue;
      }

      const hash = createHash('sha256').update(session.directory).digest('hex');
      const projectHashStr = hash.substring(0, 12);

      if (!existsSync(outputDirPath)) {
        mkdirSync(outputDirPath, { recursive: true });
      }

      try {
        if (isIncremental) {
          const newMarkdown = messagesToMarkdown(parsedMessages);
          appendFileSync(outputPath, newMarkdown, 'utf-8');
        } else {
          const fullSession: HarvestedSession = {
            sessionId: session.id,
            slug: session.slug,
            title: session.title || '',
            agent: parsedMessages.find(m => m.role === 'assistant')?.agent || 'assistant',
            date: dateStr,
            project: session.directory,
            projectHash: projectHashStr,
            messages: parsedMessages
          };
          const markdown = sessionToMarkdown(fullSession);
          writeFileSync(outputPath, markdown, 'utf-8');
        }

        if (!existsSync(outputPath)) {
          log('harvester', 'Write failed: ' + outputPath + ' (file not found after write)');
          errorCount++;
          continue;
        }

        const harvestedSession: HarvestedSession = {
          sessionId: session.id,
          slug: session.slug,
          title: session.title || '',
          agent: parsedMessages.find(m => m.role === 'assistant')?.agent || 'assistant',
          date: dateStr,
          project: session.directory,
          projectHash: projectHashStr,
          messages: parsedMessages
        };

        processedCount++;
        if (isIncremental) incrementalCount++;
        log('harvester', `Processed session: ${session.id}${isIncremental ? ' (incremental)' : ''} [${processedCount}/${totalSessions}]`);
        harvested.push(harvestedSession);
        state[sessionId] = { mtime: session.time_updated, messageCount: dbMessages.length };
        stateChanged = true;

        if (extractionConfig?.enabled && store) {
          try {
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
            const provider = createLLMProvider(llmConfig);
            if (provider) {
              const health = store.getIndexHealth();
              const currentFactCount = health.extractedFacts ?? 0;
              if (currentFactCount >= MAX_EXTRACTED_FACTS) {
                if (!extractionStats.limitReached) {
                  log('harvester', `Storage limit reached: ${currentFactCount} extracted facts (max ${MAX_EXTRACTED_FACTS}). Skipping extraction.`);
                  extractionStats.limitReached = true;
                }
              } else {
                const sessionMarkdown = sessionToMarkdown(harvestedSession);
                const result = await extractFactsFromSession(sessionMarkdown, provider, extractionConfig);
                for (const fact of result.facts) {
                  const updatedHealth = store.getIndexHealth();
                  const updatedFactCount = updatedHealth.extractedFacts ?? 0;
                  if (updatedFactCount >= MAX_EXTRACTED_FACTS) {
                    if (!extractionStats.limitReached) {
                      log('harvester', `Storage limit reached during extraction: ${updatedFactCount} extracted facts (max ${MAX_EXTRACTED_FACTS}). Stopping.`);
                      extractionStats.limitReached = true;
                    }
                    break;
                  }
                  const wasStored = storeExtractedFact(store, fact, session.id, projectHashStr);
                  if (wasStored) {
                    extractionStats.factsExtracted++;
                  } else {
                    extractionStats.duplicatesSkipped++;
                  }
                }
                log('harvester', `Extracted ${result.facts.length} facts from session ${session.id} (${extractionStats.factsExtracted} stored, ${extractionStats.duplicatesSkipped} duplicates)`);
              }
            }
          } catch (err) {
            extractionStats.errors++;
            log('harvester', 'Extraction failed for session ' + session.id + ': ' + String(err));
          }
        }
      } catch (err) {
        errorCount++;
        log('harvester', 'Write failed: ' + outputPath + ' - ' + String(err));
        continue;
      }
    }
  } finally {
    db.close();
  }

  return { harvested, stateChanged, processedCount, skippedCount, incrementalCount, errorCount, extractionStats };
}

export async function harvestSessions(options: HarvesterOptions): Promise<HarvestedSession[]> {
  const { sessionDir, outputDir, stateFile: customStateFile } = options;
  const stateFile = customStateFile || join(outputDir, '.harvest-state.json');
  const state = loadHarvestState(stateFile);
  
  const startTime = Date.now();
  const dbPath = join(dirname(sessionDir), 'opencode.db');

  if (existsSync(dbPath)) {
    let dbSessionCount = 0;
    try {
      const db = openDatabase(dbPath, { readonly: true });
      try {
        const row = db.prepare<[], { count: number }>('SELECT count(*) as count FROM session').get();
        dbSessionCount = row?.count ?? 0;
      } finally {
        db.close();
      }
    } catch {
    }

    if (dbSessionCount > 0) {
      log('harvester', `Starting harvest cycle: ${dbSessionCount} sessions (source: db)`);
      const result = await harvestFromDb(dbPath, outputDir, stateFile, state, options.extractionConfig, options.store);

      if (result.stateChanged) {
        saveHarvestState(stateFile, state);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const statsParts = [
        `${result.harvested.length} harvested`,
        result.incrementalCount > 0 ? `${result.incrementalCount} incremental` : null,
        `${result.skippedCount} skipped`,
        result.errorCount > 0 ? `${result.errorCount} errors` : null,
      ];
      if (result.extractionStats && (result.extractionStats.factsExtracted > 0 || result.extractionStats.duplicatesSkipped > 0)) {
        statsParts.push(`extracted ${result.extractionStats.factsExtracted} facts (${result.extractionStats.duplicatesSkipped} duplicates)`);
        if (result.extractionStats.errors > 0) {
          statsParts.push(`${result.extractionStats.errors} extraction errors`);
        }
      }
      statsParts.push(`${elapsed}s`);
      const stats = statsParts.filter(Boolean).join(', ');

      log('harvester', `Harvest complete: ${stats}`);
      if (result.harvested.length > 0) {
        log('harvester', 'Harvested ' + result.harvested.length + ' session(s) in ' + elapsed + 's');
      }

      return result.harvested;
    }
  }

  const harvested: HarvestedSession[] = [];
  const sessionRoot = join(sessionDir, 'session');

  if (!existsSync(sessionRoot)) {
    log('harvester', 'Harvest cycle: no session root found');
    return [];
  }

  const projectDirs = readdirSync(sessionRoot);

  let totalSessionFiles = 0;
  let totalSessionBytes = 0;
  for (const projectHash of projectDirs) {
    const projectSessionDir = join(sessionRoot, projectHash);
    if (!existsSync(projectSessionDir)) continue;
    try {
      const files = readdirSync(projectSessionDir).filter(f => f.startsWith('ses_') && f.endsWith('.json'));
      for (const file of files) {
        totalSessionFiles++;
        try {
          totalSessionBytes += statSync(join(projectSessionDir, file)).size;
        } catch {
        }
      }
    } catch {
    }
  }

  const sizeKB = (totalSessionBytes / 1024).toFixed(1);
  log('harvester', `Starting harvest cycle: ${totalSessionFiles} session files (${sizeKB} KB) across ${projectDirs.length} projects (source: json)`);
  
  let stateChanged = false;
  let processedCount = 0
  let skippedCount = 0
  let incrementalCount = 0
  let errorCount = 0
  const extractionStats: ExtractionStats = { factsExtracted: 0, duplicatesSkipped: 0, errors: 0 };
  
  for (const projectHash of projectDirs) {
    const projectSessionDir = join(sessionRoot, projectHash);
    
    if (!existsSync(projectSessionDir)) {
      continue;
    }
    
    const sessionFiles = readdirSync(projectSessionDir).filter(f => f.startsWith('ses_') && f.endsWith('.json'));
    
    for (let sessionFileIndex = 0; sessionFileIndex < sessionFiles.length; sessionFileIndex++) {
      const sessionFile = sessionFiles[sessionFileIndex];
      const sessionPath = join(projectSessionDir, sessionFile);
      
      if (sessionFileIndex % 5 === 0) await yieldToEventLoop();
      
      const stat = statSync(sessionPath);
      const lastMtime = stat.mtimeMs;
      const session_pre = parseSession(sessionPath);
      const messageDirMtime = session_pre ? getMessageDirMtime(session_pre.id, sessionDir) : null;
      const effectiveMtime = Math.max(lastMtime, messageDirMtime ?? 0);
      
      if (state[sessionFile]?.skipped) {
        skippedCount++
        continue;
      }
      
      if (state[sessionFile] && state[sessionFile].mtime >= effectiveMtime && state[sessionFile].messageCount !== undefined) {
        const session = parseSession(sessionPath);
        if (session) {
          const date = new Date(session.created);
          const dateStr = date.toISOString().split('T')[0];
          const outputPath = getOutputPath(outputDir, session.directory, dateStr, session.slug);
          if (existsSync(outputPath)) {
            // Quick check: count message files to catch additions within same mtime granularity
            const msgDir = join(sessionDir, 'message', session.id);
            try {
            const msgCount = readdirSync(msgDir).filter(f => f.endsWith('.json')).length;
                if (msgCount <= (state[sessionFile].messageCount ?? 0)) {
                  skippedCount++
                  continue;
                }
              // Message count changed despite same mtime — fall through to re-harvest
            } catch {
              continue;
            }
          }
          const entry = state[sessionFile] || { mtime: 0 };
          entry.retries = (entry.retries || 0) + 1;
          stateChanged = true;
          if (entry.retries >= 3) {
            entry.skipped = true;
            log('harvester', 'Permanently skipping ' + sessionFile + ' after 3 retries');
            state[sessionFile] = entry;
            continue;
          }
          state[sessionFile] = entry;
          log('harvester', 'Re-harvest triggered: ' + sessionFile + ' (output file missing, retry ' + entry.retries + ')');
        } else {
          continue;
        }
      }
      
      const session = parseSession(sessionPath);
      
      if (!session) {
        continue;
      }
      
      const messages = await parseMessages(session.id, sessionDir);
      
      const previousMessageCount = state[sessionFile]?.messageCount;
      if (previousMessageCount !== undefined && previousMessageCount >= messages.length) {
        skippedCount++
        continue;
      }
      
      if (messages.length === 0) {
        state[sessionFile] = { mtime: effectiveMtime, skipped: true };
        stateChanged = true;
        skippedCount++
        continue;
      }
      
      const date = new Date(session.created);
      const dateStr = date.toISOString().split('T')[0];
      const outputPath = getOutputPath(outputDir, session.directory, dateStr, session.slug);
      const outputDirPath = dirname(outputPath);
      
      const effectivePreviousCount = previousMessageCount ?? 0;
      const isIncremental = effectivePreviousCount > 0 && existsSync(outputPath);
      
      const messagesToProcess = isIncremental
        ? messages.slice(effectivePreviousCount)
        : messages;
      
      const parsedMessages: Array<{ role: 'user' | 'assistant'; agent?: string; text: string }> = [];
      for (const msg of messagesToProcess) {
        parsedMessages.push({
          role: msg.role,
          agent: msg.agent,
          text: await parseParts(msg.id, sessionDir)
        });
      }
      
      const hasContent = parsedMessages.some(m => m.text.trim().length > 0);
      if (!hasContent) {
        state[sessionFile] = { mtime: effectiveMtime, skipped: true };
        stateChanged = true;
        skippedCount++
        continue;
      }
      
      const hash = createHash('sha256').update(session.directory).digest('hex');
      const projectHashStr = hash.substring(0, 12);
      
      if (!existsSync(outputDirPath)) {
        mkdirSync(outputDirPath, { recursive: true });
      }
      
      try {
        if (isIncremental) {
          const newMarkdown = messagesToMarkdown(parsedMessages);
          appendFileSync(outputPath, newMarkdown, 'utf-8');
        } else {
          const fullSession: HarvestedSession = {
            sessionId: session.id,
            slug: session.slug,
            title: session.title,
            agent: messages.find(m => m.role === 'assistant')?.agent || 'assistant',
            date: dateStr,
            project: session.directory,
            projectHash: projectHashStr,
            messages: parsedMessages
          };
          const markdown = sessionToMarkdown(fullSession);
          writeFileSync(outputPath, markdown, 'utf-8');
        }
        
        if (!existsSync(outputPath)) {
          log('harvester', 'Write failed: ' + outputPath + ' (file not found after write)', 'warn');
          continue;
        }
        
        const harvestedSession: HarvestedSession = {
          sessionId: session.id,
          slug: session.slug,
          title: session.title,
          agent: messages.find(m => m.role === 'assistant')?.agent || 'assistant',
          date: dateStr,
          project: session.directory,
          projectHash: projectHashStr,
          messages: parsedMessages
        };
        
        processedCount++
        if (isIncremental) incrementalCount++
        log('harvester', `Processed session: ${session.id}${isIncremental ? ' (incremental)' : ''} [${processedCount}/${totalSessionFiles}]`)
        harvested.push(harvestedSession);
        state[sessionFile] = { mtime: effectiveMtime, messageCount: messages.length };
        stateChanged = true;

        if (options.extractionConfig?.enabled && options.store) {
          try {
            const llmConfig: ConsolidationConfig = {
              enabled: true,
              interval_ms: 0,
              model: options.extractionConfig.model,
              endpoint: options.extractionConfig.endpoint,
              apiKey: options.extractionConfig.apiKey,
              max_memories_per_cycle: 0,
              min_memories_threshold: 0,
              confidence_threshold: 0,
            };
            const provider = createLLMProvider(llmConfig);
            if (provider) {
              const health = options.store.getIndexHealth();
              const currentFactCount = health.extractedFacts ?? 0;
              if (currentFactCount >= MAX_EXTRACTED_FACTS) {
                if (!extractionStats.limitReached) {
                  log('harvester', `Storage limit reached: ${currentFactCount} extracted facts (max ${MAX_EXTRACTED_FACTS}). Skipping extraction.`);
                  extractionStats.limitReached = true;
                }
              } else {
                const sessionMarkdown = sessionToMarkdown(harvestedSession);
                const result = await extractFactsFromSession(sessionMarkdown, provider, options.extractionConfig);
                for (const fact of result.facts) {
                  const updatedHealth = options.store.getIndexHealth();
                  const updatedFactCount = updatedHealth.extractedFacts ?? 0;
                  if (updatedFactCount >= MAX_EXTRACTED_FACTS) {
                    if (!extractionStats.limitReached) {
                      log('harvester', `Storage limit reached during extraction: ${updatedFactCount} extracted facts (max ${MAX_EXTRACTED_FACTS}). Stopping.`);
                      extractionStats.limitReached = true;
                    }
                    break;
                  }
                  const wasStored = storeExtractedFact(options.store, fact, session.id, projectHashStr);
                  if (wasStored) {
                    extractionStats.factsExtracted++;
                  } else {
                    extractionStats.duplicatesSkipped++;
                  }
                }
                log('harvester', `Extracted ${result.facts.length} facts from session ${session.id} (${extractionStats.factsExtracted} stored, ${extractionStats.duplicatesSkipped} duplicates)`);
              }
            }
          } catch (err) {
            extractionStats.errors++;
            log('harvester', 'Extraction failed for session ' + session.id + ': ' + String(err));
          }
        }
      } catch (err) {
        errorCount++
        log('harvester', 'Write failed: ' + outputPath + ': ' + (err instanceof Error ? err.message : String(err)), 'warn');
        continue;
      }
    }
  }
  
  if (stateChanged) {
    saveHarvestState(stateFile, state);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const statsParts = [
    `${harvested.length} harvested`,
    incrementalCount > 0 ? `${incrementalCount} incremental` : null,
    `${skippedCount} skipped`,
    errorCount > 0 ? `${errorCount} errors` : null,
  ];
  if (extractionStats.factsExtracted > 0 || extractionStats.duplicatesSkipped > 0) {
    statsParts.push(`extracted ${extractionStats.factsExtracted} facts (${extractionStats.duplicatesSkipped} duplicates)`);
    if (extractionStats.errors > 0) {
      statsParts.push(`${extractionStats.errors} extraction errors`);
    }
  }
  statsParts.push(`${elapsed}s`);
  const stats = statsParts.filter(Boolean).join(', ')
  
  log('harvester', 'Harvest complete: ' + stats)
  if (harvested.length > 0) {
    log('harvester', 'Harvested ' + harvested.length + ' session(s) in ' + elapsed + 's');
  }
  
  return harvested;
}
