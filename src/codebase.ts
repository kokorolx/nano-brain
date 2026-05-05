import type { Store, CodebaseConfig, CodebaseIndexResult } from './types.js'
import type { VectorStore } from './vector-store.js'
import type BetterSqlite3 from 'better-sqlite3'
import { computeHash } from './store.js'
import { chunkSourceCode, chunkMarkdown, chunkWithTreeSitter } from './chunker.js'
import type { MemoryChunk } from './types.js'
import { parseSize } from './storage.js'
import { parseImports, detectLanguage, computePageRank, louvainClustering, computeEdgeSetHash, clusterSymbols, type SupportedLanguage } from './graph.js'
import { extractSymbols } from './symbols.js'
import { log } from './logger.js'
import { SymbolGraph } from './symbol-graph.js'
import {
  isTreeSitterAvailable,
  waitForInit,
  parseSymbols,
  resolveCallEdges,
  resolveHeritageEdges,
  type SymbolTable,
  type CodeSymbol,
  type SymbolEdge,
} from './treesitter.js'
import { detectAndStoreFlows } from './flow-detection.js'
import pLimit from 'p-limit'
import * as fs from 'fs'
import * as path from 'path'
import fg from 'fast-glob'

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

const DEFAULT_MAX_FILE_SIZE = 300 * 1024
const DEFAULT_CODEBASE_MAX_SIZE = 2 * 1024 * 1024 * 1024
const EMBEDDING_CONCURRENCY = parseInt(process.env.NANO_BRAIN_EMBEDDING_CONCURRENCY || '3', 10)
const MAX_PENDING_BATCHES = 10

export const BUILTIN_EXCLUDE_PATTERNS = [
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

  // Lock files (zero search value, massive token waste)
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Pipfile.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/go.sum',

  // Bundled/minified assets (already built, not source)
  '**/public/vs/**',
  '**/assets/index-*.js',
  '**/*.bundle.js',
  '**/*.chunk.js',

  // i18n/locale data (large, repetitive, low search value)
  '**/nls.messages.*.js',
  '**/locales/*.json',
]

const PROJECT_TYPE_MARKERS: Record<string, string[]> = {
  'package.json': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue'],
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
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.go', '.rs', '.java', '.rb', '.md']
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
  log('codebase', 'Scanning with extensions: ' + extensions.join(', '))
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
  log('codebase', 'Found ' + allFiles.length + ' files matching patterns')

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

  if (skippedTooLarge > 0) {
    log('codebase', 'Skipped ' + skippedTooLarge + ' files (too large)')
  }
  return { files, skippedTooLarge }
}

