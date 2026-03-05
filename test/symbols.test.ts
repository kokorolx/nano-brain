import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { extractSymbols } from '../src/symbols.js'
import { createStore } from '../src/store.js'
import { indexCodebase } from '../src/codebase.js'
import type { Store, CodebaseConfig } from '../src/types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('extractSymbols - Redis keys', () => {
  it('should extract Redis get operations as read', () => {
    const content = `
const value = await redis.get('user:123')
const hash = await redisClient.hget('session:abc', 'data')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const redisSymbols = symbols.filter(s => s.type === 'redis_key')
    expect(redisSymbols.length).toBeGreaterThanOrEqual(2)
    expect(redisSymbols.some(s => s.pattern === 'user:123' && s.operation === 'read')).toBe(true)
    expect(redisSymbols.some(s => s.pattern === 'session:abc' && s.operation === 'read')).toBe(true)
  })

  it('should extract Redis set operations as write', () => {
    const content = `
await redis.set('user:123', 'value')
await redisClient.hset('session:abc', 'data', 'value')
await cache.del('temp:key')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const redisSymbols = symbols.filter(s => s.type === 'redis_key')
    expect(redisSymbols.length).toBeGreaterThanOrEqual(3)
    expect(redisSymbols.some(s => s.pattern === 'user:123' && s.operation === 'write')).toBe(true)
    expect(redisSymbols.some(s => s.pattern === 'session:abc' && s.operation === 'write')).toBe(true)
    expect(redisSymbols.some(s => s.pattern === 'temp:key' && s.operation === 'write')).toBe(true)
  })

  it('should convert template literals to wildcards', () => {
    const content = `
const key = await redis.get(\`sinv:\${botIndex}:compressed\`)
await redis.set(\`cinv:\${steamId}:\${gameId}:compressed\`, data)
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const redisSymbols = symbols.filter(s => s.type === 'redis_key')
    expect(redisSymbols.some(s => s.pattern === 'sinv:*:compressed')).toBe(true)
    expect(redisSymbols.some(s => s.pattern === 'cinv:*:*:compressed')).toBe(true)
  })

  it('should extract Ruby Redis operations with interpolation', () => {
    const content = `
value = Redis.current.get("ud:#{token}")
REDIS.hget("insight_chart:#{game_id}:#{slug}", "data")
`
    const symbols = extractSymbols('/test/file.rb', content, 'ruby')
    
    const redisSymbols = symbols.filter(s => s.type === 'redis_key')
    expect(redisSymbols.some(s => s.pattern === 'ud:*')).toBe(true)
    expect(redisSymbols.some(s => s.pattern === 'insight_chart:*:*')).toBe(true)
  })

  it('should track line numbers correctly', () => {
    const content = `line1
line2
const value = await redis.get('mykey')
line4`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const redisSymbol = symbols.find(s => s.pattern === 'mykey')
    expect(redisSymbol).toBeDefined()
    expect(redisSymbol!.lineNumber).toBe(3)
  })
})

describe('extractSymbols - PubSub channels', () => {
  it('should extract publish operations', () => {
    const content = `
await redis.publish('notifications', message)
pubsub.publish('events:user', data)
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const pubsubSymbols = symbols.filter(s => s.type === 'pubsub_channel')
    expect(pubsubSymbols.some(s => s.pattern === 'notifications' && s.operation === 'publish')).toBe(true)
    expect(pubsubSymbols.some(s => s.pattern === 'events:user' && s.operation === 'publish')).toBe(true)
  })

  it('should extract subscribe operations', () => {
    const content = `
await redis.subscribe('notifications')
client.psubscribe('events:*')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const pubsubSymbols = symbols.filter(s => s.type === 'pubsub_channel')
    expect(pubsubSymbols.some(s => s.pattern === 'notifications' && s.operation === 'subscribe')).toBe(true)
    expect(pubsubSymbols.some(s => s.pattern === 'events:*' && s.operation === 'subscribe')).toBe(true)
  })
})

describe('extractSymbols - MySQL tables', () => {
  it('should extract tables from raw SQL SELECT', () => {
    const content = `
const users = await db.query('SELECT * FROM users WHERE id = ?')
const orders = await db.query('SELECT o.* FROM orders o JOIN users u ON o.user_id = u.id')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'users' && s.operation === 'read')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'orders' && s.operation === 'read')).toBe(true)
  })

  it('should extract tables from INSERT/UPDATE/DELETE', () => {
    const content = `
await db.query('INSERT INTO users (name) VALUES (?)')
await db.query('UPDATE orders SET status = ?')
await db.query('DELETE FROM sessions WHERE expired = 1')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'users' && s.operation === 'write')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'orders' && s.operation === 'write')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'sessions' && s.operation === 'write')).toBe(true)
  })

  it('should extract Prisma model operations', () => {
    const content = `
const users = await prisma.user.findMany()
await prisma.orderItem.create({ data: {} })
const count = await prisma.userProfile.count()
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'user' && s.operation === 'read')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'order_item' && s.operation === 'write')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'user_profile' && s.operation === 'read')).toBe(true)
  })

  it('should extract Sequelize model definitions', () => {
    const content = `
const User = sequelize.define('users', { name: DataTypes.STRING })
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'users' && s.operation === 'define')).toBe(true)
  })

  it('should extract TypeORM Entity decorators', () => {
    const content = `
@Entity('user_profiles')
class UserProfile {
  @Column()
  name: string
}
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'user_profiles' && s.operation === 'define')).toBe(true)
  })

  it('should extract Rails ActiveRecord models with pluralization', () => {
    const content = `
class User < ApplicationRecord
  has_many :orders
end

class OrderItem < ActiveRecord::Base
end
`
    const symbols = extractSymbols('/test/file.rb', content, 'ruby')
    
    const tableSymbols = symbols.filter(s => s.type === 'mysql_table')
    expect(tableSymbols.some(s => s.pattern === 'users' && s.operation === 'define')).toBe(true)
    expect(tableSymbols.some(s => s.pattern === 'order_items' && s.operation === 'define')).toBe(true)
  })
})

