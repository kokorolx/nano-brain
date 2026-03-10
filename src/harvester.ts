import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HarvestedSession } from './types.js';
import { log } from './logger.js';

export interface HarvesterOptions {
  sessionDir: string;
  outputDir: string;
  stateFile?: string;
}

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

export function parseMessages(sessionId: string, storageDir: string): ParsedMessage[] {
  const messageDir = join(storageDir, 'message', sessionId);
  
  if (!existsSync(messageDir)) {
    return [];
  }
  
  const messages: ParsedMessage[] = [];
  
  try {
    const files = readdirSync(messageDir).filter(f => f.startsWith('msg_') && f.endsWith('.json'));
    
    for (const file of files) {
      const filePath = join(messageDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      messages.push({
        id: data.id,
        role: data.role,
        agent: data.agent,
        created: data.time?.created || 0
      });
    }
  } catch {
    return [];
  }
  
  messages.sort((a, b) => a.created - b.created);
  
  return messages;
}

export function parseParts(messageId: string, storageDir: string): string {
  const partDir = join(storageDir, 'part', messageId);
  
  if (!existsSync(partDir)) {
    return '';
  }
  
  const textParts: string[] = [];
  
  try {
    const files = readdirSync(partDir).filter(f => f.startsWith('prt_') && f.endsWith('.json'));
    
    for (const file of files) {
      const filePath = join(partDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      if (data.type === 'text' && !data.synthetic && data.text) {
        textParts.push(data.text);
      }
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

export async function harvestSessions(options: HarvesterOptions): Promise<HarvestedSession[]> {
  const { sessionDir, outputDir, stateFile: customStateFile } = options;
  const stateFile = customStateFile || join(outputDir, '.harvest-state.json');
  const state = loadHarvestState(stateFile);
  const harvested: HarvestedSession[] = [];
  
  const startTime = Date.now()
  const sessionRoot = join(sessionDir, 'session');
  
  if (!existsSync(sessionRoot)) {
    log('harvester', 'Harvest cycle: no session root found')
    return [];
  }
  
  const projectDirs = readdirSync(sessionRoot);
  
  // Pre-scan: count total session files and size across all projects
  let totalSessionFiles = 0
  let totalSessionBytes = 0
  for (const projectHash of projectDirs) {
    const projectSessionDir = join(sessionRoot, projectHash);
    if (!existsSync(projectSessionDir)) continue
    try {
      const files = readdirSync(projectSessionDir).filter(f => f.startsWith('ses_') && f.endsWith('.json'))
      for (const file of files) {
        totalSessionFiles++
        try {
          totalSessionBytes += statSync(join(projectSessionDir, file)).size
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  
  const sizeKB = (totalSessionBytes / 1024).toFixed(1)
  log('harvester', `Starting harvest cycle: ${totalSessionFiles} session files (${sizeKB} KB) across ${projectDirs.length} projects`)
  
  let stateChanged = false;
  let processedCount = 0
  let skippedCount = 0
  let incrementalCount = 0
  let errorCount = 0
  
  for (const projectHash of projectDirs) {
    const projectSessionDir = join(sessionRoot, projectHash);
    
    if (!existsSync(projectSessionDir)) {
      continue;
    }
    
    const sessionFiles = readdirSync(projectSessionDir).filter(f => f.startsWith('ses_') && f.endsWith('.json'));
    
    for (const sessionFile of sessionFiles) {
      const sessionPath = join(projectSessionDir, sessionFile);
      
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
          console.log(`[harvester] Re-harvesting ${sessionFile}: output file missing`);
        } else {
          continue;
        }
      }
      
      const session = parseSession(sessionPath);
      
      if (!session) {
        continue;
      }
      
      const messages = parseMessages(session.id, sessionDir);
      
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
      
      const parsedMessages = messagesToProcess.map(msg => ({
        role: msg.role,
        agent: msg.agent,
        text: parseParts(msg.id, sessionDir)
      }));
      
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
          log('harvester', 'Write failed: ' + outputPath + ' (file not found after write)')
          console.warn(`[harvester] Write succeeded but file not found: ${outputPath}`);
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
      } catch (err) {
        errorCount++
        log('harvester', 'Write failed: ' + outputPath)
        console.warn(`[harvester] Failed to write ${outputPath}:`, err);
        continue;
      }
    }
  }
  
  if (stateChanged) {
    saveHarvestState(stateFile, state);
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const stats = [
    `${harvested.length} harvested`,
    incrementalCount > 0 ? `${incrementalCount} incremental` : null,
    `${skippedCount} skipped`,
    errorCount > 0 ? `${errorCount} errors` : null,
    `${elapsed}s`,
  ].filter(Boolean).join(', ')
  
  log('harvester', `Harvest complete: ${stats}`)
  if (harvested.length > 0) {
    console.log(`[harvester] Harvested ${harvested.length} session(s) in ${elapsed}s`);
  }
  
  return harvested;
}
