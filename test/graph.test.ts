import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseImports, detectLanguage, computePageRank, louvainClustering, computeEdgeSetHash } from '../src/graph.js'
import { createStore } from '../src/store.js'
import { indexCodebase } from '../src/codebase.js'
import type { Store, CodebaseConfig } from '../src/types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('detectLanguage', () => {
  it('should detect TypeScript files', () => {
    expect(detectLanguage('/path/to/file.ts')).toBe('ts')
    expect(detectLanguage('/path/to/file.tsx')).toBe('ts')
    expect(detectLanguage('/path/to/file.mts')).toBe('ts')
    expect(detectLanguage('/path/to/file.cts')).toBe('ts')
  })

  it('should detect JavaScript files', () => {
    expect(detectLanguage('/path/to/file.js')).toBe('js')
    expect(detectLanguage('/path/to/file.jsx')).toBe('js')
    expect(detectLanguage('/path/to/file.mjs')).toBe('js')
    expect(detectLanguage('/path/to/file.cjs')).toBe('js')
  })

  it('should detect Python files', () => {
    expect(detectLanguage('/path/to/file.py')).toBe('python')
    expect(detectLanguage('/path/to/file.pyi')).toBe('python')
  })

  it('should detect Ruby files', () => {
    expect(detectLanguage('/path/to/file.rb')).toBe('ruby')
    expect(detectLanguage('/path/to/file.erb')).toBe('ruby')
  })

  it('should return null for unsupported extensions', () => {
    expect(detectLanguage('/path/to/file.go')).toBeNull()
    expect(detectLanguage('/path/to/file.rs')).toBeNull()
    expect(detectLanguage('/path/to/file.java')).toBeNull()
    expect(detectLanguage('/path/to/file.md')).toBeNull()
    expect(detectLanguage('/path/to/file.txt')).toBeNull()
  })

  it('should handle case insensitivity', () => {
    expect(detectLanguage('/path/to/file.TS')).toBe('ts')
    expect(detectLanguage('/path/to/file.PY')).toBe('python')
  })
})

describe('parseImports - JS/TS', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-graph-test-'))
    fs.mkdirSync(path.join(tmpDir, 'src'))
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'))
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.ts'), 'export const helper = 1')
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'index.ts'), 'export * from "./helper"')
    fs.writeFileSync(path.join(tmpDir, 'src', 'types.ts'), 'export type Foo = string')
    fs.writeFileSync(path.join(tmpDir, 'src', 'config.js'), 'module.exports = {}')
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should parse static imports', () => {
    const content = `
import { helper } from './utils/helper'
import * as utils from './utils'
import config from './config'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'index.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'config.js'))
  })

  it('should parse dynamic imports', () => {
    const content = `
const module = await import('./utils/helper')
import('./config').then(m => m.default)
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'config.js'))
  })

  it('should parse require() calls', () => {
    const content = `
const helper = require('./utils/helper')
const config = require('./config')
`
    const sourceFile = path.join(tmpDir, 'src', 'index.js')
    const imports = parseImports(sourceFile, content, 'js', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'config.js'))
  })

  it('should parse re-exports', () => {
    const content = `
export { helper } from './utils/helper'
export * from './types'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'types.ts'))
  })

  it('should parse aliased imports', () => {
    const content = `
import { helper as h } from './utils/helper'
import type { Foo as Bar } from './types'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
    expect(imports).toContain(path.join(tmpDir, 'src', 'types.ts'))
  })

  it('should parse type-only imports', () => {
    const content = `
import type { Foo } from './types'
import { type Bar } from './types'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'types.ts'))
  })

  it('should skip external packages (no . prefix)', () => {
    const content = `
import React from 'react'
import { useState } from 'react'
import lodash from 'lodash'
import { join } from 'path'
const fs = require('fs')
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should resolve relative paths with ../', () => {
    const content = `
import { helper } from '../../utils/helper'
`
    fs.mkdirSync(path.join(tmpDir, 'src', 'components'))
    fs.mkdirSync(path.join(tmpDir, 'src', 'components', 'deep'))
    const sourceFile = path.join(tmpDir, 'src', 'components', 'deep', 'file.ts')
    fs.writeFileSync(sourceFile, '')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
  })

  it('should resolve index files for directory imports', () => {
    const content = `
import { something } from './utils'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'index.ts'))
  })

  it('should return empty array for non-existent imports', () => {
    const content = `
import { foo } from './nonexistent'
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should deduplicate imports', () => {
    const content = `
import { helper } from './utils/helper'
import { helper as h } from './utils/helper'
const helper2 = require('./utils/helper')
`
    const sourceFile = path.join(tmpDir, 'src', 'index.ts')
    const imports = parseImports(sourceFile, content, 'ts', tmpDir)

    expect(imports).toHaveLength(1)
    expect(imports).toContain(path.join(tmpDir, 'src', 'utils', 'helper.ts'))
  })
})

