import { describe, it, expect, beforeAll } from 'vitest'
import {
  isTreeSitterAvailable,
  waitForInit,
  parseSymbols,
  resolveCallEdges,
  resolveHeritageEdges,
  type SymbolTable,
} from '../src/treesitter.js'

describe('Tree-sitter initialization', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should report tree-sitter availability', () => {
    const available = isTreeSitterAvailable()
    expect(typeof available).toBe('boolean')
  })
})

describe('parseSymbols - TypeScript', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should extract function declarations', async () => {
    const content = `
function hello() {
  console.log('hello')
}

function world(name: string): string {
  return 'world ' + name
}
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.name === 'hello' && s.kind === 'function')).toBe(true)
    expect(symbols.some(s => s.name === 'world' && s.kind === 'function')).toBe(true)
  })

  it('should extract arrow functions with variable declarators', async () => {
    const content = `
const greet = () => {
  return 'hi'
}

const add = (a: number, b: number) => a + b
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.name === 'greet' && s.kind === 'function')).toBe(true)
    expect(symbols.some(s => s.name === 'add' && s.kind === 'function')).toBe(true)
  })

  it('should extract class declarations', async () => {
    const content = `
class Animal {
  name: string
  
  constructor(name: string) {
    this.name = name
  }
  
  speak() {
    console.log(this.name)
  }
}
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.some(s => s.name === 'Animal' && s.kind === 'class')).toBe(true)
    expect(symbols.some(s => s.name === 'Animal.speak' && s.kind === 'method')).toBe(true)
  })

  it('should extract interface declarations', async () => {
    const content = `
interface User {
  id: number
  name: string
}

interface Admin extends User {
  permissions: string[]
}
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.some(s => s.name === 'User' && s.kind === 'interface')).toBe(true)
    expect(symbols.some(s => s.name === 'Admin' && s.kind === 'interface')).toBe(true)
  })

  it('should detect exported symbols', async () => {
    const content = `
export function publicFunc() {}

function privateFunc() {}

export class PublicClass {}

class PrivateClass {}

export interface PublicInterface {}

interface PrivateInterface {}
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    const publicFunc = symbols.find(s => s.name === 'publicFunc')
    const privateFunc = symbols.find(s => s.name === 'privateFunc')
    const publicClass = symbols.find(s => s.name === 'PublicClass')
    const privateClass = symbols.find(s => s.name === 'PrivateClass')
    
    expect(publicFunc?.exported).toBe(true)
    expect(privateFunc?.exported).toBe(false)
    expect(publicClass?.exported).toBe(true)
    expect(privateClass?.exported).toBe(false)
  })

  it('should track line numbers correctly', async () => {
    const content = `// line 1
// line 2
function myFunc() { // line 3
  // line 4
} // line 5
// line 6
class MyClass { // line 7
  // line 8
} // line 9
`
    const symbols = await parseSymbols('/test/file.ts', content, 'ts')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    const func = symbols.find(s => s.name === 'myFunc')
    const cls = symbols.find(s => s.name === 'MyClass')
    
    expect(func?.startLine).toBe(3)
    expect(cls?.startLine).toBe(7)
  })
})

describe('parseSymbols - JavaScript', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should extract function declarations', async () => {
    const content = `
function hello() {
  console.log('hello')
}

function world(name) {
  return 'world ' + name
}
`
    const symbols = await parseSymbols('/test/file.js', content, 'js')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.name === 'hello' && s.kind === 'function')).toBe(true)
    expect(symbols.some(s => s.name === 'world' && s.kind === 'function')).toBe(true)
  })

  it('should extract arrow functions', async () => {
    const content = `
const greet = () => {
  return 'hi'
}

const add = (a, b) => a + b
`
    const symbols = await parseSymbols('/test/file.js', content, 'js')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.name === 'greet' && s.kind === 'function')).toBe(true)
    expect(symbols.some(s => s.name === 'add' && s.kind === 'function')).toBe(true)
  })

  it('should extract class declarations with methods', async () => {
    const content = `
class Calculator {
  constructor() {
    this.value = 0
  }
  
  add(n) {
    this.value += n
    return this
  }
  
  subtract(n) {
    this.value -= n
    return this
  }
}
`
    const symbols = await parseSymbols('/test/file.js', content, 'js')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.some(s => s.name === 'Calculator' && s.kind === 'class')).toBe(true)
    expect(symbols.some(s => s.name === 'Calculator.add' && s.kind === 'method')).toBe(true)
    expect(symbols.some(s => s.name === 'Calculator.subtract' && s.kind === 'method')).toBe(true)
  })
})

describe('parseSymbols - Python', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should extract function definitions', async () => {
    const content = `
def hello():
    print('hello')

def world(name):
    return 'world ' + name
`
    const symbols = await parseSymbols('/test/file.py', content, 'python')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.name === 'hello' && s.kind === 'function')).toBe(true)
    expect(symbols.some(s => s.name === 'world' && s.kind === 'function')).toBe(true)
  })

  it('should extract class definitions with methods', async () => {
    const content = `
class Animal:
    def __init__(self, name):
        self.name = name
    
    def speak(self):
        print(self.name)
    
    def _private_method(self):
        pass
`
    const symbols = await parseSymbols('/test/file.py', content, 'python')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    expect(symbols.some(s => s.name === 'Animal' && s.kind === 'class')).toBe(true)
    expect(symbols.some(s => s.name === 'Animal.__init__' && s.kind === 'method')).toBe(true)
    expect(symbols.some(s => s.name === 'Animal.speak' && s.kind === 'method')).toBe(true)
    expect(symbols.some(s => s.name === 'Animal._private_method' && s.kind === 'method')).toBe(true)
  })

  it('should detect exported vs private symbols', async () => {
    const content = `
def public_func():
    pass

def _private_func():
    pass

class PublicClass:
    pass

class _PrivateClass:
    pass
`
    const symbols = await parseSymbols('/test/file.py', content, 'python')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    const publicFunc = symbols.find(s => s.name === 'public_func')
    const privateFunc = symbols.find(s => s.name === '_private_func')
    const publicClass = symbols.find(s => s.name === 'PublicClass')
    const privateClass = symbols.find(s => s.name === '_PrivateClass')
    
    expect(publicFunc?.exported).toBe(true)
    expect(privateFunc?.exported).toBe(false)
    expect(publicClass?.exported).toBe(true)
    expect(privateClass?.exported).toBe(false)
  })

  it('should distinguish module-level functions from methods', async () => {
    const content = `
def module_func():
    pass

class MyClass:
    def method(self):
        pass
`
    const symbols = await parseSymbols('/test/file.py', content, 'python')
    
    if (!isTreeSitterAvailable()) {
      expect(symbols).toHaveLength(0)
      return
    }
    
    const moduleFunc = symbols.find(s => s.name === 'module_func')
    const method = symbols.find(s => s.name === 'MyClass.method')
    
    expect(moduleFunc?.kind).toBe('function')
    expect(method?.kind).toBe('method')
  })
})

describe('resolveCallEdges', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should extract call expressions and resolve to symbol table', async () => {
    const content = `
function main() {
  helper()
  utils.process()
  unknownFunc()
}
`
    const symbolTable: SymbolTable = new Map([
      ['helper', [{ filePath: '/test/helper.ts', kind: 'function' }]],
      ['process', [{ filePath: '/test/utils.ts', kind: 'function' }]],
    ])
    
    const edges = await resolveCallEdges('/test/main.ts', content, 'ts', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    expect(edges.length).toBeGreaterThan(0)
    
    const helperEdge = edges.find(e => e.targetName === 'helper')
    expect(helperEdge).toBeDefined()
    expect(helperEdge?.targetFilePath).toBe('/test/helper.ts')
    expect(helperEdge?.confidence).toBe(1.0)
    
    const unknownEdge = edges.find(e => e.targetName === 'unknownFunc')
    expect(unknownEdge).toBeDefined()
    expect(unknownEdge?.targetFilePath).toBeUndefined()
    expect(unknownEdge?.confidence).toBe(0.6)
  })

  it('should prefer same-file targets with lower confidence', async () => {
    const content = `
function main() {
  helper()
}

function helper() {
  return 'local'
}
`
    const symbolTable: SymbolTable = new Map([
      ['helper', [
        { filePath: '/test/main.ts', kind: 'function' },
        { filePath: '/test/other.ts', kind: 'function' },
      ]],
    ])
    
    const edges = await resolveCallEdges('/test/main.ts', content, 'ts', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    const helperEdge = edges.find(e => e.targetName === 'helper')
    expect(helperEdge).toBeDefined()
    expect(helperEdge?.targetFilePath).toBe('/test/main.ts')
    expect(helperEdge?.confidence).toBe(0.8)
  })

  it('should handle Python call expressions', async () => {
    const content = `
def main():
    helper()
    utils.process()
`
    const symbolTable: SymbolTable = new Map([
      ['helper', [{ filePath: '/test/helper.py', kind: 'function' }]],
    ])
    
    const edges = await resolveCallEdges('/test/main.py', content, 'python', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    expect(edges.length).toBeGreaterThan(0)
  })
})

describe('resolveHeritageEdges', () => {
  beforeAll(async () => {
    await waitForInit()
  })

  it('should extract extends clauses in TypeScript', async () => {
    const content = `
class Animal {
  name: string
}

class Dog extends Animal {
  bark() {}
}
`
    const symbolTable: SymbolTable = new Map([
      ['Animal', [{ filePath: '/test/animal.ts', kind: 'class' }]],
    ])
    
    const edges = await resolveHeritageEdges('/test/dog.ts', content, 'ts', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    const extendsEdge = edges.find(e => e.sourceName === 'Dog' && e.targetName === 'Animal')
    expect(extendsEdge).toBeDefined()
    expect(extendsEdge?.edgeType).toBe('EXTENDS')
    expect(extendsEdge?.confidence).toBe(1.0)
  })

  it('should extract implements clauses in TypeScript', async () => {
    const content = `
interface Runnable {
  run(): void
}

interface Stoppable {
  stop(): void
}

class Service implements Runnable, Stoppable {
  run() {}
  stop() {}
}
`
    const symbolTable: SymbolTable = new Map([
      ['Runnable', [{ filePath: '/test/interfaces.ts', kind: 'interface' }]],
      ['Stoppable', [{ filePath: '/test/interfaces.ts', kind: 'interface' }]],
    ])
    
    const edges = await resolveHeritageEdges('/test/service.ts', content, 'ts', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    const runnableEdge = edges.find(e => e.sourceName === 'Service' && e.targetName === 'Runnable')
    const stoppableEdge = edges.find(e => e.sourceName === 'Service' && e.targetName === 'Stoppable')
    
    expect(runnableEdge).toBeDefined()
    expect(runnableEdge?.edgeType).toBe('IMPLEMENTS')
    expect(stoppableEdge).toBeDefined()
    expect(stoppableEdge?.edgeType).toBe('IMPLEMENTS')
  })

  it('should extract Python class inheritance', async () => {
    const content = `
class Animal:
    pass

class Dog(Animal):
    def bark(self):
        pass

class Cat(Animal):
    def meow(self):
        pass
`
    const symbolTable: SymbolTable = new Map([
      ['Animal', [{ filePath: '/test/animal.py', kind: 'class' }]],
    ])
    
    const edges = await resolveHeritageEdges('/test/pets.py', content, 'python', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    const dogEdge = edges.find(e => e.sourceName === 'Dog' && e.targetName === 'Animal')
    const catEdge = edges.find(e => e.sourceName === 'Cat' && e.targetName === 'Animal')
    
    expect(dogEdge).toBeDefined()
    expect(dogEdge?.edgeType).toBe('EXTENDS')
    expect(catEdge).toBeDefined()
    expect(catEdge?.edgeType).toBe('EXTENDS')
  })

  it('should handle multiple inheritance in Python', async () => {
    const content = `
class Mixin1:
    pass

class Mixin2:
    pass

class Combined(Mixin1, Mixin2):
    pass
`
    const symbolTable: SymbolTable = new Map([
      ['Mixin1', [{ filePath: '/test/mixins.py', kind: 'class' }]],
      ['Mixin2', [{ filePath: '/test/mixins.py', kind: 'class' }]],
    ])
    
    const edges = await resolveHeritageEdges('/test/combined.py', content, 'python', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    const mixin1Edge = edges.find(e => e.sourceName === 'Combined' && e.targetName === 'Mixin1')
    const mixin2Edge = edges.find(e => e.sourceName === 'Combined' && e.targetName === 'Mixin2')
    
    expect(mixin1Edge).toBeDefined()
    expect(mixin2Edge).toBeDefined()
  })

  it('should skip object base class in Python', async () => {
    const content = `
class MyClass(object):
    pass
`
    const symbolTable: SymbolTable = new Map()
    
    const edges = await resolveHeritageEdges('/test/myclass.py', content, 'python', symbolTable)
    
    if (!isTreeSitterAvailable()) {
      expect(edges).toHaveLength(0)
      return
    }
    
    expect(edges.filter(e => e.targetName === 'object')).toHaveLength(0)
  })
})

describe('graceful fallback', () => {
  it('should return empty arrays when tree-sitter is not available', async () => {
    await waitForInit()
    
    const symbols = await parseSymbols('/test/file.ts', 'function test() {}', 'ts')
    const callEdges = await resolveCallEdges('/test/file.ts', 'test()', 'ts', new Map())
    const heritageEdges = await resolveHeritageEdges('/test/file.ts', 'class A extends B {}', 'ts', new Map())
    
    expect(Array.isArray(symbols)).toBe(true)
    expect(Array.isArray(callEdges)).toBe(true)
    expect(Array.isArray(heritageEdges)).toBe(true)
  })

  it('should handle unsupported languages gracefully', async () => {
    await waitForInit()
    
    const symbols = await parseSymbols('/test/file.rb', 'def test; end', 'ruby' as 'ts')
    expect(symbols).toHaveLength(0)
  })
})
