const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = '/root/.nano-brain/data/app-f53b52ad6d21.sqlite';
const FLOWS_DIR = '/Users/tamlh/workspaces/NUSTechnology/Projects/zengamingx/.agents/_flows';
const PROJECT_HASH = 'd1915ee19311';

const db = new Database(DB_PATH);

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS doc_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    flow_type TEXT NOT NULL DEFAULT 'doc_flow',
    description TEXT,
    services TEXT,
    source_file TEXT,
    last_updated TEXT,
    project_hash TEXT NOT NULL DEFAULT 'global'
  );
  CREATE INDEX IF NOT EXISTS idx_doc_flows_project ON doc_flows(project_hash);
`);

// Clear existing
const deleted = db.prepare('DELETE FROM doc_flows WHERE project_hash = ?').run(PROJECT_HASH);
console.log('Deleted existing:', deleted.changes);

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return [{}, content];
  const end = content.indexOf('\n---', 3);
  if (end === -1) return [{}, content];
  const yamlStr = content.slice(3, end).trim();
  const data = {};
  for (const line of yamlStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    data[key] = val.replace(/^["']|["']$/g, '');
  }
  return [data, content.slice(end + 4).trim()];
}

const insertStmt = db.prepare(`
  INSERT INTO doc_flows (label, flow_type, description, services, source_file, last_updated, project_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let count = 0;
const files = fs.readdirSync(FLOWS_DIR)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .sort();

console.log(`Found ${files.length} markdown files`);

const insertMany = db.transaction((files) => {
  for (const file of files) {
    const filePath = path.join(FLOWS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const [fm] = parseFrontmatter(content);

    const label = fm.title || file.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const flowType = fm.flow_type || fm.type || 'doc_flow';
    const description = fm.description || null;
    const services = fm.services || null;
    const lastUpdated = fm.last_updated || null;

    insertStmt.run(label, flowType, description, services, filePath, lastUpdated, PROJECT_HASH);
    count++;
  }
});

insertMany(files);

const verified = db.prepare('SELECT COUNT(*) as cnt FROM doc_flows WHERE project_hash = ?').get(PROJECT_HASH);
console.log(`Inserted: ${count}, Verified in DB: ${verified.cnt}`);

db.close();
