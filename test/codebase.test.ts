import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectProjectType,
  loadGitignorePatterns,
  mergeExcludePatterns,
  resolveExtensions,
  scanCodebaseFiles,
  indexCodebase,
  getCodebaseStats,
} from '../src/codebase.js';
import { createStore, computeHash } from '../src/store.js';
import type { Store, CodebaseConfig } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('detectProjectType', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-codebase-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should detect Node.js project from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.tsx');
    expect(extensions).toContain('.js');
    expect(extensions).toContain('.jsx');
    expect(extensions).toContain('.md');
  });

  it('should detect Python project from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.py');
    expect(extensions).toContain('.pyi');
    expect(extensions).toContain('.md');
  });

  it('should detect Python project from requirements.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.py');
    expect(extensions).toContain('.md');
  });

  it('should detect Go project from go.mod', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.go');
    expect(extensions).toContain('.md');
  });

  it('should detect Rust project from Cargo.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.rs');
    expect(extensions).toContain('.md');
  });

  it('should detect Java project from pom.xml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.java');
    expect(extensions).toContain('.kt');
    expect(extensions).toContain('.md');
  });

  it('should detect Ruby project from Gemfile', () => {
    fs.writeFileSync(path.join(tmpDir, 'Gemfile'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.rb');
    expect(extensions).toContain('.erb');
    expect(extensions).toContain('.md');
  });

  it('should detect multiple project types', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '');
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.py');
    expect(extensions).toContain('.md');
  });

  it('should return default extensions when no markers found', () => {
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.py');
    expect(extensions).toContain('.go');
    expect(extensions).toContain('.rs');
    expect(extensions).toContain('.md');
  });

  it('should always include .md extension', () => {
    const extensions = detectProjectType(tmpDir);
    expect(extensions).toContain('.md');
  });
});

describe('loadGitignorePatterns', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-gitignore-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when no .gitignore exists', () => {
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toEqual([]);
  });

  it('should parse simple patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\ndist\n*.log');
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('dist');
    expect(patterns).toContain('*.log');
  });

  it('should ignore comments', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# This is a comment\nnode_modules\n# Another comment');
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toEqual(['node_modules']);
  });

  it('should ignore empty lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n\n\ndist\n');
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toEqual(['node_modules', 'dist']);
  });

  it('should trim whitespace', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '  node_modules  \n  dist  ');
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toEqual(['node_modules', 'dist']);
  });

  it('should handle complex .gitignore', () => {
    const gitignore = `
# Dependencies
node_modules/
.pnp
.pnp.js

# Build
dist/
build/
*.min.js

# IDE
.idea/
.vscode/
*.swp
    `.trim();
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), gitignore);
    const patterns = loadGitignorePatterns(tmpDir);
    expect(patterns).toContain('node_modules/');
    expect(patterns).toContain('dist/');
    expect(patterns).toContain('.idea/');
    expect(patterns).not.toContain('# Dependencies');
  });
});

describe('mergeExcludePatterns', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-merge-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should include builtin patterns', () => {
    const config: CodebaseConfig = { enabled: true };
    const patterns = mergeExcludePatterns(config, tmpDir);
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('.git');
    expect(patterns).toContain('dist');
    expect(patterns).toContain('__pycache__');
  });

  it('should include gitignore patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'custom_ignore\n*.custom');
    const config: CodebaseConfig = { enabled: true };
    const patterns = mergeExcludePatterns(config, tmpDir);
    expect(patterns).toContain('custom_ignore');
    expect(patterns).toContain('*.custom');
  });

  it('should include config exclude patterns', () => {
    const config: CodebaseConfig = { enabled: true, exclude: ['my_exclude', '*.test.ts'] };
    const patterns = mergeExcludePatterns(config, tmpDir);
    expect(patterns).toContain('my_exclude');
    expect(patterns).toContain('*.test.ts');
  });

  it('should deduplicate patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\ndist');
    const config: CodebaseConfig = { enabled: true, exclude: ['node_modules', 'custom'] };
    const patterns = mergeExcludePatterns(config, tmpDir);
    const nodeModulesCount = patterns.filter(p => p === 'node_modules').length;
    expect(nodeModulesCount).toBe(1);
  });

  it('should merge all sources', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'gitignore_pattern');
    const config: CodebaseConfig = { enabled: true, exclude: ['config_pattern'] };
    const patterns = mergeExcludePatterns(config, tmpDir);
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('gitignore_pattern');
    expect(patterns).toContain('config_pattern');
  });
});

