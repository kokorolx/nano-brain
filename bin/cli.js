#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);

// Prefer the pre-compiled dist/index.js — works on any platform without esbuild.
// Fall back to tsx (TypeScript source) only when dist is absent (e.g. dev checkout
// without a build step).
const distEntry = join(__dirname, '..', 'dist', 'cli', 'index.js');

if (existsSync(distEntry)) {
  // Run compiled JS directly — no tsx / esbuild dependency at all.
  try {
    execFileSync('node', [distEntry, ...args], { stdio: 'inherit' });
  } catch (err) {
    if (err.message && !err.status) {
      console.error('nano-brain: failed to start —', err.message);
    }
    process.exit(err.status || 1);
  }
} else {
  // Dev fallback: run TypeScript source via tsx.
  const tsEntry = join(__dirname, '..', 'src', 'index.ts');
  let tsxBin;
  try {
    const require = createRequire(join(__dirname, '..', 'package.json'));
    tsxBin = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  } catch {
    tsxBin = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  }

  try {
    execFileSync('node', [tsxBin, tsEntry, ...args], { stdio: 'inherit' });
  } catch (err) {
    if (err.message && !err.status) {
      console.error('nano-brain: failed to start —', err.message);
    }
    process.exit(err.status || 1);
  }
}
