import { describe, it, expect } from 'vitest';
import { inferLanguage, findSourceCodeBreakPoints, chunkSourceCode } from '../src/chunker.js';

describe('inferLanguage', () => {
  it('should detect TypeScript from .ts extension', () => {
    expect(inferLanguage('/path/to/file.ts')).toBe('typescript');
  });

  it('should detect TypeScript from .tsx extension', () => {
    expect(inferLanguage('/path/to/component.tsx')).toBe('typescript');
  });

  it('should detect JavaScript from .js extension', () => {
    expect(inferLanguage('/path/to/file.js')).toBe('javascript');
  });

  it('should detect JavaScript from .jsx extension', () => {
    expect(inferLanguage('/path/to/component.jsx')).toBe('javascript');
  });

  it('should detect JavaScript from .mjs extension', () => {
    expect(inferLanguage('/path/to/module.mjs')).toBe('javascript');
  });

  it('should detect JavaScript from .cjs extension', () => {
    expect(inferLanguage('/path/to/module.cjs')).toBe('javascript');
  });

  it('should detect Python from .py extension', () => {
    expect(inferLanguage('/path/to/script.py')).toBe('python');
  });

  it('should detect Python from .pyi extension', () => {
    expect(inferLanguage('/path/to/types.pyi')).toBe('python');
  });

  it('should detect Go from .go extension', () => {
    expect(inferLanguage('/path/to/main.go')).toBe('go');
  });

  it('should detect Rust from .rs extension', () => {
    expect(inferLanguage('/path/to/lib.rs')).toBe('rust');
  });

  it('should detect Java from .java extension', () => {
    expect(inferLanguage('/path/to/Main.java')).toBe('java');
  });

  it('should detect Kotlin from .kt extension', () => {
    expect(inferLanguage('/path/to/Main.kt')).toBe('kotlin');
  });

  it('should detect Ruby from .rb extension', () => {
    expect(inferLanguage('/path/to/app.rb')).toBe('ruby');
  });

  it('should detect C from .c extension', () => {
    expect(inferLanguage('/path/to/main.c')).toBe('c');
  });

  it('should detect C from .h extension', () => {
    expect(inferLanguage('/path/to/header.h')).toBe('c');
  });

  it('should detect C++ from .cpp extension', () => {
    expect(inferLanguage('/path/to/main.cpp')).toBe('cpp');
  });

  it('should detect C# from .cs extension', () => {
    expect(inferLanguage('/path/to/Program.cs')).toBe('csharp');
  });

  it('should detect Swift from .swift extension', () => {
    expect(inferLanguage('/path/to/App.swift')).toBe('swift');
  });

  it('should detect PHP from .php extension', () => {
    expect(inferLanguage('/path/to/index.php')).toBe('php');
  });

  it('should detect Bash from .sh extension', () => {
    expect(inferLanguage('/path/to/script.sh')).toBe('bash');
  });

  it('should detect JSON from .json extension', () => {
    expect(inferLanguage('/path/to/config.json')).toBe('json');
  });

  it('should detect YAML from .yaml extension', () => {
    expect(inferLanguage('/path/to/config.yaml')).toBe('yaml');
  });

  it('should detect YAML from .yml extension', () => {
    expect(inferLanguage('/path/to/config.yml')).toBe('yaml');
  });

  it('should detect Markdown from .md extension', () => {
    expect(inferLanguage('/path/to/README.md')).toBe('markdown');
  });

  it('should detect SQL from .sql extension', () => {
    expect(inferLanguage('/path/to/query.sql')).toBe('sql');
  });

  it('should detect HTML from .html extension', () => {
    expect(inferLanguage('/path/to/index.html')).toBe('html');
  });

  it('should detect CSS from .css extension', () => {
    expect(inferLanguage('/path/to/styles.css')).toBe('css');
  });

  it('should detect Vue from .vue extension', () => {
    expect(inferLanguage('/path/to/Component.vue')).toBe('vue');
  });

  it('should detect Svelte from .svelte extension', () => {
    expect(inferLanguage('/path/to/Component.svelte')).toBe('svelte');
  });

  it('should return text for unknown extension', () => {
    expect(inferLanguage('/path/to/file.xyz')).toBe('text');
  });

  it('should return text for no extension', () => {
    expect(inferLanguage('/path/to/Makefile')).toBe('text');
  });

  it('should be case insensitive', () => {
    expect(inferLanguage('/path/to/file.TS')).toBe('typescript');
    expect(inferLanguage('/path/to/file.PY')).toBe('python');
  });
});

