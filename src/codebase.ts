import type { Store, CodebaseConfig, CodebaseIndexResult } from './types.js'
import { computeHash } from './store.js'
import { chunkSourceCode, chunkMarkdown } from './chunker.js'
import { parseSize } from './storage.js'
import * as fs from 'fs'
import * as path from 'path'
import fg from 'fast-glob'

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024
const DEFAULT_CODEBASE_MAX_SIZE = 2 * 1024 * 1024 * 1024

const BUILTIN_EXCLUDE_PATTERNS = [
  // Version control
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',

  // JS/TS — dependencies
  '**/node_modules/**',
  '**/.pnpm-store/**',
  '**/.yarn/**',
  '**/bower_components/**',

  // JS/TS — build outputs
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/output/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.astro/**',
  '**/.remix/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.output/**',
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.vite/**',
  '**/storybook-static/**',

  // JS/TS — generated files
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/*.tsbuildinfo',
  '**/.eslintcache',

  // Python
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/env/**',
  '**/.env/**',
  '**/.conda/**',
  '**/*.egg-info/**',
  '**/.mypy_cache/**',
  '**/.ruff_cache/**',
  '**/.pytest_cache/**',
  '**/htmlcov/**',
  '**/.tox/**',

  // Go
  '**/vendor/**',

  // Rust
  '**/target/**',

  // Java/Kotlin/JVM
  '**/.gradle/**',
  '**/.mvn/**',
  '**/gradle/wrapper/**',
  '**/*.class',
  '**/*.jar',
  '**/*.war',

  // Ruby
  '**/gems/**',
  '**/.bundle/**',

  // PHP
  '**/storage/framework/**',
  '**/bootstrap/cache/**',

  // Mobile — iOS
  '**/Pods/**',
  '**/*.xcworkspace/**',
  '**/DerivedData/**',

  // Mobile — Android
  '**/.gradle/**',
  '**/generated/**',

  // DevOps / infra
  '**/.terraform/**',
  '**/.terraform.lock.hcl',
  '**/terraform.tfstate*',

  // Editors & IDEs
  '**/.idea/**',
  '**/.vscode/extensions/**',

  // Logs & tmp
  '**/logs/**',
  '**/log/**',
  '**/tmp/**',
  '**/temp/**',
  '**/*.log',

  // Test coverage
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/lcov-report/**',

  // Misc large binary/generated
  '**/*.sum',
  '**/*.snap',
  '**/docker-data/**',
]

const PROJECT_TYPE_MARKERS: Record<string, string[]> = {
  'package.json': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  'pyproject.toml': ['.py', '.pyi'],
  'setup.py': ['.py', '.pyi'],
  'requirements.txt': ['.py', '.pyi'],
  'go.mod': ['.go'],
  'Cargo.toml': ['.rs'],
  'pom.xml': ['.java', '.kt', '.kts'],
  'build.gradle': ['.java', '.kt', '.kts'],
  'build.gradle.kts': ['.java', '.kt', '.kts'],
  'Gemfile': ['.rb', '.erb'],
}

export function detectProjectType(workspaceRoot: string): string[] {
  const extensions = new Set<string>()
  
  for (const [marker, exts] of Object.entries(PROJECT_TYPE_MARKERS)) {
    const markerPath = path.join(workspaceRoot, marker)
    if (fs.existsSync(markerPath)) {
      for (const ext of exts) {
        extensions.add(ext)
      }
    }
  }
  
  extensions.add('.md')
  
  if (extensions.size === 1) {
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.md']
  }
  
  return Array.from(extensions)
}

export function loadGitignorePatterns(workspaceRoot: string): string[] {
  const gitignorePath = path.join(workspaceRoot, '.gitignore')
  
  if (!fs.existsSync(gitignorePath)) {
    return []
  }
  
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8')
    const patterns: string[] = []
    
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        patterns.push(trimmed)
      }
    }
    
    return patterns
  } catch {
    return []
  }
}

export function mergeExcludePatterns(config: CodebaseConfig, workspaceRoot: string): string[] {
  const patterns = new Set<string>(BUILTIN_EXCLUDE_PATTERNS)
  
  const gitignorePatterns = loadGitignorePatterns(workspaceRoot)
  for (const pattern of gitignorePatterns) {
    patterns.add(pattern)
  }
  
  if (config.exclude) {
    for (const pattern of config.exclude) {
      patterns.add(pattern)
    }
  }
  
  return Array.from(patterns)
}

