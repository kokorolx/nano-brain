import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SearchResult, IndexHealth } from '../types.js';
import type { VectorStoreHealth } from '../vector-store.js';
import type { ServerDeps, ResolvedWorkspace } from './types.js';
import { openWorkspaceStore } from '../store.js';
import type Database from 'better-sqlite3';
import type { Store } from '../types.js';

// Per-file write queue to prevent interleaved appends from concurrent clients
const fileWriteQueues = new Map<string, Promise<void>>();
export function sequentialFileAppend(filePath: string, data: string): void {
  const prev = fileWriteQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(() => {
    fs.appendFileSync(filePath, data, 'utf-8');
  }).catch(() => {
    // Ensure queue continues even if a write fails
  });
  fileWriteQueues.set(filePath, next);
}

export function resolveWorkspace(deps: ServerDeps, filePath?: string, workspaceParam?: string): ResolvedWorkspace | null {
  if (!deps.daemon || !deps.allWorkspaces || !deps.dataDir) {
    return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
  }

  if (workspaceParam && workspaceParam !== 'all') {
    for (const [wsPath, _wsConfig] of Object.entries(deps.allWorkspaces)) {
      const wsHash = crypto.createHash('sha256').update(wsPath).digest('hex').substring(0, 12);
      if (workspaceParam === wsHash || workspaceParam === wsPath) {
        if (wsHash === deps.currentProjectHash) {
          return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
        }
        const wsStore = openWorkspaceStore(deps.dataDir, wsPath);
        if (wsStore) {
          return { store: wsStore, workspaceRoot: wsPath, projectHash: wsHash, needsClose: false };
        }
      }
    }
  }

  if (filePath) {
    let bestMatch: { wsPath: string; length: number } | null = null;
    for (const wsPath of Object.keys(deps.allWorkspaces)) {
      if (filePath.startsWith(wsPath) && (!bestMatch || wsPath.length > bestMatch.length)) {
        bestMatch = { wsPath, length: wsPath.length };
      }
    }
    if (bestMatch) {
      const wsHash = crypto.createHash('sha256').update(bestMatch.wsPath).digest('hex').substring(0, 12);
      if (wsHash === deps.currentProjectHash) {
        return { store: deps.store, workspaceRoot: deps.workspaceRoot, projectHash: deps.currentProjectHash, needsClose: false };
      }
      const wsStore = openWorkspaceStore(deps.dataDir, bestMatch.wsPath);
      if (wsStore) {
        return { store: wsStore, workspaceRoot: bestMatch.wsPath, projectHash: wsHash, needsClose: false };
      }
    }
  }

  return null;
}

export function formatAvailableWorkspaces(deps: ServerDeps): string {
  const workspaces = Object.keys(deps.allWorkspaces || {})
  return workspaces.map(p => {
    const hash = crypto.createHash('sha256').update(p).digest('hex').substring(0, 12)
    return `  - ${path.basename(p)} (${hash}) — ${p}`
  }).join('\n')
}

export function requireDaemonWorkspace(
  deps: ServerDeps,
  workspace: string | undefined,
  filePath?: string
): { error: string } | { projectHash: string; workspaceRoot: string; db: Database.Database | undefined; store: Store; needsClose: boolean } {
  if (!deps.daemon) {
    return {
      projectHash: deps.currentProjectHash,
      workspaceRoot: deps.workspaceRoot,
      db: deps.db,
      store: deps.store,
      needsClose: false,
    }
  }

  if (!workspace && !filePath) {
    return { error: `workspace parameter is required in daemon mode.\n\nAvailable workspaces:\n${formatAvailableWorkspaces(deps)}` }
  }

  if (workspace === 'all') {
    return {
      projectHash: 'all',
      workspaceRoot: '',
      db: deps.db,
      store: deps.store,
      needsClose: false,
    }
  }

  const resolved = resolveWorkspace(deps, filePath, workspace)
  if (resolved) {
    return {
      projectHash: resolved.projectHash,
      workspaceRoot: resolved.workspaceRoot,
      db: resolved.store.getDb(),
      store: resolved.store,
      needsClose: resolved.needsClose,
    }
  }

  if (workspace) {
    return { error: `Workspace not found: ${workspace}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
  }

  return { error: `Could not resolve workspace from file_path: ${filePath}. Available workspaces:\n${formatAvailableWorkspaces(deps)}` }
}

export function attachTagsToResults(results: SearchResult[], store: Store): SearchResult[] {
  return results.map(r => {
    const docId = typeof r.id === 'string' ? parseInt(r.id, 10) : r.id;
    if (isNaN(docId)) return r;
    const tags = store.getDocumentTags(docId);
    return tags.length > 0 ? { ...r, tags } : r;
  });
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  return results.map((r, i) => {
    let output = `### ${i + 1}. ${r.title} (${r.docid})\n` +
      `**Path:** ${r.path} | **Score:** ${r.score.toFixed(3)} | **Lines:** ${r.startLine}-${r.endLine}\n`;

    if (r.tags && r.tags.length > 0) {
      output += `**Tags:** ${r.tags.join(', ')}\n`;
    }
    if (r.symbols && r.symbols.length > 0) {
      output += `**Symbols:** ${r.symbols.join(', ')}\n`;
    }
    if (r.clusterLabel) {
      output += `**Cluster:** ${r.clusterLabel}\n`;
    }
    if (r.flowCount !== undefined && r.flowCount > 0) {
      output += `**Flows:** ${r.flowCount}\n`;
    }

    output += `\n${r.snippet}\n`;
    return output;
  }).join('\n---\n\n');
}

