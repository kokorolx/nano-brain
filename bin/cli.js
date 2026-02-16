#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entry = join(__dirname, '..', 'src', 'index.ts');
const tsxBin = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const args = process.argv.slice(2);

try {
  execFileSync(tsxBin, [entry, ...args], { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
