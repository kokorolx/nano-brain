// Run with: npx vitest run test/mcp-client.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_URL = 'http://localhost:3100/mcp'

describe('nano-brain MCP (live)', () => {
  let client: Client
  let transport: StreamableHTTPClientTransport
  let serverAvailable = false

  const liveIt = (name: string, fn: () => Promise<void>, timeout: number) =>
    it(name, async (ctx) => {
      if (!serverAvailable) {
        ctx.skip()
        return
      }
      await fn()
    }, timeout)

  const getText = (response: { content: Array<{ type: 'text'; text: string }> }) =>
    response.content?.[0]?.text ?? ''

  beforeAll(async () => {
    transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
    client = new Client({ name: 'nano-brain-mcp-client-test', version: '0.0.0' })
    try {
      await client.connect(transport)
      serverAvailable = true
    } catch {
      serverAvailable = false
      try {
        await transport.close()
      } catch {
        return
      }
    }
  })

  afterAll(async () => {
    if (serverAvailable) {
      await client.close()
    }
  })

  liveIt(
    'memory_status returns status text',
    async () => {
      const response = await client.callTool({ name: 'memory_status', arguments: {} })
      const text = getText(response)
      expect(text).toContain('Memory Index Status')
    },
    30000
  )

  liveIt(
    'memory_search returns text content',
    async () => {
      const response = await client.callTool({
        name: 'memory_search',
        arguments: { query: 'test', limit: 5 },
      })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )

  liveIt(
    'memory_vsearch returns text content',
    async () => {
      const response = await client.callTool({
        name: 'memory_vsearch',
        arguments: { query: 'test', limit: 5 },
      })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )

  liveIt(
    'memory_query returns text content',
    async () => {
      const response = await client.callTool({
        name: 'memory_query',
        arguments: { query: 'test', limit: 5 },
      })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )

  liveIt(
    'memory_write returns success text',
    async () => {
      const response = await client.callTool({
        name: 'memory_write',
        arguments: { content: `mcp live test ${Date.now()}`, tags: 'mcp-test' },
      })
      const text = getText(response)
      expect(text).toContain('Written to')
    },
    30000
  )

  liveIt(
    'memory_tags returns text content',
    async () => {
      const response = await client.callTool({ name: 'memory_tags', arguments: {} })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )

  liveIt(
    'memory_get returns text content',
    async () => {
      const response = await client.callTool({
        name: 'memory_get',
        arguments: { id: '#000000' },
      })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )

  liveIt(
    'memory_graph_stats returns graph statistics',
    async () => {
      const response = await client.callTool({ name: 'memory_graph_stats', arguments: {} })
      const text = getText(response)
      expect(text).toContain('Graph Statistics')
    },
    30000
  )

  liveIt(
    'code_detect_changes returns text content',
    async () => {
      const response = await client.callTool({ name: 'code_detect_changes', arguments: {} })
      const text = getText(response)
      expect(text.length).toBeGreaterThan(0)
    },
    30000
  )
})