describe('resolveExtensions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-resolve-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should use config extensions when provided', () => {
    const config: CodebaseConfig = { enabled: true, extensions: ['.custom', '.ext'] };
    const extensions = resolveExtensions(config, tmpDir);
    expect(extensions).toEqual(['.custom', '.ext']);
  });

  it('should detect project type when no config extensions', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const config: CodebaseConfig = { enabled: true };
    const extensions = resolveExtensions(config, tmpDir);
    expect(extensions).toContain('.ts');
    expect(extensions).toContain('.js');
  });

  it('should use empty array config as empty', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const config: CodebaseConfig = { enabled: true, extensions: [] };
    const extensions = resolveExtensions(config, tmpDir);
    expect(extensions).toContain('.ts');
  });
});

describe('scanCodebaseFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-scan-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should find files matching extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'file.js'), 'const y = 2;');
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'text');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts', '.js'] };
    const { files, skippedTooLarge } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('file.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('file.js'))).toBe(true);
    expect(files.some(f => f.endsWith('file.txt'))).toBe(false);
    expect(skippedTooLarge).toBe(0);
  });

  it('should find files in subdirectories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const { files } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(2);
    expect(files.some(f => f.includes('index.ts'))).toBe(true);
    expect(files.some(f => f.includes('helper.ts'))).toBe(true);
  });

  it('should exclude node_modules by default', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'dep.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'export {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const { files } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(1);
    expect(files[0]).toContain('src.ts');
  });

  it('should exclude .git by default', async () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'config.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'export {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const { files } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(1);
    expect(files[0]).toContain('main.ts');
  });

  it('should respect custom exclude patterns', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tests'));
    fs.writeFileSync(path.join(tmpDir, 'tests', 'test.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'export {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'], exclude: ['tests'] };
    const { files } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(1);
    expect(files[0]).toContain('main.ts');
  });

  it('should skip files larger than maxFileSize', async () => {
    fs.writeFileSync(path.join(tmpDir, 'small.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'large.ts'), 'x'.repeat(1000));
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'], maxFileSize: '500' };
    const { files, skippedTooLarge } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files.length).toBe(1);
    expect(files[0]).toContain('small.ts');
    expect(skippedTooLarge).toBe(1);
  });

  it('should return empty array for empty directory', async () => {
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const { files, skippedTooLarge } = await scanCodebaseFiles(tmpDir, config);
    
    expect(files).toEqual([]);
    expect(skippedTooLarge).toBe(0);
  });

  it('should handle non-existent directory gracefully', async () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const { files } = await scanCodebaseFiles(nonExistent, config);
    
    expect(files).toEqual([]);
  });
});

describe('indexCodebase - integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-index-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should index source files', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export const util = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const result = await indexCodebase(store, srcDir, config, 'test-project-hash');
    
    expect(result.filesScanned).toBe(2);
    expect(result.filesIndexed).toBe(2);
    expect(result.filesSkippedUnchanged).toBe(0);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });

  it('should skip unchanged files on re-index', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    
    await indexCodebase(store, srcDir, config, 'test-hash');
    const result = await indexCodebase(store, srcDir, config, 'test-hash');
    
    expect(result.filesScanned).toBe(1);
    expect(result.filesIndexed).toBe(0);
    expect(result.filesSkippedUnchanged).toBe(1);
  });

  it('should re-index modified files', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    
    await indexCodebase(store, srcDir, config, 'test-hash');
    
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => { return 42; };');
    const result = await indexCodebase(store, srcDir, config, 'test-hash');
    
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkippedUnchanged).toBe(0);
  });

  it('should deactivate deleted files', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    fs.writeFileSync(path.join(srcDir, 'delete-me.ts'), 'export const x = 1;');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    
    await indexCodebase(store, srcDir, config, 'test-hash');
    
    const docBefore = store.findDocument(path.join(srcDir, 'delete-me.ts'));
    expect(docBefore).not.toBeNull();
    expect(docBefore?.active).toBe(true);
    
    fs.unlinkSync(path.join(srcDir, 'delete-me.ts'));
    await indexCodebase(store, srcDir, config, 'test-hash');
    
    const docAfter = store.findDocument(path.join(srcDir, 'delete-me.ts'));
    expect(docAfter).toBeNull();
  });

  it('should set correct projectHash on documents', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    await indexCodebase(store, srcDir, config, 'my-project-hash');
    
    const doc = store.findDocument(path.join(srcDir, 'main.ts'));
    expect(doc?.projectHash).toBe('my-project-hash');
    expect(doc?.collection).toBe('codebase');
  });

  it('should enforce storage budget', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'file1.ts'), 'x'.repeat(500));
    fs.writeFileSync(path.join(srcDir, 'file2.ts'), 'y'.repeat(500));
    fs.writeFileSync(path.join(srcDir, 'file3.ts'), 'z'.repeat(500));
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'], maxSize: '1000' };
    const result = await indexCodebase(store, srcDir, config, 'test-hash');
    
    expect(result.filesSkippedBudget).toBeGreaterThan(0);
    expect(result.filesIndexed).toBeLessThan(3);
  });

  it('should return storage usage info', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] };
    const result = await indexCodebase(store, srcDir, config, 'test-hash');
    
    expect(result.storageUsedBytes).toBeGreaterThan(0);
    expect(result.maxSizeBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it('should use custom maxSize from config', async () => {
    const srcDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), 'export const main = () => {};');
    
    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'], maxSize: '500MB' };
    const result = await indexCodebase(store, srcDir, config, 'test-hash');
    
    expect(result.maxSizeBytes).toBe(500 * 1024 * 1024);
  });
});

