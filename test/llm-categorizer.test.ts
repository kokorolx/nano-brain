import { describe, it, expect, vi } from 'vitest'
import {
  categorizationPrompt,
  parseCategorizationResponse,
  categorizeMemory,
  VALID_CATEGORIES,
} from '../src/llm-categorizer.js'
import type { LLMProvider } from '../src/consolidation.js'
import type { LLMCategorizationConfig } from '../src/types.js'

function createMockProvider(response: { text: string; tokensUsed: number }): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue(response),
    model: 'test-model',
  }
}

const defaultConfig: LLMCategorizationConfig = {
  llm_enabled: true,
  confidence_threshold: 0.6,
  max_content_length: 2000,
}

describe('llm-categorizer', () => {
  describe('categorizationPrompt', () => {
    it('includes content in prompt', () => {
      const content = 'Test memory content'
      const prompt = categorizationPrompt(content, 2000)
      expect(prompt).toContain(content)
    })

    it('truncates content to max_content_length', () => {
      const longContent = 'x'.repeat(3000)
      const prompt = categorizationPrompt(longContent, 100)
      expect(prompt).not.toContain(longContent)
      expect(prompt).toContain('x'.repeat(100))
    })

    it('does not truncate content shorter than max_content_length', () => {
      const shortContent = 'short content'
      const prompt = categorizationPrompt(shortContent, 2000)
      expect(prompt).toContain(shortContent)
    })

    it('includes all valid categories in prompt', () => {
      const prompt = categorizationPrompt('test', 2000)
      for (const category of VALID_CATEGORIES) {
        expect(prompt).toContain(category)
      }
    })
  })

  describe('parseCategorizationResponse', () => {
    it('parses valid JSON response', () => {
      const response = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.9 },
          { name: 'debugging-insight', confidence: 0.7 },
        ],
      })
      const result = parseCategorizationResponse(response)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('architecture-decision')
      expect(result[0].confidence).toBe(0.9)
    })

    it('returns empty array for invalid JSON', () => {
      const result = parseCategorizationResponse('not valid json')
      expect(result).toEqual([])
    })

    it('returns empty array for JSON without categories array', () => {
      const result = parseCategorizationResponse('{"foo": "bar"}')
      expect(result).toEqual([])
    })

    it('rejects unknown categories', () => {
      const response = JSON.stringify({
        categories: [
          { name: 'unknown-category', confidence: 0.9 },
          { name: 'architecture-decision', confidence: 0.8 },
        ],
      })
      const result = parseCategorizationResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('architecture-decision')
    })

    it('normalizes category names to lowercase', () => {
      const response = JSON.stringify({
        categories: [{ name: 'ARCHITECTURE-DECISION', confidence: 0.9 }],
      })
      const result = parseCategorizationResponse(response)
      expect(result[0].name).toBe('architecture-decision')
    })

    it('clamps confidence to [0, 1]', () => {
      const response = JSON.stringify({
        categories: [
          { name: 'pattern', confidence: 1.5 },
          { name: 'workflow', confidence: -0.5 },
        ],
      })
      const result = parseCategorizationResponse(response)
      expect(result[0].confidence).toBe(1)
      expect(result[1].confidence).toBe(0)
    })

    it('skips items with invalid types', () => {
      const response = JSON.stringify({
        categories: [
          { name: 123, confidence: 0.9 },
          { name: 'pattern', confidence: 'high' },
          { name: 'workflow', confidence: 0.8 },
        ],
      })
      const result = parseCategorizationResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('workflow')
    })

    it('extracts JSON from text with surrounding content', () => {
      const response = 'Here is the result: {"categories": [{"name": "pattern", "confidence": 0.9}]} Done.'
      const result = parseCategorizationResponse(response)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('pattern')
    })
  })

  describe('categorizeMemory', () => {
    it('returns llm: prefixed tags', async () => {
      const provider = createMockProvider({
        text: JSON.stringify({
          categories: [{ name: 'architecture-decision', confidence: 0.9 }],
        }),
        tokensUsed: 100,
      })

      const result = await categorizeMemory('test content', provider, defaultConfig)
      expect(result).toEqual(['llm:architecture-decision'])
    })

    it('filters by confidence threshold', async () => {
      const provider = createMockProvider({
        text: JSON.stringify({
          categories: [
            { name: 'architecture-decision', confidence: 0.9 },
            { name: 'debugging-insight', confidence: 0.5 },
          ],
        }),
        tokensUsed: 100,
      })

      const result = await categorizeMemory('test content', provider, defaultConfig)
      expect(result).toEqual(['llm:architecture-decision'])
    })

    it('returns multiple categories above threshold', async () => {
      const provider = createMockProvider({
        text: JSON.stringify({
          categories: [
            { name: 'architecture-decision', confidence: 0.9 },
            { name: 'pattern', confidence: 0.8 },
            { name: 'workflow', confidence: 0.7 },
          ],
        }),
        tokensUsed: 100,
      })

      const result = await categorizeMemory('test content', provider, defaultConfig)
      expect(result).toHaveLength(3)
      expect(result).toContain('llm:architecture-decision')
      expect(result).toContain('llm:pattern')
      expect(result).toContain('llm:workflow')
    })

    it('returns empty array when all categories below threshold', async () => {
      const provider = createMockProvider({
        text: JSON.stringify({
          categories: [
            { name: 'architecture-decision', confidence: 0.3 },
            { name: 'debugging-insight', confidence: 0.4 },
          ],
        }),
        tokensUsed: 100,
      })

      const result = await categorizeMemory('test content', provider, defaultConfig)
      expect(result).toEqual([])
    })

    it('returns empty array for empty content', async () => {
      const provider = createMockProvider({
        text: '{}',
        tokensUsed: 0,
      })

      const result = await categorizeMemory('', provider, defaultConfig)
      expect(result).toEqual([])
      expect(provider.complete).not.toHaveBeenCalled()
    })

    it('returns empty array for whitespace-only content', async () => {
      const provider = createMockProvider({
        text: '{}',
        tokensUsed: 0,
      })

      const result = await categorizeMemory('   \n\t  ', provider, defaultConfig)
      expect(result).toEqual([])
      expect(provider.complete).not.toHaveBeenCalled()
    })

    it('returns empty array when LLM call fails', async () => {
      const provider: LLMProvider = {
        complete: vi.fn().mockRejectedValue(new Error('API error')),
        model: 'test-model',
      }

      const result = await categorizeMemory('test content', provider, defaultConfig)
      expect(result).toEqual([])
    })

    it('respects max_content_length config', async () => {
      const provider = createMockProvider({
        text: JSON.stringify({ categories: [] }),
        tokensUsed: 100,
      })

      const config: LLMCategorizationConfig = {
        ...defaultConfig,
        max_content_length: 50,
      }

      await categorizeMemory('x'.repeat(100), provider, config)
      const callArg = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callArg).not.toContain('x'.repeat(100))
    })
  })
})