describe('findSourceCodeBreakPoints', () => {
  it('should detect blank lines with score 40', () => {
    const content = 'line1\n\nline3';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const blank = breakPoints.find(bp => bp.type === 'blank');
    expect(blank).toBeDefined();
    expect(blank?.score).toBe(40);
    expect(blank?.lineNo).toBe(2);
  });

  it('should detect double blank lines with score 90', () => {
    const content = 'line1\n\n\nline4';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const doubleBlank = breakPoints.find(bp => bp.type === 'double-blank');
    expect(doubleBlank).toBeDefined();
    expect(doubleBlank?.score).toBe(90);
  });

  it('should detect function definitions with score 80', () => {
    const content = 'function myFunc() {\n  return 1;\n}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
    expect(funcDef?.score).toBe(80);
    expect(funcDef?.lineNo).toBe(1);
  });

  it('should detect export function definitions', () => {
    const content = 'export function myFunc() {}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect async function definitions', () => {
    const content = 'async function fetchData() {}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect export async function definitions', () => {
    const content = 'export async function fetchData() {}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect arrow function assignments', () => {
    const content = 'const myFunc = () => {};';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect class definitions', () => {
    const content = 'class MyClass {\n  constructor() {}\n}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const classDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(classDef).toBeDefined();
  });

  it('should detect export class definitions', () => {
    const content = 'export class MyClass {}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const classDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(classDef).toBeDefined();
  });

  it('should detect interface definitions', () => {
    const content = 'interface MyInterface {\n  prop: string;\n}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const interfaceDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(interfaceDef).toBeDefined();
  });

  it('should detect type definitions', () => {
    const content = 'type MyType = string | number;';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const typeDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(typeDef).toBeDefined();
  });

  it('should detect Python def statements', () => {
    const content = 'def my_function():\n    pass';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect Python class statements', () => {
    const content = 'class MyClass:\n    pass';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const classDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(classDef).toBeDefined();
  });

  it('should detect Go func statements', () => {
    const content = 'func main() {\n}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect Rust fn statements', () => {
    const content = 'fn main() {\n}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect Rust pub fn statements', () => {
    const content = 'pub fn my_function() {}';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const funcDef = breakPoints.find(bp => bp.type === 'function-def');
    expect(funcDef).toBeDefined();
  });

  it('should detect import statements with score 60', () => {
    const content = "import { foo } from 'bar';";
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const importStmt = breakPoints.find(bp => bp.type === 'import-export');
    expect(importStmt).toBeDefined();
    expect(importStmt?.score).toBe(60);
  });

  it('should detect export statements', () => {
    const content = "export { foo };";
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const exportStmt = breakPoints.find(bp => bp.type === 'import-export');
    expect(exportStmt).toBeDefined();
  });

  it('should detect require statements at line start', () => {
    const content = "require('bar');";
    const breakPoints = findSourceCodeBreakPoints(content);
    const requireStmt = breakPoints.find(bp => bp.type === 'import-export');
    expect(requireStmt).toBeDefined();
  });

  it('should detect module.exports', () => {
    const content = 'module.exports = foo;';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const moduleExports = breakPoints.find(bp => bp.type === 'import-export');
    expect(moduleExports).toBeDefined();
  });

  it('should detect Rust use statements', () => {
    const content = 'use std::io;';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const useStmt = breakPoints.find(bp => bp.type === 'import-export');
    expect(useStmt).toBeDefined();
  });

  it('should detect regular lines with score 1', () => {
    const content = 'const x = 1;';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    const line = breakPoints.find(bp => bp.type === 'line');
    expect(line).toBeDefined();
    expect(line?.score).toBe(1);
  });

  it('should calculate correct positions', () => {
    const content = 'line1\nline2\nline3';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    expect(breakPoints[0].pos).toBe(0);
    expect(breakPoints[1].pos).toBe(6);
    expect(breakPoints[2].pos).toBe(12);
  });

  it('should assign correct line numbers', () => {
    const content = 'line1\nline2\nline3';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    expect(breakPoints[0].lineNo).toBe(1);
    expect(breakPoints[1].lineNo).toBe(2);
    expect(breakPoints[2].lineNo).toBe(3);
  });

  it('should handle empty content', () => {
    const content = '';
    const breakPoints = findSourceCodeBreakPoints(content);
    
    expect(breakPoints.length).toBe(1);
    expect(breakPoints[0].type).toBe('blank');
  });

  it('should handle content with only whitespace', () => {
    const content = '\n\n';
    const breakPoints = findSourceCodeBreakPoints(content);
    const blanks = breakPoints.filter(bp => bp.type === 'blank' || bp.type === 'double-blank');
    expect(blanks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('chunkSourceCode', () => {
  it('should return single chunk for short content', () => {
    const content = 'const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/file.ts', '/workspace');
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].hash).toBe(hash);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].pos).toBe(0);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('should include metadata header', () => {
    const content = 'const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/src/file.ts', '/workspace');
    
    expect(chunks[0].text).toContain('File: src/file.ts');
    expect(chunks[0].text).toContain('Language: typescript');
    expect(chunks[0].text).toContain('Lines: 1-1');
  });

  it('should use relative path in metadata', () => {
    const content = 'const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/deep/nested/file.ts', '/workspace');
    
    expect(chunks[0].text).toContain('File: deep/nested/file.ts');
  });

  it('should detect correct language in metadata', () => {
    const pyContent = 'def foo(): pass';
    const chunks = chunkSourceCode(pyContent, 'hash', '/workspace/script.py', '/workspace');
    
    expect(chunks[0].text).toContain('Language: python');
  });

  it('should handle empty content', () => {
    const content = '';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/file.ts', '/workspace');
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('File:');
  });

  it('should handle single line content', () => {
    const content = 'export const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/file.ts', '/workspace');
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('should handle content with only newlines', () => {
    const content = '\n\n\n\n\n';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/file.ts', '/workspace');
    
    expect(chunks.length).toBe(1);
  });

  it('should handle file at workspace root', () => {
    const content = 'const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/file.ts', '/workspace');
    
    expect(chunks[0].text).toContain('File: file.ts');
  });

  it('should handle deeply nested file', () => {
    const content = 'const x = 1;';
    const hash = 'test-hash';
    const chunks = chunkSourceCode(content, hash, '/workspace/a/b/c/d/file.ts', '/workspace');
    
    expect(chunks[0].text).toContain('File: a/b/c/d/file.ts');
  });

  it('should handle different file types correctly', () => {
    const testCases = [
      { path: '/workspace/file.py', lang: 'python' },
      { path: '/workspace/file.go', lang: 'go' },
      { path: '/workspace/file.rs', lang: 'rust' },
      { path: '/workspace/file.java', lang: 'java' },
    ];
    
    for (const tc of testCases) {
      const chunks = chunkSourceCode('code', 'hash', tc.path, '/workspace');
      expect(chunks[0].text).toContain(`Language: ${tc.lang}`);
    }
  });
});