describe('getCollectionStorageSize - integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-storage-size-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return 0 for empty collection', () => {
    const size = store.getCollectionStorageSize('codebase');
    expect(size).toBe(0);
  });

  it('should return correct size for documents', () => {
    const content1 = 'Hello World';
    const content2 = 'Another document';
    const hash1 = computeHash(content1);
    const hash2 = computeHash(content2);
    
    store.insertContent(hash1, content1);
    store.insertContent(hash2, content2);
    
    store.insertDocument({
      collection: 'codebase',
      path: '/test/file1.ts',
      title: 'file1.ts',
      hash: hash1,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
    
    store.insertDocument({
      collection: 'codebase',
      path: '/test/file2.ts',
      title: 'file2.ts',
      hash: hash2,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
    
    const size = store.getCollectionStorageSize('codebase');
    expect(size).toBe(content1.length + content2.length);
  });

  it('should only count active documents', () => {
    const content = 'Test content';
    const hash = computeHash(content);
    
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'codebase',
      path: '/test/file.ts',
      title: 'file.ts',
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
    
    const sizeBefore = store.getCollectionStorageSize('codebase');
    expect(sizeBefore).toBe(content.length);
    
    store.deactivateDocument('codebase', '/test/file.ts');
    
    const sizeAfter = store.getCollectionStorageSize('codebase');
    expect(sizeAfter).toBe(0);
  });

  it('should only count specified collection', () => {
    const content = 'Test content';
    const hash = computeHash(content);
    
    store.insertContent(hash, content);
    store.insertDocument({
      collection: 'other-collection',
      path: '/test/file.ts',
      title: 'file.ts',
      hash,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      active: true,
    });
    
    const codebaseSize = store.getCollectionStorageSize('codebase');
    const otherSize = store.getCollectionStorageSize('other-collection');
    
    expect(codebaseSize).toBe(0);
    expect(otherSize).toBe(content.length);
  });
});

describe('getCodebaseStats', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-stats-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = createStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return undefined when codebase not enabled', () => {
    const config: CodebaseConfig = { enabled: false };
    const stats = getCodebaseStats(store, config, tmpDir);
    expect(stats).toBeUndefined();
  });

  it('should return undefined when config is undefined', () => {
    const stats = getCodebaseStats(store, undefined, tmpDir);
    expect(stats).toBeUndefined();
  });

  it('should return stats when enabled', () => {
    const config: CodebaseConfig = { enabled: true };
    const stats = getCodebaseStats(store, config, tmpDir);
    
    expect(stats).toBeDefined();
    expect(stats?.enabled).toBe(true);
    expect(stats?.documents).toBe(0);
    expect(stats?.storageUsed).toBe(0);
    expect(stats?.maxSize).toBe(2 * 1024 * 1024 * 1024);
  });

  it('should include resolved extensions', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const config: CodebaseConfig = { enabled: true };
    const stats = getCodebaseStats(store, config, tmpDir);
    
    expect(stats?.extensions).toContain('.ts');
    expect(stats?.extensions).toContain('.js');
  });

  it('should include exclude pattern count', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'custom1\ncustom2');
    const config: CodebaseConfig = { enabled: true, exclude: ['extra'] };
    const stats = getCodebaseStats(store, config, tmpDir);
    
    expect(stats?.excludeCount).toBeGreaterThan(0);
  });

  it('should use custom maxSize from config', () => {
    const config: CodebaseConfig = { enabled: true, maxSize: '1GB' };
    const stats = getCodebaseStats(store, config, tmpDir);
    
    expect(stats?.maxSize).toBe(1024 * 1024 * 1024);
  });
});
