import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseGlobalOptions, showHelp, showVersion, formatSearchOutput } from '../src/index.js';
import type { SearchResult } from '../src/types.js';

function createMockResult(id: string, score: number, snippet: string = 'test snippet'): SearchResult {
  return {
    id,
    path: `path/${id}`,
    collection: 'test',
    title: `Title ${id}`,
    snippet,
    score,
    startLine: 1,
    endLine: 10,
    docid: id.substring(0, 6),
  };
}

describe('CLI Argument Parsing', () => {
  describe('parseGlobalOptions', () => {
    it('should parse --db flag with equals syntax', () => {
      const args = ['--db=/custom/path.db', 'status'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toBe('/custom/path.db');
      expect(result.remaining).toEqual(['status']);
    });
    
    it('should parse --db flag with space syntax', () => {
      const args = ['--db', '/custom/path.db', 'status'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toBe('/custom/path.db');
      expect(result.remaining).toEqual(['status']);
    });
    
    it('should parse --config flag with equals syntax', () => {
      const args = ['--config=/custom/config.yml', 'update'];
      const result = parseGlobalOptions(args);
      
      expect(result.configPath).toBe('/custom/config.yml');
      expect(result.remaining).toEqual(['update']);
    });
    
    it('should parse --config flag with space syntax', () => {
      const args = ['--config', '/custom/config.yml', 'update'];
      const result = parseGlobalOptions(args);
      
      expect(result.configPath).toBe('/custom/config.yml');
      expect(result.remaining).toEqual(['update']);
    });
    
    it('should use default paths when no flags provided', () => {
      const args = ['status'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toContain('.nano-brain/data/default.sqlite');
      expect(result.configPath).toContain('.nano-brain/config.yml');
      expect(result.remaining).toEqual(['status']);
    });
    
    it('should extract remaining args after global options', () => {
      const args = ['--db=/test.db', 'search', 'query text', '-n', '20'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toBe('/test.db');
      expect(result.remaining).toEqual(['search', 'query text', '-n', '20']);
    });
    
    it('should handle multiple global options', () => {
      const args = ['--db=/test.db', '--config=/test.yml', 'collection', 'list'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toBe('/test.db');
      expect(result.configPath).toBe('/test.yml');
      expect(result.remaining).toEqual(['collection', 'list']);
    });
    
    it('should handle no remaining args', () => {
      const args = ['--db=/test.db'];
      const result = parseGlobalOptions(args);
      
      expect(result.dbPath).toBe('/test.db');
      expect(result.remaining).toEqual([]);
    });
  });
  
  describe('showHelp', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    
    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    
    afterEach(() => {
      consoleLogSpy.mockRestore();
    });
    
    it('should output help text', () => {
      showHelp();
      
      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      
      expect(output).toContain('nano-brain');
      expect(output).toContain('mcp');
      expect(output).toContain('collection');
      expect(output).toContain('status');
      expect(output).toContain('search');
    });
  });
  
  describe('showVersion', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    
    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    
    afterEach(() => {
      consoleLogSpy.mockRestore();
    });
    
    it('should output version', () => {
      showVersion();
      
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringMatching(/^nano-brain v/));
    });
  });
});

describe('Search Output Formatting', () => {
  describe('formatSearchOutput - text', () => {
    it('should format results as readable text', () => {
      const results = [
        createMockResult('doc1', 0.95, 'This is a test snippet'),
        createMockResult('doc2', 0.87, 'Another snippet here'),
      ];
      
      const output = formatSearchOutput(results, 'text');
      
      expect(output).toContain('[doc1]');
      expect(output).toContain('test/path/doc1');
      expect(output).toContain('Score: 0.9500');
      expect(output).toContain('Title doc1');
      expect(output).toContain('This is a test snippet');
      
      expect(output).toContain('[doc2]');
      expect(output).toContain('test/path/doc2');
      expect(output).toContain('Score: 0.8700');
      expect(output).toContain('Another snippet here');
    });
    
    it('should handle empty results', () => {
      const output = formatSearchOutput([], 'text');
      expect(output).toBe('');
    });
    
    it('should handle results without snippets', () => {
      const results = [
        { ...createMockResult('doc1', 0.95), snippet: '' },
      ];
      
      const output = formatSearchOutput(results, 'text');
      
      expect(output).toContain('[doc1]');
      expect(output).toContain('Score: 0.9500');
      expect(output).not.toContain('test snippet');
    });
  });
  
  describe('formatSearchOutput - json', () => {
    it('should format results as JSON', () => {
      const results = [
        createMockResult('doc1', 0.95, 'Test snippet'),
      ];
      
      const output = formatSearchOutput(results, 'json');
      const parsed = JSON.parse(output);
      
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('doc1');
      expect(parsed[0].score).toBe(0.95);
      expect(parsed[0].snippet).toBe('Test snippet');
      expect(parsed[0].path).toBe('path/doc1');
    });
    
    it('should handle empty results as JSON', () => {
      const output = formatSearchOutput([], 'json');
      const parsed = JSON.parse(output);
      
      expect(parsed).toEqual([]);
    });
    
    it('should format multiple results as JSON array', () => {
      const results = [
        createMockResult('doc1', 0.95),
        createMockResult('doc2', 0.87),
        createMockResult('doc3', 0.75),
      ];
      
      const output = formatSearchOutput(results, 'json');
      const parsed = JSON.parse(output);
      
      expect(parsed).toHaveLength(3);
      expect(parsed[0].id).toBe('doc1');
      expect(parsed[1].id).toBe('doc2');
      expect(parsed[2].id).toBe('doc3');
    });
  });
  
  describe('formatSearchOutput - files', () => {
    it('should show only file paths', () => {
      const results = [
        createMockResult('doc1', 0.95),
        createMockResult('doc2', 0.87),
      ];
      
      const output = formatSearchOutput(results, 'files');
      
      expect(output).toBe('path/doc1\npath/doc2');
    });
    
    it('should handle empty results', () => {
      const output = formatSearchOutput([], 'files');
      expect(output).toBe('');
    });
    
    it('should handle single result', () => {
      const results = [createMockResult('doc1', 0.95)];
      const output = formatSearchOutput(results, 'files');
      
      expect(output).toBe('path/doc1');
    });
  });
});

describe('Command Dispatch', () => {
  it('should identify mcp command', () => {
    const args = ['mcp', '--http'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('mcp');
    expect(result.remaining[1]).toBe('--http');
  });
  
  it('should identify collection command', () => {
    const args = ['collection', 'add', 'test', '/path'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('collection');
    expect(result.remaining.slice(1)).toEqual(['add', 'test', '/path']);
  });
  
  it('should identify status command', () => {
    const args = ['status'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('status');
  });
  
  it('should identify search command with args', () => {
    const args = ['search', 'test query', '-n', '20'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('search');
    expect(result.remaining.slice(1)).toEqual(['test query', '-n', '20']);
  });
  
  it('should default to mcp when no command provided', () => {
    const args: string[] = [];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining).toEqual([]);
  });
  
  it('should handle vsearch command', () => {
    const args = ['vsearch', 'semantic query'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('vsearch');
    expect(result.remaining[1]).toBe('semantic query');
  });
  
  it('should handle query command', () => {
    const args = ['query', 'hybrid search', '--min-score=0.5'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('query');
    expect(result.remaining.slice(1)).toEqual(['hybrid search', '--min-score=0.5']);
  });
  
  it('should handle get command', () => {
    const args = ['get', 'abc123', '--full'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('get');
    expect(result.remaining.slice(1)).toEqual(['abc123', '--full']);
  });
  
  it('should handle harvest command', () => {
    const args = ['harvest'];
    const result = parseGlobalOptions(args);
    
    expect(result.remaining[0]).toBe('harvest');
  });
});