describe('extractSymbols - API endpoints', () => {
  it('should extract Express routes', () => {
    const content = `
app.get('/api/users', handler)
app.post('/api/orders', createOrder)
router.delete('/api/sessions/:id', deleteSession)
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const apiSymbols = symbols.filter(s => s.type === 'api_endpoint')
    expect(apiSymbols.some(s => s.pattern === '/api/users' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/api/orders' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/api/sessions/:id' && s.operation === 'define')).toBe(true)
  })

  it('should extract NestJS decorators with controller prefix', () => {
    const content = `
@Controller('/users')
class UsersController {
  @Get()
  findAll() {}
  
  @Post('/create')
  create() {}
  
  @Get('/:id')
  findOne() {}
}
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const apiSymbols = symbols.filter(s => s.type === 'api_endpoint')
    expect(apiSymbols.some(s => s.pattern === '/users' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/users/create' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/users/:id' && s.operation === 'define')).toBe(true)
  })

  it('should extract Rails routes', () => {
    const content = `
get '/api/users', to: 'users#index'
post '/api/orders', to: 'orders#create'
resources :products
`
    const symbols = extractSymbols('/test/routes.rb', content, 'ruby')
    
    const apiSymbols = symbols.filter(s => s.type === 'api_endpoint')
    expect(apiSymbols.some(s => s.pattern === '/api/users' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/api/orders' && s.operation === 'define')).toBe(true)
    expect(apiSymbols.some(s => s.pattern === '/products' && s.operation === 'define')).toBe(true)
  })
})

describe('extractSymbols - HTTP calls', () => {
  it('should extract axios calls', () => {
    const content = `
const users = await axios.get('https://api.example.com/users')
await axios.post('https://api.example.com/orders', data)
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const httpSymbols = symbols.filter(s => s.type === 'http_call')
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/users' && s.operation === 'call')).toBe(true)
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/orders' && s.operation === 'call')).toBe(true)
  })

  it('should extract fetch calls', () => {
    const content = `
const response = await fetch('https://api.example.com/data')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const httpSymbols = symbols.filter(s => s.type === 'http_call')
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/data' && s.operation === 'call')).toBe(true)
  })

  it('should extract Python requests calls', () => {
    const content = `
response = requests.get('https://api.example.com/users')
requests.post('https://api.example.com/orders', json=data)
`
    const symbols = extractSymbols('/test/file.py', content, 'python')
    
    const httpSymbols = symbols.filter(s => s.type === 'http_call')
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/users' && s.operation === 'call')).toBe(true)
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/orders' && s.operation === 'call')).toBe(true)
  })

  it('should convert template literals in URLs to wildcards', () => {
    const content = `
const user = await axios.get(\`https://api.example.com/users/\${userId}\`)
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const httpSymbols = symbols.filter(s => s.type === 'http_call')
    expect(httpSymbols.some(s => s.pattern === 'https://api.example.com/users/*')).toBe(true)
  })
})

describe('extractSymbols - Bull queues', () => {
  it('should extract Bull queue definitions', () => {
    const content = `
const emailQueue = new Queue('email-notifications')
const processQueue = new Bull('data-processing')
`
    const symbols = extractSymbols('/test/file.ts', content, 'ts')
    
    const queueSymbols = symbols.filter(s => s.type === 'bull_queue')
    expect(queueSymbols.some(s => s.pattern === 'email-notifications' && s.operation === 'define')).toBe(true)
    expect(queueSymbols.some(s => s.pattern === 'data-processing' && s.operation === 'define')).toBe(true)
  })

  it('should extract Sidekiq queue definitions', () => {
    const content = `
class EmailWorker
  include Sidekiq::Worker
  sidekiq_options queue: 'mailers'
  
  def perform(user_id)
  end
end
`
    const symbols = extractSymbols('/test/file.rb', content, 'ruby')
    
    const queueSymbols = symbols.filter(s => s.type === 'bull_queue')
    expect(queueSymbols.some(s => s.pattern === 'mailers' && s.operation === 'define')).toBe(true)
  })
})

describe('Store symbol methods', () => {
  let tmpDir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-symbols-test-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should insert and query symbols', () => {
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'user:*',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/user.ts',
      lineNumber: 10,
      rawExpression: "redis.get('user:*')",
      projectHash: 'test-project',
    })

    const results = store.querySymbols({ type: 'redis_key', projectHash: 'test-project' })
    expect(results).toHaveLength(1)
    expect(results[0].pattern).toBe('user:*')
    expect(results[0].operation).toBe('read')
  })

  it('should delete symbols for a file', () => {
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'key1',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/a.ts',
      lineNumber: 1,
      rawExpression: 'redis.get("key1")',
      projectHash: 'test-project',
    })
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'key2',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/b.ts',
      lineNumber: 1,
      rawExpression: 'redis.get("key2")',
      projectHash: 'test-project',
    })

    store.deleteSymbols('/src/a.ts', 'test-project')

    const results = store.querySymbols({ projectHash: 'test-project' })
    expect(results).toHaveLength(1)
    expect(results[0].pattern).toBe('key2')
  })

  it('should query symbols with glob pattern matching', () => {
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'sinv:*:compressed',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/a.ts',
      lineNumber: 1,
      rawExpression: 'redis.get("sinv:*:compressed")',
      projectHash: 'test-project',
    })
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'cinv:*:*:compressed',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/b.ts',
      lineNumber: 1,
      rawExpression: 'redis.get("cinv:*:*:compressed")',
      projectHash: 'test-project',
    })

    const results = store.querySymbols({ pattern: 'sinv:*', projectHash: 'test-project' })
    expect(results).toHaveLength(1)
    expect(results[0].pattern).toBe('sinv:*:compressed')
  })

  it('should query symbols by operation', () => {
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'key1',
      operation: 'read',
      repo: 'backend',
      filePath: '/src/a.ts',
      lineNumber: 1,
      rawExpression: 'redis.get("key1")',
      projectHash: 'test-project',
    })
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'key2',
      operation: 'write',
      repo: 'backend',
      filePath: '/src/b.ts',
      lineNumber: 1,
      rawExpression: 'redis.set("key2")',
      projectHash: 'test-project',
    })

    const readers = store.querySymbols({ operation: 'read', projectHash: 'test-project' })
    const writers = store.querySymbols({ operation: 'write', projectHash: 'test-project' })

    expect(readers).toHaveLength(1)
    expect(writers).toHaveLength(1)
    expect(readers[0].pattern).toBe('key1')
    expect(writers[0].pattern).toBe('key2')
  })

  it('should get symbol impact grouped by operation', () => {
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'user:*',
      operation: 'read',
      repo: 'frontend',
      filePath: '/src/display.ts',
      lineNumber: 10,
      rawExpression: 'redis.get("user:*")',
      projectHash: 'test-project',
    })
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'user:*',
      operation: 'write',
      repo: 'backend',
      filePath: '/src/api.ts',
      lineNumber: 20,
      rawExpression: 'redis.set("user:*")',
      projectHash: 'test-project',
    })
    store.insertSymbol({
      type: 'redis_key',
      pattern: 'user:*',
      operation: 'read',
      repo: 'worker',
      filePath: '/src/job.ts',
      lineNumber: 30,
      rawExpression: 'redis.get("user:*")',
      projectHash: 'test-project',
    })

    const impact = store.getSymbolImpact('redis_key', 'user:*', 'test-project')
    expect(impact).toHaveLength(3)

    const readers = impact.filter(i => i.operation === 'read')
    const writers = impact.filter(i => i.operation === 'write')

    expect(readers).toHaveLength(2)
    expect(writers).toHaveLength(1)
  })
})

describe('Integration - codebase indexing with symbols', () => {
  let tmpDir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-brain-symbols-integration-'))
    dbPath = path.join(tmpDir, 'test.db')
    store = createStore(dbPath)
  })

  afterEach(() => {
    store.close()
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('should extract symbols during codebase indexing', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)
    fs.mkdirSync(path.join(srcDir, 'src'))

    fs.writeFileSync(path.join(srcDir, 'src', 'cache.ts'), `
import Redis from 'ioredis'
const redis = new Redis()

export async function getUser(id: string) {
  return redis.get(\`user:\${id}\`)
}

export async function setUser(id: string, data: string) {
  return redis.set(\`user:\${id}\`, data)
}
`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const symbols = store.querySymbols({ type: 'redis_key', projectHash: 'test-project' })
    expect(symbols.length).toBeGreaterThanOrEqual(2)
    expect(symbols.some(s => s.pattern === 'user:*' && s.operation === 'read')).toBe(true)
    expect(symbols.some(s => s.pattern === 'user:*' && s.operation === 'write')).toBe(true)
  })

  it('should clean up old symbols on re-index', async () => {
    const srcDir = path.join(tmpDir, 'workspace')
    fs.mkdirSync(srcDir)

    fs.writeFileSync(path.join(srcDir, 'cache.ts'), `
const value = await redis.get('old-key')
`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    let symbols = store.querySymbols({ projectHash: 'test-project' })
    expect(symbols.some(s => s.pattern === 'old-key')).toBe(true)

    fs.writeFileSync(path.join(srcDir, 'cache.ts'), `
const value = await redis.get('new-key')
`)

    await indexCodebase(store, srcDir, config, 'test-project')

    symbols = store.querySymbols({ projectHash: 'test-project' })
    expect(symbols.some(s => s.pattern === 'old-key')).toBe(false)
    expect(symbols.some(s => s.pattern === 'new-key')).toBe(true)
  })

  it('should set repo name from workspace basename', async () => {
    const srcDir = path.join(tmpDir, 'my-awesome-project')
    fs.mkdirSync(srcDir)

    fs.writeFileSync(path.join(srcDir, 'index.ts'), `
const value = await redis.get('test-key')
`)

    const config: CodebaseConfig = { enabled: true, extensions: ['.ts'] }
    await indexCodebase(store, srcDir, config, 'test-project')

    const symbols = store.querySymbols({ projectHash: 'test-project' })
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols[0].repo).toBe('my-awesome-project')
  })
})