export async function indexCodebase(
  store: Store,
  workspaceRoot: string,
  config: CodebaseConfig,
  projectHash: string,
  _embedder?: { embed(text: string): Promise<{ embedding: number[] }> } | null,
  db?: BetterSqlite3.Database
): Promise<CodebaseIndexResult> {
  log('codebase', 'Starting codebase scan: ' + workspaceRoot)
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
  const scannedFiles: Array<{ path: string; content: string }> = []
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
        scannedFiles.push({ path: filePath, content })
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
      if (existingDoc) {
        store.cleanupVectorsForHash(existingDoc.hash)
      }
      store.insertContent(hash, content)
      const chunkLang = detectLanguage(filePath) as SupportedLanguage | null
      let chunks: MemoryChunk[]
      if (chunkLang && (chunkLang === 'ts' || chunkLang === 'js' || chunkLang === 'python')) {
        const astChunks = await chunkWithTreeSitter(content, hash, filePath, workspaceRoot, chunkLang)
        chunks = astChunks ?? chunkSourceCode(content, hash, filePath, workspaceRoot)
      } else {
        chunks = chunkSourceCode(content, hash, filePath, workspaceRoot)
      }
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

      const language = detectLanguage(filePath)
      if (language) {
        store.deleteFileEdges(filePath, projectHash)
        const importTargets = parseImports(filePath, content, language, workspaceRoot)
        for (const target of importTargets) {
          store.insertFileEdge(filePath, target, projectHash)
        }

        store.deleteSymbols(filePath, projectHash)
        const repoName = path.basename(workspaceRoot)
        const symbols = extractSymbols(filePath, content, language)
        for (const symbol of symbols) {
          store.insertSymbol({
            type: symbol.type,
            pattern: symbol.pattern,
            operation: symbol.operation,
            repo: repoName,
            filePath: symbol.filePath,
            lineNumber: symbol.lineNumber,
            rawExpression: symbol.rawExpression,
            projectHash,
          })
        }
      }

      currentStorageUsed += netIncrease
      filesIndexed++
      activePaths.push(filePath)
      scannedFiles.push({ path: filePath, content })
    } catch {
      continue
    }

    if ((i + 1) % 10 === 0) await yieldToEventLoop();

    if ((i + 1) % batchSize === 0) {
      batchNum++
      log('codebase', 'Batch ' + batchNum + ': indexed ' + (i + 1) + '/' + files.length + ' files')
    }
  }

  store.bulkDeactivateExcept('codebase', activePaths)

  const fileEdges = store.getFileEdges(projectHash)
  const edges = fileEdges.map(e => ({ source: e.source_path, target: e.target_path }))
  const newEdgeHash = computeEdgeSetHash(edges)
  const oldEdgeHash = store.getEdgeSetHash(projectHash)

  if (newEdgeHash !== oldEdgeHash) {
    log('codebase', 'Computing PageRank for ' + edges.length + ' edges')
    const pageRankScores = computePageRank(edges)
    store.updateCentralityScores(projectHash, pageRankScores)

    const clusters = louvainClustering(edges)
    if (clusters.size > 0) {
      log('codebase', 'Louvain clustering: ' + clusters.size + ' clusters')
      store.updateClusterIds(projectHash, clusters)
    }

    store.setEdgeSetHash(projectHash, newEdgeHash)
  }

  if (db && isTreeSitterAvailable()) {
    log('codebase', 'Running symbol graph indexing')
    const symbolResult = await indexSymbolGraph(db, workspaceRoot, projectHash, scannedFiles)
    log('codebase', `Symbol graph: ${symbolResult.symbolsIndexed} symbols, ${symbolResult.edgesCreated} edges`)

    if (symbolResult.edgesCreated > 0) {
      const clusterResult = clusterSymbols(db, projectHash)
      if (clusterResult.clusterCount > 0) {
        log('codebase', `Symbol clustering: ${clusterResult.clusterCount} clusters, ${clusterResult.symbolsAssigned} symbols assigned`)
      }
    }

    const flowResult = detectAndStoreFlows(db, projectHash)
    if (flowResult.flowsDetected > 0) {
      log('codebase', `Flow detection: ${flowResult.flowsDetected} flows from ${flowResult.entryPointsFound} entry points`)
    }
  } else if (!db && isTreeSitterAvailable()) {
    log('codebase', 'WARNING: db parameter not provided — symbol graph indexing skipped. Pass db to indexCodebase() to enable code intelligence.')
  } else if (db && !isTreeSitterAvailable()) {
    log('codebase', 'WARNING: tree-sitter not available — symbol graph indexing skipped. Install tree-sitter-wasms to enable code intelligence.')
  }

  const finalStorageUsed = store.getCollectionStorageSize('codebase')
  log('codebase', 'Index complete: ' + filesIndexed + ' indexed, ' + filesSkippedUnchanged + ' unchanged, ' + chunksCreated + ' chunks')
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