export function resolveExtensions(config: CodebaseConfig, workspaceRoot: string): string[] {
  if (config.extensions && config.extensions.length > 0) {
    return config.extensions
  }
  
  return detectProjectType(workspaceRoot)
}

export async function scanCodebaseFiles(
  workspaceRoot: string,
  config: CodebaseConfig
): Promise<{ files: string[]; skippedTooLarge: number }> {
  const extensions = resolveExtensions(config, workspaceRoot)
  const excludePatterns = mergeExcludePatterns(config, workspaceRoot)
  
  const maxFileSize = config.maxFileSize
    ? parseSize(config.maxFileSize)
    : DEFAULT_MAX_FILE_SIZE
  
  const effectiveMaxSize = maxFileSize > 0 ? maxFileSize : DEFAULT_MAX_FILE_SIZE
  
  const patterns = extensions.map(ext => `**/*${ext}`)
  
  const allFiles = await fg(patterns, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    ignore: excludePatterns,
  })
  
  const files: string[] = []
  let skippedTooLarge = 0
  
  for (const filePath of allFiles) {
    try {
      const stats = fs.statSync(filePath)
      if (stats.size <= effectiveMaxSize) {
        files.push(filePath)
      } else {
        skippedTooLarge++
      }
    } catch {
      continue
    }
  }
  
  return { files, skippedTooLarge }
}

export async function indexCodebase(
  store: Store,
  workspaceRoot: string,
  config: CodebaseConfig,
  projectHash: string,
  _embedder?: { embed(text: string): Promise<{ embedding: number[] }> } | null
): Promise<CodebaseIndexResult> {
  const { files, skippedTooLarge } = await scanCodebaseFiles(workspaceRoot, config)
  const maxSizeBytes = config.maxSize
    ? parseSize(config.maxSize)
    : DEFAULT_CODEBASE_MAX_SIZE
  const effectiveMaxSize = maxSizeBytes > 0 ? maxSizeBytes : DEFAULT_CODEBASE_MAX_SIZE
  const batchSize = config.batchSize ?? 50
  let currentStorageUsed = store.getCollectionStorageSize('codebase')
  let filesIndexed = 0
  let filesSkippedUnchanged = 0
  let filesSkippedBudget = 0
  let chunksCreated = 0
  const activePaths: string[] = []
  let batchNum = 0
  
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const contentSize = Buffer.byteLength(content, 'utf-8')
      const hash = computeHash(content)
      const existingDoc = store.findDocument(filePath)
      if (existingDoc && existingDoc.hash === hash) {
        filesSkippedUnchanged++
        activePaths.push(filePath)
        continue
      }
      const existingSize = existingDoc ? Buffer.byteLength(store.getDocumentBody(existingDoc.hash) ?? '', 'utf-8') : 0
      const netIncrease = contentSize - existingSize
      if (currentStorageUsed + netIncrease > effectiveMaxSize) {
        filesSkippedBudget++
        if (existingDoc) {
          activePaths.push(filePath)
        }
        continue
      }
      store.insertContent(hash, content)
      const chunks = chunkSourceCode(content, hash, filePath, workspaceRoot)
      chunksCreated += chunks.length
      const title = path.basename(filePath)
      const now = new Date().toISOString()
      store.insertDocument({
        collection: 'codebase',
        path: filePath,
        title,
        hash,
        createdAt: existingDoc?.createdAt ?? now,
        modifiedAt: now,
        active: true,
        projectHash,
      })
      currentStorageUsed += netIncrease
      filesIndexed++
      activePaths.push(filePath)
    } catch {
      continue
    }
    
    if ((i + 1) % batchSize === 0) {
      batchNum++
      console.error(`[codebase] Batch ${batchNum}: indexed ${i + 1}/${files.length} files`)
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  
  store.bulkDeactivateExcept('codebase', activePaths)
  const finalStorageUsed = store.getCollectionStorageSize('codebase')
  return {
    filesScanned: files.length,
    filesIndexed,
    filesSkippedUnchanged,
    filesSkippedTooLarge: skippedTooLarge,
    filesSkippedBudget,
    chunksCreated,
    storageUsedBytes: finalStorageUsed,
    maxSizeBytes: effectiveMaxSize,
  }
}

