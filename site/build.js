#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, watchFile, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SITE_DIR = __dirname
const ROOT_DIR = resolve(SITE_DIR, '..')
const PARTIALS_DIR = join(SITE_DIR, 'partials')
const OUTPUT = join(ROOT_DIR, 'index.html')

function readFile(path) {
  return readFileSync(path, 'utf-8')
}

function build() {
  const start = Date.now()

  let shell = readFile(join(SITE_DIR, 'shell.html'))
  const styles = readFile(join(SITE_DIR, 'styles.css'))
  const script = readFile(join(SITE_DIR, 'script.js'))

  shell = shell.replace('{{styles}}', styles)
  shell = shell.replace('{{script}}', script)

  shell = shell.replace(/\{\{partial:([a-z0-9-]+)\}\}/g, (_match, name) => {
    const partialPath = join(PARTIALS_DIR, `_${name}.html`)
    try {
      return readFile(partialPath).trimEnd()
    } catch (err) {
      console.error(`  ❌ Missing partial: ${partialPath}`)
      process.exit(1)
    }
  })

  writeFileSync(OUTPUT, shell, 'utf-8')

  const size = statSync(OUTPUT).size
  const kb = (size / 1024).toFixed(1)
  const ms = Date.now() - start
  console.log(`  ✅ Built index.html (${kb} KB) in ${ms}ms`)
}

console.log('🔨 Building opencode-memory landing page...')
build()

if (process.argv.includes('--watch')) {
  console.log('👀 Watching for changes...')

  const watchTargets = [
    join(SITE_DIR, 'shell.html'),
    join(SITE_DIR, 'styles.css'),
    join(SITE_DIR, 'script.js'),
    ...readdirSync(PARTIALS_DIR).map((f) => join(PARTIALS_DIR, f)),
  ]

  for (const file of watchTargets) {
    watchFile(file, { interval: 300 }, () => {
      console.log(`  🔄 Changed: ${file.replace(ROOT_DIR + '/', '')}`)
      build()
    })
  }
}