async function processSingleBatch(
  batch: Array<{ hash: string; body: string; path: string }>,
  store: Store,
  embedder: { embed(text: string): Promise<{ embedding: number[]; model?: string }>; embedBatch?(texts: string[]): Promise<Array<{ embedding: number[] }>>; getModel?(): string; getMaxChars?(): number },
  vectorStore: VectorStore | null,
  maxChars: number,
  failedHashes: Set<string>
): Promise<{ embedded: number; emptyBodyHashes: string[] }> {
  const maxChunksPerBatch = 200
  const allChunks: Array<{ hash: string; seq: number; pos: number; text: string; path: string }> = []
  const emptyBodyHashes: string[] = []

  for (const row of batch) {
    const chunks = chunkMarkdown(row.body, row.hash)
    if (chunks.length === 0) {
      emptyBodyHashes.push(row.hash)
      continue
    }
    for (const chunk of chunks) {
      allChunks.push({
        hash: row.hash,
        seq: chunk.seq,
        pos: chunk.pos,
        text: chunk.text.length > maxChars ? chunk.text.substring(0, maxChars) : chunk.text,
        path: row.path,
      })
    }
    if (allChunks.length >= maxChunksPerBatch) break
  }

  await store.insertEmbeddingLocalBatch(emptyBodyHashes.map(hash => ({ hash, seq: -1, pos: 0, model: 'skipped:empty-body' })));
  for (const hash of emptyBodyHashes) {
    failedHashes.add(hash)
  }

  if (allChunks.length === 0) {
    if (emptyBodyHashes.length > 0) {
      log('codebase', 'Skipping ' + emptyBodyHashes.length + ' docs with empty body — FTS still covers them', 'warn')
    }
    return { embedded: 0, emptyBodyHashes }
  }

  const texts = allChunks.map(c => c.text)
  const modelName = embedder.getModel?.() || 'unknown'

  const batchPaths = batch.map(r => r.path.replace(/.*\//, '')).join(', ')
  log('codebase', 'Embedding batch: ' + batch.length + ' docs, ' + allChunks.length + ' chunks: ' + batchPaths)

  try {
    let embeddings: number[][]
    if (embedder.embedBatch && texts.length > 1) {
      const results = await embedder.embedBatch(texts)
      embeddings = results.map(r => r.embedding)
    } else {
      embeddings = []
      for (let i = 0; i < texts.length; i++) {
        const result = await embedder.embed(texts[i])
        embeddings.push(result.embedding)
        if (i % 5 === 0) await yieldToEventLoop();
      }
    }

    if (vectorStore) {
      const points = allChunks.map((chunk, i) => ({
        id: `${chunk.hash}:${chunk.seq}`,
        embedding: embeddings[i],
        metadata: { hash: chunk.hash, seq: chunk.seq, pos: chunk.pos, model: modelName },
      }))
      try {
        await vectorStore.batchUpsert(points)
      } catch (err) {
        log('codebase', 'Batch vector store upsert failed, falling back to individual: ' + (err instanceof Error ? err.message : String(err)), 'warn')
        for (const point of points) {
          try {
            await vectorStore.upsert(point)
          } catch {
            // Individual failure is logged by the vector store provider
          }
        }
      }
    }

    await store.insertEmbeddingLocalBatch(allChunks.map(c => ({ hash: c.hash, seq: c.seq, pos: c.pos, model: modelName })));

    return { embedded: batch.length, emptyBodyHashes }
  } catch (err) {
    log('codebase', 'Batch embedding failed, falling back to sequential: ' + (err instanceof Error ? err.message : String(err)), 'warn')
    const succeededHashes = new Set<string>()
    const succeededChunks: Array<{ hash: string; seq: number; pos: number; model: string }> = []

    for (let i = 0; i < allChunks.length; i++) {
      try {
        const result = await embedder.embed(texts[i])
        const embedding = result.embedding

        if (vectorStore) {
          try {
            await vectorStore.upsert({
              id: `${allChunks[i].hash}:${allChunks[i].seq}`,
              embedding,
              metadata: { hash: allChunks[i].hash, seq: allChunks[i].seq, pos: allChunks[i].pos, model: result.model || modelName },
            })
          } catch {
            // Vector store failure logged by provider — still record in SQLite
          }
        }

        succeededChunks.push({ hash: allChunks[i].hash, seq: allChunks[i].seq, pos: allChunks[i].pos, model: result.model || modelName })
        succeededHashes.add(allChunks[i].hash)
      } catch {
        log('codebase', 'Skipping chunk ' + allChunks[i].hash + ':' + allChunks[i].seq, 'warn')
        continue
      }

      if (i % 5 === 0) await yieldToEventLoop();
    }

    await store.insertEmbeddingLocalBatch(succeededChunks);

    for (const row of batch) {
      if (!succeededHashes.has(row.hash)) {
        failedHashes.add(row.hash)
        log('codebase', 'All chunks failed for ' + row.path + ' (' + row.hash.substring(0, 8) + '…) — skipping, FTS still covers it', 'warn')
      }
    }

    return { embedded: succeededHashes.size > 0 ? batch.length : 0, emptyBodyHashes }
  }
}

const EMPTY_BODY_HASH_PREFIX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export async function embedPendingCodebase(
  store: Store,
  embedder: { embed(text: string): Promise<{ embedding: number[]; model?: string }>; embedBatch?(texts: string[]): Promise<Array<{ embedding: number[] }>>; getModel?(): string; getMaxChars?(): number },
  batchSize: number = 50,
  projectHash?: string
): Promise<number> {
  const maxChars = embedder.getMaxChars?.() ?? 6000
  const vectorStore = store.getVectorStore?.() ?? null
  let embedded = 0
  const failedHashes = new Set<string>()
  const limit = pLimit(EMBEDDING_CONCURRENCY)

  while (true) {
    const allPending = store.getHashesNeedingEmbedding(projectHash)
    if (allPending.length === 0) break

    const emptyBodyDocs = allPending.filter(r =>
      r.hash === EMPTY_BODY_HASH_PREFIX ||
      r.body.trim().length === 0
    )
    if (emptyBodyDocs.length > 0) {
      await store.insertEmbeddingLocalBatch(emptyBodyDocs.map(doc => ({ hash: doc.hash, seq: -1, pos: 0, model: 'skipped:empty-body' })));
      for (const doc of emptyBodyDocs) {
        failedHashes.add(doc.hash)
      }
      log('codebase', `Skipped ${emptyBodyDocs.length} empty-body documents — marked as not embeddable`)
    }

    const batches: Array<Array<{ hash: string; body: string; path: string }>> = []
    let remaining = allPending.filter(r => !failedHashes.has(r.hash) && r.body.trim().length > 0)

    while (remaining.length > 0 && batches.length < MAX_PENDING_BATCHES) {
      const batch = remaining.slice(0, batchSize)
      remaining = remaining.slice(batchSize)
      batches.push(batch)
    }

    if (batches.length === 0) break

    log('codebase', `Processing ${batches.length} batches concurrently (concurrency=${EMBEDDING_CONCURRENCY})`)

    const results = await Promise.allSettled(
      batches.map(batch => limit(async () => {
        return processSingleBatch(batch, store, embedder, vectorStore, maxChars, failedHashes)
      }))
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        embedded += result.value.embedded
      }
    }

    if (embedded > 0 && embedded % 50 === 0) {
      log('codebase', 'Embedded ' + embedded + ' document(s)...')
    }

    await new Promise(resolve => setImmediate(resolve))
  }
  return embedded
}

export function getCodebaseStats(
  store: Store,
  config: CodebaseConfig | undefined,
  workspaceRoot: string
): { enabled: boolean; documents: number; extensions: string[]; excludeCount: number; storageUsed: number; maxSize: number } | undefined {
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
    extensions,
    excludeCount: excludePatterns.length,
    storageUsed,
    maxSize: effectiveMaxSize,
  }
}