function abbreviateTag(tag: string): string {
  const parts = tag.split(':');
  if (parts.length === 2) {
    const prefix = parts[0];
    const name = parts[1];
    const shortName = name.split('-')[0];
    return `${prefix}:${shortName}`;
  }
  return tag.split('-')[0];
}

function formatTagsCompact(tags: string[]): string {
  if (tags.length === 0) return '';
  if (tags.length <= 3) {
    return ` [${tags.map(abbreviateTag).join(', ')}]`;
  }
  const first2 = tags.slice(0, 2).map(abbreviateTag);
  return ` [${first2.join(', ')} +${tags.length - 2}]`;
}

export function formatCompactResults(results: SearchResult[], cacheKey: string): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const header = `🔑 ${cacheKey} | Use memory_expand(cacheKey, index) for full content | compact:false for verbose`;

  const lines = results.map((r, i) => {
    const score = r.score.toFixed(3);
    const title = r.title.replace(/[|—]/g, '-');
    const symbols = r.symbols && r.symbols.length > 0 ? ` [${r.symbols.join(', ')}]` : '';
    const tags = r.tags && r.tags.length > 0 ? formatTagsCompact(r.tags) : '';
    const firstLine = r.snippet.split('\n')[0] || '';
    const truncated = firstLine.length > 80 ? firstLine.substring(0, 80) + '…' : firstLine;
    return `${i + 1}. [${score}] ${title} (${r.docid}) — ${r.path}:${r.startLine}${symbols}${tags} | ${truncated}`;
  });

  return header + '\n\n' + lines.join('\n');
}

export function formatStatus(
  health: IndexHealth,
  codebaseStats?: { enabled: boolean; documents: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number },
  embeddingHealth?: { provider: string; url: string; model: string; reachable: boolean; models?: string[]; error?: string },
  vectorHealth?: VectorStoreHealth | null,
  tokenUsage?: Array<{ model: string; totalTokens: number; requestCount: number; lastUpdated: string }> | null
): string {
  const lines = [
    `📊 **Memory Index Status**`,
    `Documents: ${health.documentCount} | Embedded: ${health.embeddedCount} | Pending embeddings: ${health.pendingEmbeddings}`,
    `Database size: ${(health.databaseSize / 1024 / 1024).toFixed(1)} MB`,
    ``,
    `**Collections:**`,
    ...health.collections.map(c => `  - ${c.name}: ${c.documentCount} docs (${c.path})`),
    ``,
    `**Models:**`,
    `  - Embedding: ${health.modelStatus.embedding}`,
    `  - Reranker: ${health.modelStatus.reranker}`,
    `  - Expander: ${health.modelStatus.expander}`,
  ]
  if (embeddingHealth) {
    lines.push(``)
    lines.push(`**Embedding Server:**`)
    lines.push(`  - Provider: ${embeddingHealth.provider}`)
    lines.push(`  - URL: ${embeddingHealth.url}`)
    lines.push(`  - Model: ${embeddingHealth.model}`)
    if (embeddingHealth.reachable) {
      const hasModel = embeddingHealth.models?.some(m => m.startsWith(embeddingHealth.model))
      lines.push(`  - Status: ✅ connected`)
      lines.push(`  - Model available: ${hasModel ? '✅ yes' : '❌ not found — run: ollama pull ' + embeddingHealth.model}`)
    } else {
      lines.push(`  - Status: ❌ unreachable (${embeddingHealth.error})`)
    }
  }
  if (codebaseStats) {
    const usedMB = (codebaseStats.storageUsed / 1024 / 1024).toFixed(1)
    const maxMB = (codebaseStats.maxSize / 1024 / 1024).toFixed(0)
    lines.push(``)
    lines.push(`**Codebase:**`)
    lines.push(`  - Enabled: ${codebaseStats.enabled}`)
    lines.push(`  - Documents: ${codebaseStats.documents}`)
    lines.push(`  - Storage: ${usedMB}MB / ${maxMB}MB`)
    lines.push(`  - Extensions: ${codebaseStats.extensions.join(', ')}`)
    lines.push(`  - Exclude patterns: ${codebaseStats.excludeCount}`)
  }
  if (vectorHealth) {
    lines.push(``)
    lines.push(`**Vector Store:**`)
    lines.push(`  - Provider: ${vectorHealth.provider}`)
    if (vectorHealth.ok) {
      lines.push(`  - Status: ✅ connected (${vectorHealth.vectorCount.toLocaleString()} vectors${vectorHealth.dimensions ? `, ${vectorHealth.dimensions} dims` : ''})`)
    } else {
      lines.push(`  - Status: ❌ unreachable (${vectorHealth.error || 'unknown'})`)
    }
  } else if (vectorHealth === null) {
    lines.push(``)
    lines.push(`**Vector Store:**`)
    lines.push(`  - Provider: sqlite-vec (built-in)`)
  }
  if (tokenUsage && tokenUsage.length > 0) {
    lines.push(``)
    lines.push(`**Token Usage:**`)
    for (const usage of tokenUsage) {
      lines.push(`  - ${usage.model}: ${usage.totalTokens.toLocaleString()} tokens (${usage.requestCount.toLocaleString()} requests)`)
    }
  }
  if (health.workspaceStats && health.workspaceStats.length > 0) {
    lines.push(``)
    lines.push(`**Workspaces:**`)
    for (const ws of health.workspaceStats) {
      lines.push(`  - ${ws.projectHash}: ${ws.count} docs`)
    }
  }
  if (health.extractedFacts !== undefined && health.extractedFacts > 0) {
    lines.push(``)
    lines.push(`**Extracted Facts:**`)
    lines.push(`  - Count: ${health.extractedFacts}`)
  }
  return lines.join('\n')
}
