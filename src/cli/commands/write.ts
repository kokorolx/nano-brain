import { createStore } from '../../store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log, cliOutput, cliError } from '../../logger.js';
import type { GlobalOptions } from '../types.js';
import { isInsideContainer } from '../../host.js';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_MEMORY_DIR,
  assertContainerServer,
  proxyPost,
} from '../utils.js';

export async function handleWrite(globalOpts: GlobalOptions, commandArgs: string[]): Promise<void> {
  const content = commandArgs[0]

  if (!content) {
    cliError('Usage: write "content here" [--supersedes=<path-or-docid>] [--tags=<comma-separated>]')
    process.exit(1)
  }

  log('cli', 'write command contentLength=' + content.length);
  let supersedes: string | undefined
  let tags: string[] | undefined

  for (let i = 1; i < commandArgs.length; i++) {
    const arg = commandArgs[i]
    if (arg.startsWith('--supersedes=')) {
      supersedes = arg.substring(13)
    } else if (arg.startsWith('--tags=')) {
      tags = arg.substring(7).split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0)
    }
  }

  const inContainer = isInsideContainer();
  const serverRunning = await assertContainerServer();

  if (serverRunning) {
    try {
      const result = await proxyPost(DEFAULT_HTTP_PORT, '/api/write', {
        content,
        tags: tags?.join(','),
        supersedes,
      });
      if (result.error) {
        cliError('Error:', result.error);
        process.exit(1);
      }
      cliOutput(`✅ ${result.message}`);
      return;
    } catch (err) {
      if (inContainer) {
        cliError('Error: Failed to communicate with daemon:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      log('cli', 'HTTP proxy failed, falling back to local: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const date = new Date().toISOString().split('T')[0]
  const memoryDir = DEFAULT_MEMORY_DIR
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true })
  }
  const targetPath = path.join(memoryDir, `${date}.md`)
  const timestamp = new Date().toISOString()
  const workspaceRoot = process.cwd()
  const workspaceName = path.basename(workspaceRoot)
  const projectHash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12)
  const entry = `\n## ${timestamp}\n\n**Workspace:** ${workspaceName} (${projectHash})\n\n${content}\n`

  fs.appendFileSync(targetPath, entry, 'utf-8')

  let supersedeWarning = ''
  let tagInfo = ''
  const store = await createStore(globalOpts.dbPath)

  const fileContent = fs.readFileSync(targetPath, 'utf-8')
  const title = path.basename(targetPath, path.extname(targetPath))
  const hash = crypto.createHash('sha256').update(fileContent).digest('hex')
  store.insertContent(hash, fileContent)
  const stats = fs.statSync(targetPath)
  const newDocId = store.insertDocument({
    collection: 'memory',
    path: targetPath,
    title,
    hash,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    active: true,
    projectHash,
  })

  if (supersedes) {
    const targetDoc = store.findDocument(supersedes)
    if (targetDoc) {
      store.supersedeDocument(targetDoc.id, newDocId)
    } else {
      supersedeWarning = `\n⚠️ Supersede target not found: ${supersedes}`
    }
  }

  if (tags && tags.length > 0) {
    store.insertTags(newDocId, tags)
    tagInfo = `\n📌 Tags: ${tags.join(', ')}`
  }

  store.close()

  cliOutput(`✅ Written to ${targetPath} [${workspaceName}]${supersedeWarning}${tagInfo}`)
}
