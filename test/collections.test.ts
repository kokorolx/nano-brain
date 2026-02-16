import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadCollectionConfig,
  saveCollectionConfig,
  getCollections,
  addCollection,
  removeCollection,
  listCollections,
  renameCollection,
  addContext,
  findContextForPath,
  listAllContexts,
  scanCollectionFiles,
} from '../src/collections.js';
import type { CollectionConfig, Collection } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Collections', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-collections-test-'));
    configPath = path.join(tmpDir, 'config.yml');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('loadCollectionConfig', () => {
    it('should return null for non-existent config', () => {
      const result = loadCollectionConfig(configPath);
      expect(result).toBeNull();
    });

    it('should load valid YAML config', () => {
      const config: CollectionConfig = {
        globalContext: 'Test context',
        collections: {
          sessions: {
            path: '~/.opencode-memory/sessions',
            pattern: '**/*.md',
            context: {
              'sessions/': 'Harvested sessions',
            },
            update: 'auto',
          },
        },
      };

      saveCollectionConfig(configPath, config);
      const loaded = loadCollectionConfig(configPath);

      expect(loaded).not.toBeNull();
      expect(loaded?.globalContext).toBe('Test context');
      expect(loaded?.collections.sessions).toBeDefined();
      expect(loaded?.collections.sessions.path).toBe('~/.opencode-memory/sessions');
    });

    it('should throw on malformed YAML', () => {
      fs.writeFileSync(configPath, 'invalid: yaml: content: [', 'utf-8');
      expect(() => loadCollectionConfig(configPath)).toThrow();
    });
  });

  describe('saveCollectionConfig', () => {
    it('should save config to YAML file', () => {
      const config: CollectionConfig = {
        globalContext: 'Test context',
        collections: {
          memory: {
            path: '~/.opencode-memory/memory',
            pattern: '**/*.md',
            update: 'auto',
          },
        },
      };

      saveCollectionConfig(configPath, config);

      expect(fs.existsSync(configPath)).toBe(true);
      const content = fs.readFileSync(configPath, 'utf-8');
      expect(content).toContain('globalContext: Test context');
      expect(content).toContain('memory:');
    });

    it('should create parent directories if needed', () => {
      const nestedPath = path.join(tmpDir, 'nested', 'dir', 'config.yml');
      const config: CollectionConfig = {
        collections: {
          test: {
            path: '/test',
          },
        },
      };

      saveCollectionConfig(nestedPath, config);

      expect(fs.existsSync(nestedPath)).toBe(true);
    });
  });

  describe('getCollections', () => {
    it('should convert config to Collection array', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '~/.opencode-memory/sessions',
            pattern: '**/*.md',
            context: {
              'sessions/': 'Harvested sessions',
            },
          },
          memory: {
            path: '~/.opencode-memory/memory',
          },
        },
      };

      const collections = getCollections(config);

      expect(collections).toHaveLength(2);
      expect(collections[0].name).toBe('sessions');
      expect(collections[0].path).toBe('~/.opencode-memory/sessions');
      expect(collections[0].pattern).toBe('**/*.md');
      expect(collections[0].context).toEqual({ 'sessions/': 'Harvested sessions' });

      expect(collections[1].name).toBe('memory');
      expect(collections[1].pattern).toBe('**/*.md');
    });

    it('should use default pattern when not specified', () => {
      const config: CollectionConfig = {
        collections: {
          test: {
            path: '/test/path',
          },
        },
      };

      const collections = getCollections(config);

      expect(collections[0].pattern).toBe('**/*.md');
    });
  });

  describe('addCollection', () => {
    it('should create new collection in existing config', () => {
      const initialConfig: CollectionConfig = {
        collections: {
          existing: {
            path: '/existing',
          },
        },
      };

      saveCollectionConfig(configPath, initialConfig);

      const updated = addCollection(configPath, 'new', '/new/path', '**/*.txt');

      expect(updated.collections.existing).toBeDefined();
      expect(updated.collections.new).toBeDefined();
      expect(updated.collections.new.path).toBe('/new/path');
      expect(updated.collections.new.pattern).toBe('**/*.txt');
    });

    it('should create new config if none exists', () => {
      const config = addCollection(configPath, 'first', '/first/path');

      expect(config.collections.first).toBeDefined();
      expect(config.collections.first.path).toBe('/first/path');
      expect(config.collections.first.pattern).toBe('**/*.md');
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it('should use default pattern if not provided', () => {
      const config = addCollection(configPath, 'test', '/test');

      expect(config.collections.test.pattern).toBe('**/*.md');
    });
  });

  describe('removeCollection', () => {
    it('should remove collection from config', () => {
      const config: CollectionConfig = {
        collections: {
          keep: {
            path: '/keep',
          },
          remove: {
            path: '/remove',
          },
        },
      };

      saveCollectionConfig(configPath, config);

      const updated = removeCollection(configPath, 'remove');

      expect(updated.collections.keep).toBeDefined();
      expect(updated.collections.remove).toBeUndefined();
    });

    it('should throw if config does not exist', () => {
      expect(() => removeCollection(configPath, 'test')).toThrow('Config file not found');
    });
  });

  describe('listCollections', () => {
    it('should return array of collection names', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: { path: '/sessions' },
          memory: { path: '/memory' },
          docs: { path: '/docs' },
        },
      };

      const names = listCollections(config);

      expect(names).toHaveLength(3);
      expect(names).toContain('sessions');
      expect(names).toContain('memory');
      expect(names).toContain('docs');
    });
  });

  describe('renameCollection', () => {
    it('should rename collection key', () => {
      const config: CollectionConfig = {
        collections: {
          oldName: {
            path: '/test/path',
            pattern: '**/*.md',
            context: {
              'test/': 'Test context',
            },
          },
        },
      };

      saveCollectionConfig(configPath, config);

      const updated = renameCollection(configPath, 'oldName', 'newName');

      expect(updated.collections.oldName).toBeUndefined();
      expect(updated.collections.newName).toBeDefined();
      expect(updated.collections.newName.path).toBe('/test/path');
      expect(updated.collections.newName.pattern).toBe('**/*.md');
      expect(updated.collections.newName.context).toEqual({ 'test/': 'Test context' });
    });

    it('should throw if config does not exist', () => {
      expect(() => renameCollection(configPath, 'old', 'new')).toThrow('Config file not found');
    });

    it('should throw if collection does not exist', () => {
      const config: CollectionConfig = {
        collections: {
          existing: { path: '/test' },
        },
      };

      saveCollectionConfig(configPath, config);

      expect(() => renameCollection(configPath, 'nonexistent', 'new')).toThrow(
        'Collection "nonexistent" not found'
      );
    });
  });

  describe('addContext', () => {
    it('should add context to collection', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '/sessions',
          },
        },
      };

      saveCollectionConfig(configPath, config);

      const updated = addContext(configPath, 'sessions', 'sessions/', 'Harvested sessions');

      expect(updated.collections.sessions.context).toBeDefined();
      expect(updated.collections.sessions.context!['sessions/']).toBe('Harvested sessions');
    });

    it('should add context to existing context map', () => {
      const config: CollectionConfig = {
        collections: {
          memory: {
            path: '/memory',
            context: {
              'MEMORY.md': 'Main memory',
            },
          },
        },
      };

      saveCollectionConfig(configPath, config);

      const updated = addContext(configPath, 'memory', 'daily/', 'Daily logs');

      expect(updated.collections.memory.context!['MEMORY.md']).toBe('Main memory');
      expect(updated.collections.memory.context!['daily/']).toBe('Daily logs');
    });

    it('should throw if config does not exist', () => {
      expect(() => addContext(configPath, 'test', 'prefix/', 'desc')).toThrow(
        'Config file not found'
      );
    });

    it('should throw if collection does not exist', () => {
      const config: CollectionConfig = {
        collections: {
          existing: { path: '/test' },
        },
      };

      saveCollectionConfig(configPath, config);

      expect(() => addContext(configPath, 'nonexistent', 'prefix/', 'desc')).toThrow(
        'Collection "nonexistent" not found'
      );
    });
  });

  describe('findContextForPath', () => {
    it('should find context for matching path', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '/sessions',
            context: {
              'sessions/': 'Harvested sessions',
            },
          },
        },
      };

      const result = findContextForPath(config, 'sessions/2024-01-01.md');

      expect(result).toBe('Harvested sessions');
    });

    it('should return longest matching prefix', () => {
      const config: CollectionConfig = {
        collections: {
          memory: {
            path: '/memory',
            context: {
              'memory/': 'All memory files',
              'memory/daily/': 'Daily logs',
            },
          },
        },
      };

      const result = findContextForPath(config, 'memory/daily/2024-01-01.md');

      expect(result).toBe('Daily logs');
    });

    it('should return null for no match', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '/sessions',
            context: {
              'sessions/': 'Harvested sessions',
            },
          },
        },
      };

      const result = findContextForPath(config, 'other/file.md');

      expect(result).toBeNull();
    });

    it('should search across multiple collections', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '/sessions',
            context: {
              'sessions/': 'Harvested sessions',
            },
          },
          memory: {
            path: '/memory',
            context: {
              'MEMORY.md': 'Main memory',
            },
          },
        },
      };

      const result1 = findContextForPath(config, 'sessions/test.md');
      const result2 = findContextForPath(config, 'MEMORY.md');

      expect(result1).toBe('Harvested sessions');
      expect(result2).toBe('Main memory');
    });
  });

  describe('listAllContexts', () => {
    it('should flatten all contexts across collections', () => {
      const config: CollectionConfig = {
        collections: {
          sessions: {
            path: '/sessions',
            context: {
              'sessions/': 'Harvested sessions',
            },
          },
          memory: {
            path: '/memory',
            context: {
              'MEMORY.md': 'Main memory',
              'daily/': 'Daily logs',
            },
          },
        },
      };

      const contexts = listAllContexts(config);

      expect(contexts).toHaveLength(3);
      expect(contexts).toContainEqual({
        collection: 'sessions',
        prefix: 'sessions/',
        description: 'Harvested sessions',
      });
      expect(contexts).toContainEqual({
        collection: 'memory',
        prefix: 'MEMORY.md',
        description: 'Main memory',
      });
      expect(contexts).toContainEqual({
        collection: 'memory',
        prefix: 'daily/',
        description: 'Daily logs',
      });
    });

    it('should return empty array if no contexts', () => {
      const config: CollectionConfig = {
        collections: {
          test: {
            path: '/test',
          },
        },
      };

      const contexts = listAllContexts(config);

      expect(contexts).toHaveLength(0);
    });
  });

  describe('scanCollectionFiles', () => {
    it('should find markdown files matching pattern', async () => {
      const collectionDir = path.join(tmpDir, 'collection');
      fs.mkdirSync(collectionDir, { recursive: true });

      fs.writeFileSync(path.join(collectionDir, 'file1.md'), '# File 1');
      fs.writeFileSync(path.join(collectionDir, 'file2.md'), '# File 2');
      fs.writeFileSync(path.join(collectionDir, 'file3.txt'), 'Text file');

      const collection: Collection = {
        name: 'test',
        path: collectionDir,
        pattern: '**/*.md',
      };

      const files = await scanCollectionFiles(collection);

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith('file1.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('file2.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('file3.txt'))).toBe(false);
    });

    it('should find files in nested directories', async () => {
      const collectionDir = path.join(tmpDir, 'collection');
      const nestedDir = path.join(collectionDir, 'nested', 'deep');
      fs.mkdirSync(nestedDir, { recursive: true });

      fs.writeFileSync(path.join(collectionDir, 'root.md'), '# Root');
      fs.writeFileSync(path.join(nestedDir, 'nested.md'), '# Nested');

      const collection: Collection = {
        name: 'test',
        path: collectionDir,
        pattern: '**/*.md',
      };

      const files = await scanCollectionFiles(collection);

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith('root.md'))).toBe(true);
      expect(files.some((f) => f.endsWith('nested.md'))).toBe(true);
    });

    it('should return empty array for non-existent directory', async () => {
      const collection: Collection = {
        name: 'test',
        path: '/nonexistent/path',
        pattern: '**/*.md',
      };

      const files = await scanCollectionFiles(collection);

      expect(files).toHaveLength(0);
    });

    it('should expand tilde in path', async () => {
      const homeDir = os.homedir();
      const testDir = path.join(homeDir, '.opencode-memory-test-scan');
      
      try {
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(path.join(testDir, 'test.md'), '# Test');

        const collection: Collection = {
          name: 'test',
          path: '~/.opencode-memory-test-scan',
          pattern: '**/*.md',
        };

        const files = await scanCollectionFiles(collection);

        expect(files.length).toBeGreaterThan(0);
        expect(files.some((f) => f.endsWith('test.md'))).toBe(true);
      } finally {
        if (fs.existsSync(testDir)) {
          fs.rmSync(testDir, { recursive: true, force: true });
        }
      }
    });

    it('should respect custom pattern', async () => {
      const collectionDir = path.join(tmpDir, 'collection');
      fs.mkdirSync(collectionDir, { recursive: true });

      fs.writeFileSync(path.join(collectionDir, 'file.md'), '# Markdown');
      fs.writeFileSync(path.join(collectionDir, 'file.txt'), 'Text');
      fs.writeFileSync(path.join(collectionDir, 'file.json'), '{}');

      const collection: Collection = {
        name: 'test',
        path: collectionDir,
        pattern: '**/*.txt',
      };

      const files = await scanCollectionFiles(collection);

      expect(files).toHaveLength(1);
      expect(files[0].endsWith('file.txt')).toBe(true);
    });
  });
});
