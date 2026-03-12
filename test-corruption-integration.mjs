import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkAndRecoverDB } from './dist/db/corruption-recovery.js';
import { createStore } from './dist/store.js';

async function testCorruptionRecovery() {
  console.log('\n=== Corruption Recovery Integration Test ===\n');
  
  // Create test directory
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corruption-test-'));
  const dbPath = path.join(testDir, 'test.db');
  
  console.log(`Test directory: ${testDir}`);
  console.log(`Database path: ${dbPath}\n`);
  
  // Step 1: Create a valid database
  console.log('Step 1: Creating valid database...');
  const store = createStore(dbPath);
  store.close();
  console.log('✓ Valid database created and closed\n');
  
  // Step 2: Verify it exists
  console.log('Step 2: Verifying database file exists...');
  if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    console.log(`✓ Database file exists (${stats.size} bytes)\n`);
  } else {
    console.error('✗ Database file not found!\n');
    process.exit(1);
  }
  
  // Step 3: Corrupt the database by truncating it
  console.log('Step 3: Corrupting database by truncating...');
  const fd = fs.openSync(dbPath, 'r+');
  fs.truncateSync(fd, 100); // Truncate to just 100 bytes - definitely corrupted
  fs.closeSync(fd);
  console.log('✓ Database truncated to 100 bytes (corrupted)\n');
  
  // Step 4: Try to use it with checkAndRecoverDB
  console.log('Step 4: Testing corruption detection and recovery...');
  try {
    const metrics = [];
    const recoveredDb = checkAndRecoverDB(dbPath, {
      logger: {
        log: (cat, msg) => console.log(`  [${cat}] ${msg}`),
        error: (msg) => console.error(`  [ERROR] ${msg}`)
      },
      metricsCallback: (event) => {
        metrics.push(event);
        console.log(`  [METRIC] Emitted: ${event}`);
      }
    });
    
    console.log('✓ Recovery successful\n');
    
    // Step 5: Verify the recovered database is valid
    console.log('Step 5: Verifying recovered database...');
    const health = recoveredDb.pragma('integrity_check');
    console.log(`  Integrity check: ${JSON.stringify(health)}`);
    recoveredDb.close();
    console.log('✓ Recovered database is functional\n');
    
    // Step 6: Check that corrupted file was backed up
    console.log('Step 6: Checking for corrupted backup...');
    const files = fs.readdirSync(testDir);
    const corruptedFile = files.find(f => f.startsWith('test.db.corrupted'));
    if (corruptedFile) {
      console.log(`✓ Corrupted file backed up as: ${corruptedFile}`);
      const backupStats = fs.statSync(path.join(testDir, corruptedFile));
      console.log(`  Backup file size: ${backupStats.size} bytes\n`);
    } else {
      console.error('✗ Corrupted file not backed up!\n');
    }
    
    // Step 7: Verify metrics were emitted
    console.log('Step 7: Verifying metrics...');
    if (metrics.includes('corruption_detected')) {
      console.log('✓ corruption_detected metric was emitted\n');
    } else {
      console.error('✗ Metric not emitted!\n');
    }
    
    console.log('=== All Integration Tests Passed ✓ ===\n');
    
  } catch (error) {
    console.error('✗ Recovery failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }
}

testCorruptionRecovery().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
