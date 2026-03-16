import { describe, it, expect, vi } from 'vitest'
import {
  categorizeMemory,
  parseCategorizationResponse,
  categorizationPrompt,
  VALID_CATEGORIES,
} from '../src/llm-categorizer.js'
import type { LLMProvider } from '../src/consolidation.js'
import type { LLMCategorizationConfig } from '../src/types.js'
import { DEFAULT_LLM_CATEGORIZATION_CONFIG } from '../src/types.js'

function createMockProvider(response: string, tokensUsed: number = 100): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({ text: response, tokensUsed }),
  }
}

function createFailingProvider(error: Error): LLMProvider {
  return {
    complete: vi.fn().mockRejectedValue(error),
  }
}

describe('LLM Categorization Integration', () => {
  const defaultConfig: LLMCategorizationConfig = {
    ...DEFAULT_LLM_CATEGORIZATION_CONFIG,
    confidence_threshold: 0.6,
    max_content_length: 2000,
  }

  describe('categorizeMemory', () => {
    it('should return llm: prefixed tags for valid categories', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.9 },
          { name: 'debugging-insight', confidence: 0.8 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'We decided to use Redis for caching because of its performance',
        provider,
        defaultConfig
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).toContain('llm:debugging-insight')
      expect(tags.every(t => t.startsWith('llm:'))).toBe(true)
    })

    it('should filter out low-confidence categories', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.9 },
          { name: 'debugging-insight', confidence: 0.3 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Some content about architecture',
        provider,
        { ...defaultConfig, confidence_threshold: 0.6 }
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).not.toContain('llm:debugging-insight')
    })

    it('should return empty array for empty content', async () => {
      const provider = createMockProvider('{}')

      const tags = await categorizeMemory('', provider, defaultConfig)

      expect(tags).toEqual([])
      expect(provider.complete).not.toHaveBeenCalled()
    })

    it('should return empty array for whitespace-only content', async () => {
      const provider = createMockProvider('{}')

      const tags = await categorizeMemory('   \n\t  ', provider, defaultConfig)

      expect(tags).toEqual([])
      expect(provider.complete).not.toHaveBeenCalled()
    })

    it('should handle LLM provider failure gracefully', async () => {
      const provider = createFailingProvider(new Error('API rate limit exceeded'))

      const tags = await categorizeMemory(
        'Some content to categorize',
        provider,
        defaultConfig
      )

      expect(tags).toEqual([])
    })

    it('should handle invalid JSON response gracefully', async () => {
      const provider = createMockProvider('This is not valid JSON at all')

      const tags = await categorizeMemory(
        'Some content to categorize',
        provider,
        defaultConfig
      )

      expect(tags).toEqual([])
    })

    it('should reject unknown categories', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.9 },
          { name: 'unknown-category', confidence: 0.95 },
          { name: 'made-up-type', confidence: 0.99 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content with mixed categories',
        provider,
        defaultConfig
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).not.toContain('llm:unknown-category')
      expect(tags).not.toContain('llm:made-up-type')
      expect(tags.length).toBe(1)
    })

    it('should handle response with no categories array', async () => {
      const mockResponse = JSON.stringify({ result: 'success' })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Some content',
        provider,
        defaultConfig
      )

      expect(tags).toEqual([])
    })

    it('should handle malformed category items', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.9 },
          { name: 123, confidence: 0.8 },
          { name: 'pattern', confidence: 'high' },
          { confidence: 0.9 },
          'just-a-string',
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content with malformed items',
        provider,
        defaultConfig
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags.length).toBe(1)
    })

    it('should normalize category names to lowercase', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'ARCHITECTURE-DECISION', confidence: 0.9 },
          { name: 'Debugging-Insight', confidence: 0.8 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content with uppercase categories',
        provider,
        defaultConfig
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).toContain('llm:debugging-insight')
    })

    it('should clamp confidence values to 0-1 range', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 1.5 },
          { name: 'pattern', confidence: -0.5 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content with out-of-range confidence',
        provider,
        { ...defaultConfig, confidence_threshold: 0.0 }
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).toContain('llm:pattern')
    })
  })

  describe('parseCategorizationResponse', () => {
    it('should extract JSON from text with surrounding content', () => {
      const response = `Here is my analysis:
{"categories": [{"name": "workflow", "confidence": 0.85}]}
That's my categorization.`

      const result = parseCategorizationResponse(response)

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('workflow')
      expect(result[0].confidence).toBe(0.85)
    })

    it('should return empty array for no JSON in response', () => {
      const result = parseCategorizationResponse('No JSON here, just text.')

      expect(result).toEqual([])
    })

    it('should return empty array for empty string', () => {
      const result = parseCategorizationResponse('')

      expect(result).toEqual([])
    })

    it('should validate all known categories', () => {
      const categories = VALID_CATEGORIES.map(name => ({
        name,
        confidence: 0.9,
      }))
      const response = JSON.stringify({ categories })

      const result = parseCategorizationResponse(response)

      expect(result).toHaveLength(VALID_CATEGORIES.length)
      for (const cat of VALID_CATEGORIES) {
        expect(result.some(r => r.name === cat)).toBe(true)
      }
    })
  })

  describe('categorizationPrompt', () => {
    it('should include content in prompt', () => {
      const content = 'Test content about Redis caching'
      const prompt = categorizationPrompt(content, 2000)

      expect(prompt).toContain(content)
    })

    it('should truncate content exceeding max length', () => {
      const longContent = 'x'.repeat(5000)
      const prompt = categorizationPrompt(longContent, 2000)

      expect(prompt.length).toBeLessThan(5000)
      expect(prompt).toContain('x'.repeat(100))
    })

    it('should include all valid categories in prompt', () => {
      const prompt = categorizationPrompt('test', 2000)

      for (const cat of VALID_CATEGORIES) {
        expect(prompt).toContain(cat)
      }
    })

    it('should request JSON response format', () => {
      const prompt = categorizationPrompt('test', 2000)

      expect(prompt.toLowerCase()).toContain('json')
    })
  })

  describe('edge cases', () => {
    it('should handle all confidence at exactly threshold', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.6 },
          { name: 'pattern', confidence: 0.6 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content at threshold',
        provider,
        { ...defaultConfig, confidence_threshold: 0.6 }
      )

      expect(tags).toContain('llm:architecture-decision')
      expect(tags).toContain('llm:pattern')
    })

    it('should handle all confidence just below threshold', async () => {
      const mockResponse = JSON.stringify({
        categories: [
          { name: 'architecture-decision', confidence: 0.59 },
          { name: 'pattern', confidence: 0.59 },
        ],
      })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content below threshold',
        provider,
        { ...defaultConfig, confidence_threshold: 0.6 }
      )

      expect(tags).toEqual([])
    })

    it('should handle empty categories array', async () => {
      const mockResponse = JSON.stringify({ categories: [] })
      const provider = createMockProvider(mockResponse)

      const tags = await categorizeMemory(
        'Content with empty categories',
        provider,
        defaultConfig
      )

      expect(tags).toEqual([])
    })

    it('should handle very long content with truncation', async () => {
      const mockResponse = JSON.stringify({
        categories: [{ name: 'context', confidence: 0.9 }],
      })
      const provider = createMockProvider(mockResponse)
      const longContent = 'Important decision: '.repeat(1000)

      const tags = await categorizeMemory(
        longContent,
        provider,
        { ...defaultConfig, max_content_length: 500 }
      )

      expect(tags).toContain('llm:context')
      expect(provider.complete).toHaveBeenCalled()
      const callArg = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callArg.length).toBeLessThan(longContent.length)
    })
  })
})