export interface SymbolGraphIndexResult {
  symbolsIndexed: number
  edgesCreated: number
  filesProcessed: number
  filesSkipped: number
}

export async function indexSymbolGraph(
  db: BetterSqlite3.Database,
  workspaceRoot: string,
  projectHash: string,
  files: Array<{ path: string; content: string }>,
  options?: { force?: boolean }
): Promise<SymbolGraphIndexResult> {
  await waitForInit()

  if (!isTreeSitterAvailable()) {
    log('symbol-graph', 'Tree-sitter not available, skipping symbol graph indexing')
    return { symbolsIndexed: 0, edgesCreated: 0, filesProcessed: 0, filesSkipped: files.length }
  }

  const graph = new SymbolGraph(db, workspaceRoot)
  let symbolsIndexed = 0
  let edgesCreated = 0
  let filesProcessed = 0
  let filesSkipped = 0

  const allSymbols: Array<{ symbol: CodeSymbol; id: number; contentHash: string }> = []
  const fileSymbolMap = new Map<string, Array<{ symbol: CodeSymbol; id: number }>>()

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const language = detectLanguage(file.path) as SupportedLanguage | null
    if (!language || (language !== 'ts' && language !== 'js' && language !== 'python' && language !== 'vue')) {
      filesSkipped++
      continue
    }

    const contentHash = computeHash(file.content)
    const existingHash = graph.getFileContentHash(file.path, projectHash)

    if (!options?.force && existingHash === contentHash) {
      filesSkipped++
      const existingSymbols = graph.getSymbolByName('', projectHash, file.path)
      continue
    }

    graph.deleteSymbolsForFile(file.path, projectHash)

    const symbols = await parseSymbols(file.path, file.content, language)
    if (symbols.length > 0 || filesProcessed < 5) {
      log('codebase', 'SG-DBG ' + file.path.split('/').pop() + ' lang=' + language + ' syms=' + symbols.length + ' len=' + file.content.length)
    }
    const fileSymbols: Array<{ symbol: CodeSymbol; id: number }> = []

    for (const symbol of symbols) {
      const id = graph.insertSymbol({
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        exported: symbol.exported,
        contentHash,
        projectHash,
      })
      symbolsIndexed++
      allSymbols.push({ symbol, id, contentHash })
      fileSymbols.push({ symbol, id })
    }

    fileSymbolMap.set(file.path, fileSymbols)
    filesProcessed++

    if (fileIndex % 10 === 0) await yieldToEventLoop();
  }

  const symbolTable: SymbolTable = new Map()
  for (const { symbol } of allSymbols) {
    const existing = symbolTable.get(symbol.name) || []
    existing.push({ filePath: symbol.filePath, kind: symbol.kind })
    symbolTable.set(symbol.name, existing)
  }

  const symbolIdMap = new Map<string, number>()
  for (const { symbol, id } of allSymbols) {
    const key = `${symbol.filePath}:${symbol.name}:${symbol.kind}`
    symbolIdMap.set(key, id)
  }

  let edgeIterationCount = 0;
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    const language = detectLanguage(file.path) as SupportedLanguage | null
    if (!language || (language !== 'ts' && language !== 'js' && language !== 'python' && language !== 'vue')) {
      continue
    }

    const fileSymbols = fileSymbolMap.get(file.path)
    if (!fileSymbols) continue

    const callEdges = await resolveCallEdges(file.path, file.content, language, symbolTable)
    const heritageEdges = await resolveHeritageEdges(file.path, file.content, language, symbolTable)
    const allEdges: SymbolEdge[] = [...callEdges, ...heritageEdges]

    for (const edge of allEdges) {
      edgeIterationCount++;
      if (edgeIterationCount % 100 === 0) await yieldToEventLoop();

      const sourceSymbols = fileSymbols.filter(s =>
        s.symbol.startLine <= getLineForCall(edge, file.content) &&
        s.symbol.endLine >= getLineForCall(edge, file.content)
      )

      let sourceId: number | undefined
      if (sourceSymbols.length > 0) {
        sourceId = sourceSymbols[sourceSymbols.length - 1].id
      } else if (fileSymbols.length > 0) {
        sourceId = fileSymbols[0].id
      }

      if (!sourceId) continue

      let targetId: number | undefined
      if (edge.targetFilePath) {
        const targetKey = `${edge.targetFilePath}:${edge.targetName}:function`
        targetId = symbolIdMap.get(targetKey)
        if (!targetId) {
          const classKey = `${edge.targetFilePath}:${edge.targetName}:class`
          targetId = symbolIdMap.get(classKey)
        }
        if (!targetId) {
          const methodKey = `${edge.targetFilePath}:${edge.targetName}:method`
          targetId = symbolIdMap.get(methodKey)
        }
        if (!targetId) {
          const interfaceKey = `${edge.targetFilePath}:${edge.targetName}:interface`
          targetId = symbolIdMap.get(interfaceKey)
        }
        if (!targetId) {
          const typeKey = `${edge.targetFilePath}:${edge.targetName}:type`
          targetId = symbolIdMap.get(typeKey)
        }
        if (!targetId) {
          const enumKey = `${edge.targetFilePath}:${edge.targetName}:enum`
          targetId = symbolIdMap.get(enumKey)
        }
        if (!targetId) {
          const variableKey = `${edge.targetFilePath}:${edge.targetName}:variable`
          targetId = symbolIdMap.get(variableKey)
        }
        if (!targetId) {
          const propertyKey = `${edge.targetFilePath}:${edge.targetName}:property`
          targetId = symbolIdMap.get(propertyKey)
        }
      }

      if (!targetId) {
        const candidates = symbolTable.get(edge.targetName)
        if (candidates && candidates.length > 0) {
          for (const candidate of candidates) {
            const key = `${candidate.filePath}:${edge.targetName}:${candidate.kind}`
            targetId = symbolIdMap.get(key)
            if (targetId) break
          }
        }
      }

      if (targetId && sourceId !== targetId) {
        graph.insertEdge({
          sourceId,
          targetId,
          edgeType: edge.edgeType,
          confidence: edge.confidence,
          projectHash,
        })
        edgesCreated++
      }
    }

    if (fileIdx % 10 === 0) await yieldToEventLoop();
  }

  log('symbol-graph', `Indexed ${symbolsIndexed} symbols, ${edgesCreated} edges from ${filesProcessed} files`)
  return { symbolsIndexed, edgesCreated, filesProcessed, filesSkipped }
}

function getLineForCall(edge: SymbolEdge, _content: string): number {
  return 1
}