export async function embedPendingCodebase(
  store: Store,
  embedder: { embed(text: string): Promise<{ embedding: number[]; model?: string }>; embedBatch?(texts: string[]): Promise<Array<{ embedding: number[] }>>; getModel?(): string; getMaxChars?(): number },
  batchSize: number = 50,
  projectHash?: string
): Promise<number> {
  const maxChars = embedder.getMaxChars?.() ?? 6000
  let embedded = 0
  const failedHashes = new Set<string>()
  while (true) {
    const batch: Array<{ hash: string; body: string; path: string }> = []
    for (let i = 0; i < batchSize; i++) {
      const row = store.getNextHashNeedingEmbedding(projectHash)
      if (!row) break
      if (failedHashes.has(row.hash)) break // all remaining docs already failed
      batch.push(row)
    }
    if (batch.length === 0) break

    const allChunks: Array<{ hash: string; seq: number; pos: number; text: string }> = []
    for (const row of batch) {
      const chunks = chunkMarkdown(row.body, row.hash)
      for (const chunk of chunks) {
        allChunks.push({
          hash: row.hash,
          seq: chunk.seq,
          pos: chunk.pos,
          text: chunk.text.length > maxChars ? chunk.text.substring(0, maxChars) : chunk.text,
        })
      }
    }

    const texts = allChunks.map(c => c.text)
    const modelName = embedder.getModel?.() || 'unknown'

    console.error(`[embed] Batch ${batch.length} docs, ${allChunks.length} chunks`)
    try {
      if (embedder.embedBatch && texts.length > 1) {
        const results = await embedder.embedBatch(texts)
        for (let i = 0; i < allChunks.length; i++) {
          store.insertEmbedding(allChunks[i].hash, allChunks[i].seq, allChunks[i].pos, results[i].embedding, modelName)
        }
      } else {
        for (let i = 0; i < allChunks.length; i++) {
          const result = await embedder.embed(texts[i])
          store.insertEmbedding(allChunks[i].hash, allChunks[i].seq, allChunks[i].pos, result.embedding, result.model || modelName)
        }
      }
      embedded += batch.length
    } catch (err) {
      console.warn('[embed] Batch failed, falling back to sequential:', err)
      const succeededHashes = new Set<string>()
      for (let i = 0; i < allChunks.length; i++) {
        try {
          const result = await embedder.embed(texts[i])
          store.insertEmbedding(allChunks[i].hash, allChunks[i].seq, allChunks[i].pos, result.embedding, result.model || modelName)
          succeededHashes.add(allChunks[i].hash)
        } catch {
          console.warn(`[embed] Skipping chunk ${allChunks[i].hash}:${allChunks[i].seq}`)
          continue
        }
      }
      // Track hashes where ALL chunks failed to prevent infinite retry
      for (const row of batch) {
        if (!succeededHashes.has(row.hash)) {
          failedHashes.add(row.hash)
          console.warn(`[embed] All chunks failed for ${row.path} (${row.hash.substring(0, 8)}…) — skipping, FTS still covers it`)
        }
      }
      embedded += batch.length
    }

    if (embedded > 0 && embedded % 50 === 0) {
      console.log(`[embed] Embedded ${embedded} document(s)...`)
    }

    await new Promise(resolve => setImmediate(resolve))
  }
  return embedded
}

export function getCodebaseStats(
  store: Store,
  config: CodebaseConfig | undefined,
  workspaceRoot: string
): { enabled: boolean; documents: number; chunks: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number } | undefined {
  if (!config?.enabled) {
    return undefined
  }
  const health = store.getIndexHealth()
  const codebaseCollection = health.collections.find(c => c.name === 'codebase')
  const extensions = resolveExtensions(config, workspaceRoot)
  const excludePatterns = mergeExcludePatterns(config, workspaceRoot)
  const storageUsed = store.getCollectionStorageSize('codebase')
  const maxSize = config.maxSize
    ? parseSize(config.maxSize)
    : DEFAULT_CODEBASE_MAX_SIZE
  const effectiveMaxSize = maxSize > 0 ? maxSize : DEFAULT_CODEBASE_MAX_SIZE
  return {
    enabled: true,
    documents: codebaseCollection?.documentCount ?? 0,
    chunks: 0,
    extensions,
    excludeCount: excludePatterns.length,
    storageUsed,
    maxSize: effectiveMaxSize,
  }
}
