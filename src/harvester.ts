import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HarvestedSession } from './types.js';

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

export function loadHarvestState(stateFile: string): Record<string, number> {
  try {
    if (!existsSync(stateFile)) {
      return {};
    }
    
    const content = readFileSync(stateFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function saveHarvestState(stateFile: string, state: Record<string, number>): void {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

export async function harvestSessions(options: HarvesterOptions): Promise<HarvestedSession[]> {
  const { sessionDir, outputDir, stateFile: customStateFile } = options;
  const stateFile = customStateFile || join(outputDir, '.harvest-state.json');
  const state = loadHarvestState(stateFile);
  const harvested: HarvestedSession[] = [];
  
  const sessionRoot = join(sessionDir, 'session');
  
  if (!existsSync(sessionRoot)) {
    return [];
  }
  
  const projectDirs = readdirSync(sessionRoot);
  let stateChanged = false;
  
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
      
      // Check if already harvested AND output file still exists
      if (state[sessionFile] && state[sessionFile] >= lastMtime) {
        // Verify the output file actually exists — if not, re-harvest
        const session = parseSession(sessionPath);
        if (session) {
          const date = new Date(session.created);
          const dateStr = date.toISOString().split('T')[0];
          const outputPath = getOutputPath(outputDir, session.directory, dateStr, session.slug);
          if (existsSync(outputPath)) {
            continue;
          }
          // Output file missing — fall through to re-harvest
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
      
      // Skip sessions with no messages (nothing useful to index)
      if (messages.length === 0) {
        state[sessionFile] = lastMtime;
        stateChanged = true;
        continue;
      }
      
      const parsedMessages = messages.map(msg => ({
        role: msg.role,
        agent: msg.agent,
        text: parseParts(msg.id, sessionDir)
      }));
      
      // Skip sessions where all messages have empty text
      const hasContent = parsedMessages.some(m => m.text.trim().length > 0);
      if (!hasContent) {
        state[sessionFile] = lastMtime;
        stateChanged = true;
        continue;
      }
      
      const date = new Date(session.created);
      const dateStr = date.toISOString().split('T')[0];
      
      const hash = createHash('sha256').update(session.directory).digest('hex');
      const projectHashStr = hash.substring(0, 12);
      
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
      
      const outputPath = getOutputPath(outputDir, session.directory, dateStr, session.slug);
      const outputDirPath = dirname(outputPath);
      
      if (!existsSync(outputDirPath)) {
        mkdirSync(outputDirPath, { recursive: true });
      }
      
      const markdown = sessionToMarkdown(harvestedSession);
      
      try {
        writeFileSync(outputPath, markdown, 'utf-8');
        
        // Verify the file was actually written before updating state
        if (!existsSync(outputPath)) {
          console.warn(`[harvester] Write succeeded but file not found: ${outputPath}`);
          continue;
        }
        
        harvested.push(harvestedSession);
        state[sessionFile] = lastMtime;
        stateChanged = true;
      } catch (err) {
        console.warn(`[harvester] Failed to write ${outputPath}:`, err);
        // Do NOT update state — will retry on next cycle
        continue;
      }
    }
  }
  
  if (stateChanged) {
    saveHarvestState(stateFile, state);
  }
  
  if (harvested.length > 0) {
    console.log(`[harvester] Harvested ${harvested.length} session(s)`);
  }
  
  return harvested;
}
