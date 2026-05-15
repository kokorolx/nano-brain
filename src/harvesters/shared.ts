// src/harvesters/shared.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { HarvestedSession } from '../types.js';

export type HarvestStateEntry = {
  mtime: number;
  retries?: number;
  skipped?: boolean;
  messageCount?: number;
};
export type HarvestState = Record<string, HarvestStateEntry>;

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
      lines.push(`## Assistant (${message.agent || 'assistant'})`);
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
      lines.push(`## Assistant (${message.agent || 'assistant'})`);
    }
    lines.push('');
    lines.push(message.text);
    lines.push('');
  }
  return lines.join('\n');
}

export function loadHarvestState(stateFile: string): HarvestState {
  try {
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, 'utf-8');
      return JSON.parse(content) as HarvestState;
    }
  } catch {
    // corrupt state file — start fresh
  }
  return {};
}

export function saveHarvestState(stateFile: string, state: HarvestState): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

/**
 * Returns output path for a session markdown file.
 * New structure: {outputDir}/{projectName}/{date}-{slug}.md
 * projectName = last segment of projectPath, sanitized, with hash suffix on collision.
 */
export function getOutputPath(
  outputDir: string,
  projectPath: string,
  date: string,
  slug: string,
  title?: string,
  knownNames?: Map<string, string>,
): string {
  const hash = createHash('sha256').update(projectPath).digest('hex');
  const projectHash = hash.substring(0, 12);

  // Derive project name from last path segment
  const rawName = projectPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'unknown';
  let sanitizedName = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);

  // Collision: if a different projectPath already claimed this name, append hash suffix
  if (knownNames) {
    const existingPath = knownNames.get(sanitizedName);
    if (existingPath && existingPath !== projectPath) {
      sanitizedName = `${sanitizedName}-${projectHash.substring(0, 6)}`;
    }
    knownNames.set(sanitizedName, projectPath);
  }

  const raw = (title && title.trim()) ? title : (slug || 'untitled');
  const sanitizedSlug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .substring(0, 60);

  const filename = `${date}-${sanitizedSlug}.md`;
  return join(outputDir, sanitizedName, filename);
}

/**
 * Writes a harvested session as markdown to the output directory.
 * Shared by all adapters to keep write logic in one place.
 */
export function writeSession(
  session: HarvestedSession,
  outputDir: string,
  projectNames?: Map<string, string>,
): string {
  const outputPath = getOutputPath(
    outputDir,
    session.project,
    session.date,
    session.slug,
    session.title,
    projectNames,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, sessionToMarkdown(session), 'utf-8');
  return outputPath;
}