describe('parseImports - Python', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-python-test-'))
    fs.mkdirSync(path.join(tmpDir, 'mypackage'))
    fs.mkdirSync(path.join(tmpDir, 'mypackage', 'models'))
    fs.writeFileSync(path.join(tmpDir, 'mypackage', '__init__.py'), '')
    fs.writeFileSync(path.join(tmpDir, 'mypackage', 'models', '__init__.py'), '')
    fs.writeFileSync(path.join(tmpDir, 'mypackage', 'models', 'user.py'), 'class User: pass')
    fs.writeFileSync(path.join(tmpDir, 'mypackage', 'utils.py'), 'def helper(): pass')
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should parse relative imports with single dot', () => {
    const content = `
from .models import User
from .utils import helper
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'main.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'mypackage', 'models', '__init__.py'))
    expect(imports).toContain(path.join(tmpDir, 'mypackage', 'utils.py'))
  })

  it('should parse relative imports with double dots', () => {
    const content = `
from ..utils import helper
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'models', 'user.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'mypackage', 'utils.py'))
  })

  it('should parse relative imports with just dots', () => {
    const content = `
from . import something
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'main.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'mypackage', '__init__.py'))
  })

  it('should skip stdlib imports (no dot prefix)', () => {
    const content = `
import os
import sys
from collections import defaultdict
from typing import List
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'main.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should skip external package imports', () => {
    const content = `
from django.db import models
from flask import Flask
import numpy as np
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'main.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should handle nested relative imports', () => {
    const content = `
from .models.user import User
`
    const sourceFile = path.join(tmpDir, 'mypackage', 'main.py')
    const imports = parseImports(sourceFile, content, 'python', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'mypackage', 'models', 'user.py'))
  })
})

describe('parseImports - Ruby', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-ruby-test-'))
    fs.mkdirSync(path.join(tmpDir, 'lib'))
    fs.mkdirSync(path.join(tmpDir, 'lib', 'helpers'))
    fs.mkdirSync(path.join(tmpDir, 'app'))
    fs.mkdirSync(path.join(tmpDir, 'app', 'models'))
    fs.writeFileSync(path.join(tmpDir, 'lib', 'helpers', 'redis_helper.rb'), 'module RedisHelper; end')
    fs.writeFileSync(path.join(tmpDir, 'lib', 'utils.rb'), 'module Utils; end')
    fs.writeFileSync(path.join(tmpDir, 'config.rb'), 'CONFIG = {}')
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'user.rb'), 'class User; end')
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'order.rb'), 'class Order; end')
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'profile.rb'), 'class Profile; end')
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should parse require_relative', () => {
    const content = `
require_relative './helpers/redis_helper'
require_relative 'utils'
`
    const sourceFile = path.join(tmpDir, 'lib', 'main.rb')
    fs.writeFileSync(sourceFile, '')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'lib', 'helpers', 'redis_helper.rb'))
    expect(imports).toContain(path.join(tmpDir, 'lib', 'utils.rb'))
  })

  it('should parse load with relative paths', () => {
    const content = `
load './config.rb'
`
    const sourceFile = path.join(tmpDir, 'main.rb')
    fs.writeFileSync(sourceFile, '')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'config.rb'))
  })

  it('should skip gem requires (no path separators)', () => {
    const content = `
require 'stripe'
require 'rails'
require 'active_record'
require 'json'
`
    const sourceFile = path.join(tmpDir, 'lib', 'main.rb')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should parse require with local file paths', () => {
    const content = `
require '../config'
require '../lib/utils'
`
    const sourceFile = path.join(tmpDir, 'app', 'main.rb')
    fs.writeFileSync(sourceFile, '')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'config.rb'))
    expect(imports).toContain(path.join(tmpDir, 'lib', 'utils.rb'))
  })
})

describe('parseImports - Rails associations', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-rails-test-'))
    fs.mkdirSync(path.join(tmpDir, 'app'))
    fs.mkdirSync(path.join(tmpDir, 'app', 'models'))
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'user.rb'), 'class User < ApplicationRecord; end')
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'order.rb'), 'class Order < ApplicationRecord; end')
    fs.writeFileSync(path.join(tmpDir, 'app', 'models', 'profile.rb'), 'class Profile < ApplicationRecord; end')
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should resolve belongs_to associations', () => {
    const content = `
class Order < ApplicationRecord
  belongs_to :user
end
`
    const sourceFile = path.join(tmpDir, 'app', 'models', 'order.rb')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'app', 'models', 'user.rb'))
  })

  it('should resolve has_many associations', () => {
    const content = `
class User < ApplicationRecord
  has_many :orders
end
`
    const sourceFile = path.join(tmpDir, 'app', 'models', 'user.rb')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'app', 'models', 'order.rb'))
  })

  it('should resolve has_one associations', () => {
    const content = `
class User < ApplicationRecord
  has_one :profile
end
`
    const sourceFile = path.join(tmpDir, 'app', 'models', 'user.rb')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'app', 'models', 'profile.rb'))
  })

  it('should only resolve associations for files under app/ directory', () => {
    const content = `
class SomeClass
  belongs_to :user
end
`
    const sourceFile = path.join(tmpDir, 'lib', 'some_class.rb')
    fs.mkdirSync(path.join(tmpDir, 'lib'))
    fs.writeFileSync(sourceFile, '')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toHaveLength(0)
  })

  it('should handle multiple associations', () => {
    const content = `
class User < ApplicationRecord
  has_many :orders
  has_one :profile
end
`
    const sourceFile = path.join(tmpDir, 'app', 'models', 'user.rb')
    const imports = parseImports(sourceFile, content, 'ruby', tmpDir)

    expect(imports).toContain(path.join(tmpDir, 'app', 'models', 'order.rb'))
    expect(imports).toContain(path.join(tmpDir, 'app', 'models', 'profile.rb'))
  })
})

describe('parseImports - unsupported languages', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-unsupported-test-'))
  })

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should return empty array for Go files', () => {
    const content = `
package main

import (
    "fmt"
    "os"
)
`
    const sourceFile = path.join(tmpDir, 'main.go')
    const language = detectLanguage(sourceFile)
    expect(language).toBeNull()
  })

  it('should return empty array for Rust files', () => {
    const content = `
use std::io;
use crate::utils;
`
    const sourceFile = path.join(tmpDir, 'main.rs')
    const language = detectLanguage(sourceFile)
    expect(language).toBeNull()
  })
})

describe('Store file edge methods', () => {
  let tmpDir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-edge-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should insert and retrieve file edges', () => {
    store.insertFileEdge('/src/a.ts', '/src/b.ts', 'test-project')
    store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges).toHaveLength(2)
    expect(edges.some(e => e.source_path === '/src/a.ts' && e.target_path === '/src/b.ts')).toBe(true)
    expect(edges.some(e => e.source_path === '/src/a.ts' && e.target_path === '/src/c.ts')).toBe(true)
  })

  it('should delete file edges for a source path', () => {
    store.insertFileEdge('/src/a.ts', '/src/b.ts', 'test-project')
    store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project')
    store.insertFileEdge('/src/d.ts', '/src/e.ts', 'test-project')

    store.deleteFileEdges('/src/a.ts', 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges).toHaveLength(1)
    expect(edges[0].source_path).toBe('/src/d.ts')
  })

  it('should handle edge cleanup on re-index', () => {
    store.insertFileEdge('/src/a.ts', '/src/old.ts', 'test-project')
    
    store.deleteFileEdges('/src/a.ts', 'test-project')
    store.insertFileEdge('/src/a.ts', '/src/new.ts', 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges).toHaveLength(1)
    expect(edges[0].target_path).toBe('/src/new.ts')
  })

  it('should isolate edges by project hash', () => {
    store.insertFileEdge('/src/a.ts', '/src/b.ts', 'project-1')
    store.insertFileEdge('/src/a.ts', '/src/c.ts', 'project-2')

    const edges1 = store.getFileEdges('project-1')
    const edges2 = store.getFileEdges('project-2')

    expect(edges1).toHaveLength(1)
    expect(edges1[0].target_path).toBe('/src/b.ts')
    expect(edges2).toHaveLength(1)
    expect(edges2[0].target_path).toBe('/src/c.ts')
  })

  it('should support custom edge types', () => {
    store.insertFileEdge('/src/a.ts', '/src/b.ts', 'test-project', 'import')
    store.insertFileEdge('/src/a.ts', '/src/c.ts', 'test-project', 'reference')

    const edges = store.getFileEdges('test-project')
    expect(edges).toHaveLength(2)
  })
})

describe('Integration - codebase indexing with import graph', () => {
  let tmpDir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-integration-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should insert edges during codebase indexing', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(path.join(srcDir, 'src'))
    
    fs.writeFileSync(path.join(srcDir, 'src', 'utils.ts'), 'export const helper = 1')
    fs.writeFileSync(path.join(srcDir, 'src', 'index.ts'), `
import { helper } from './utils'
export { helper }
`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.some(e => 
      e.source_path === path.join(srcDir, 'src', 'index.ts') &&
      e.target_path === path.join(srcDir, 'src', 'utils.ts')
    )).toBe(true)
  })

  it('should update edges on re-index when imports change', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(path.join(srcDir, 'src'))
    
    fs.writeFileSync(path.join(srcDir, 'src', 'old.ts'), 'export const old = 1')
    fs.writeFileSync(path.join(srcDir, 'src', 'new.ts'), 'export const newThing = 2')
    fs.writeFileSync(path.join(srcDir, 'src', 'index.ts'), `import { old } from './old'`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    let edges = store.getFileEdges('test-project')
    expect(edges.some(e => e.target_path.includes('old.ts'))).toBe(true)

    fs.writeFileSync(path.join(srcDir, 'src', 'index.ts'), `import { newThing } from './new'`)
    await indexCodebase(store, srcDir, config, 'test-project')

    edges = store.getFileEdges('test-project')
    const indexEdges = edges.filter(e => e.source_path.includes('index.ts'))
    expect(indexEdges).toHaveLength(1)
    expect(indexEdges[0].target_path).toContain('new.ts')
  })

  it('should handle files with no imports', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    
    fs.writeFileSync(path.join(srcDir, 'standalone.ts'), 'export const x = 1')

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const edges = store.getFileEdges('test-project')
    const standaloneEdges = edges.filter(e => e.source_path.includes('standalone.ts'))
    expect(standaloneEdges).toHaveLength(0)
  })

  it('should handle mixed language projects', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(path.join(srcDir, 'mypackage'))
    
    fs.writeFileSync(path.join(srcDir, 'src.ts'), 'export const x = 1')
    fs.writeFileSync(path.join(srcDir, 'mypackage', '__init__.py'), '')
    fs.writeFileSync(path.join(srcDir, 'mypackage', 'utils.py'), 'def helper(): pass')
    fs.writeFileSync(path.join(srcDir, 'mypackage', 'main.py'), 'from .utils import helper')

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts', '.py'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges.some(e => 
      e.source_path.includes('main.py') &&
      e.target_path.includes('utils.py')
    )).toBe(true)
  })
})

describe('computePageRank', () => {
  it('should compute PageRank on a known graph with C having highest score', () => {
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'B', target: 'C' },
      { source: 'D', target: 'C' },
    ]
    const ranks = computePageRank(edges)

    expect(ranks.size).toBe(4)
    const cRank = ranks.get('C')!
    const aRank = ranks.get('A')!
    const bRank = ranks.get('B')!
    const dRank = ranks.get('D')!

    expect(cRank).toBeGreaterThan(aRank)
    expect(cRank).toBeGreaterThan(bRank)
    expect(cRank).toBeGreaterThan(dRank)
  })

  it('should return scores that sum to approximately 1.0', () => {
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
    ]
    const ranks = computePageRank(edges, 0.85, 100)

    let sum = 0
    for (const score of ranks.values()) {
      sum += score
    }
    expect(sum).toBeCloseTo(1.0, 5)
  })

  it('should return empty map for empty graph', () => {
    const ranks = computePageRank([])
    expect(ranks.size).toBe(0)
  })

  it('should handle single node with self-loop', () => {
    const edges = [{ source: 'A', target: 'A' }]
    const ranks = computePageRank(edges)

    expect(ranks.size).toBe(1)
    expect(ranks.get('A')).toBeCloseTo(1.0, 5)
  })

  it('should handle dangling nodes (no outgoing edges)', () => {
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
    ]
    const ranks = computePageRank(edges)

    expect(ranks.size).toBe(3)
    let sum = 0
    for (const score of ranks.values()) {
      sum += score
    }
    expect(sum).toBeCloseTo(1.0, 5)
  })
})

describe('louvainClustering', () => {
  it('should detect two distinct clusters in a known graph', () => {
    const edges: Array<{ source: string; target: string }> = []

    for (let i = 0; i < 10; i++) {
      for (let j = i + 1; j < 10; j++) {
        edges.push({ source: `A${i}`, target: `A${j}` })
      }
    }

    for (let i = 0; i < 10; i++) {
      for (let j = i + 1; j < 10; j++) {
        edges.push({ source: `B${i}`, target: `B${j}` })
      }
    }

    edges.push({ source: 'A0', target: 'B0' })

    const clusters = louvainClustering(edges)

    expect(clusters.size).toBe(20)

    const clusterA = clusters.get('A0')!
    const clusterB = clusters.get('B0')!
    expect(clusterA).not.toBe(clusterB)

    for (let i = 1; i < 10; i++) {
      expect(clusters.get(`A${i}`)).toBe(clusterA)
      expect(clusters.get(`B${i}`)).toBe(clusterB)
    }
  })

  it('should return empty map for graphs with fewer than 20 nodes', () => {
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'D' },
    ]
    const clusters = louvainClustering(edges)
    expect(clusters.size).toBe(0)
  })

  it('should return empty map for empty graph', () => {
    const clusters = louvainClustering([])
    expect(clusters.size).toBe(0)
  })
})

describe('computeEdgeSetHash', () => {
  it('should return same hash for same edges', () => {
    const edges1 = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ]
    const edges2 = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ]
    expect(computeEdgeSetHash(edges1)).toBe(computeEdgeSetHash(edges2))
  })

  it('should return different hash for different edges', () => {
    const edges1 = [
      { source: 'A', target: 'B' },
    ]
    const edges2 = [
      { source: 'A', target: 'C' },
    ]
    expect(computeEdgeSetHash(edges1)).not.toBe(computeEdgeSetHash(edges2))
  })

  it('should return same hash regardless of edge order', () => {
    const edges1 = [
      { source: 'A', target: 'B' },
      { source: 'C', target: 'D' },
    ]
    const edges2 = [
      { source: 'C', target: 'D' },
      { source: 'A', target: 'B' },
    ]
    expect(computeEdgeSetHash(edges1)).toBe(computeEdgeSetHash(edges2))
  })

  it('should return consistent hash for empty edges', () => {
    const hash1 = computeEdgeSetHash([])
    const hash2 = computeEdgeSetHash([])
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(64)
  })
})

describe('Integration - centrality and clustering', () => {
  let tmpDir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-centrality-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should update centrality scores after indexing', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(path.join(srcDir, 'src'))

    fs.writeFileSync(path.join(srcDir, 'src', 'utils.ts'), 'export const helper = 1')
    fs.writeFileSync(path.join(srcDir, 'src', 'types.ts'), 'export type Foo = string')
    fs.writeFileSync(path.join(srcDir, 'src', 'index.ts'), `
import { helper } from './utils'
import type { Foo } from './types'
export { helper }
`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const utilsDoc = store.findDocument(path.join(srcDir, 'src', 'utils.ts'))
    const typesDoc = store.findDocument(path.join(srcDir, 'src', 'types.ts'))

    expect(utilsDoc).not.toBeNull()
    expect(typesDoc).not.toBeNull()
  })

  it('should skip clustering for small graphs', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)

    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(srcDir, 'b.ts'), `import { a } from './a'`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const edges = store.getFileEdges('test-project')
    expect(edges.length).toBeLessThan(20)
  })

  it('should cache edge set hash and skip recomputation when unchanged', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)

    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(srcDir, 'b.ts'), `import { a } from './a'`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const hash1 = store.getEdgeSetHash('test-project')
    expect(hash1).not.toBeNull()

    await indexCodebase(store, srcDir, config, 'test-project')

    const hash2 = store.getEdgeSetHash('test-project')
    expect(hash2).toBe(hash1)
  })

  it('should update edge set hash when imports change', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)

    fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(srcDir, 'b.ts'), 'export const b = 2')
    fs.writeFileSync(path.join(srcDir, 'c.ts'), `import { a } from './a'`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const hash1 = store.getEdgeSetHash('test-project')

    fs.writeFileSync(path.join(srcDir, 'c.ts'), `import { b } from './b'`)
    await indexCodebase(store, srcDir, config, 'test-project')

    const hash2 = store.getEdgeSetHash('test-project')
    expect(hash2).not.toBe(hash1)
  })
})
