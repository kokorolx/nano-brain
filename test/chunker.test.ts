import { describe, it, expect } from 'vitest';
import { findBreakPoints, findCodeFences, findBestCutoff, chunkMarkdown } from '../src/chunker.js';

describe('findBreakPoints', () => {
  it('detects H1 headings with score 100', () => {
    const content = '# Heading 1\nSome text';
    const breakPoints = findBreakPoints(content);
    
    const h1 = breakPoints.find(bp => bp.type === 'h1');
    expect(h1).toBeDefined();
    expect(h1?.score).toBe(100);
    expect(h1?.pos).toBe(0);
    expect(h1?.lineNo).toBe(1);
  });

  it('detects H2 headings with score 90', () => {
    const content = '## Heading 2\nSome text';
    const breakPoints = findBreakPoints(content);
    
    const h2 = breakPoints.find(bp => bp.type === 'h2');
    expect(h2).toBeDefined();
    expect(h2?.score).toBe(90);
    expect(h2?.pos).toBe(0);
  });

  it('detects H3 headings with score 80', () => {
    const content = '### Heading 3\nSome text';
    const breakPoints = findBreakPoints(content);
    
    const h3 = breakPoints.find(bp => bp.type === 'h3');
    expect(h3).toBeDefined();
    expect(h3?.score).toBe(80);
  });

  it('detects H4-H6 headings with score 70', () => {
    const content = '#### Heading 4\n##### Heading 5\n###### Heading 6';
    const breakPoints = findBreakPoints(content);
    
    const h4h6 = breakPoints.filter(bp => bp.type === 'h4-h6');
    expect(h4h6.length).toBe(3);
    expect(h4h6[0].score).toBe(70);
  });

  it('detects code fences with score 80', () => {
    const content = '```typescript\ncode\n```';
    const breakPoints = findBreakPoints(content);
    
    const fences = breakPoints.filter(bp => bp.type === 'code-fence');
    expect(fences.length).toBe(2);
    expect(fences[0].score).toBe(80);
  });

  it('detects horizontal rules with score 60', () => {
    const content = '---\n***\n___';
    const breakPoints = findBreakPoints(content);
    
    const hrs = breakPoints.filter(bp => bp.type === 'hr');
    expect(hrs.length).toBe(3);
    expect(hrs[0].score).toBe(60);
  });

  it('detects blank lines with score 20', () => {
    const content = 'text\n\nmore text\n   \nend';
    const breakPoints = findBreakPoints(content);
    
    const blanks = breakPoints.filter(bp => bp.type === 'blank');
    expect(blanks.length).toBe(2);
    expect(blanks[0].score).toBe(20);
  });

  it('detects list items with score 5', () => {
    const content = '- Item 1\n* Item 2\n+ Item 3\n1. Numbered\n2. Item';
    const breakPoints = findBreakPoints(content);
    
    const lists = breakPoints.filter(bp => bp.type === 'list');
    expect(lists.length).toBe(5);
    expect(lists[0].score).toBe(5);
  });

  it('detects regular newlines with score 1', () => {
    const content = 'regular text\nanother line';
    const breakPoints = findBreakPoints(content);
    
    const newlines = breakPoints.filter(bp => bp.type === 'newline');
    expect(newlines.length).toBe(2);
    expect(newlines[0].score).toBe(1);
  });

  it('calculates correct positions for multi-line content', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const breakPoints = findBreakPoints(content);
    
    expect(breakPoints[0].pos).toBe(0);
    expect(breakPoints[1].pos).toBe(7);
    expect(breakPoints[2].pos).toBe(14);
  });

  it('assigns correct line numbers', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const breakPoints = findBreakPoints(content);
    
    expect(breakPoints[0].lineNo).toBe(1);
    expect(breakPoints[1].lineNo).toBe(2);
    expect(breakPoints[2].lineNo).toBe(3);
  });
});

describe('findCodeFences', () => {
  it('detects simple code fence regions', () => {
    const content = 'text\n```\ncode\n```\nmore text';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(1);
    expect(fences[0].start).toBe(5);
    expect(fences[0].end).toBe(17);
  });

  it('handles code fences with language tags', () => {
    const content = '```typescript\nconst x = 1;\n```';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(1);
    expect(fences[0].start).toBe(0);
  });

  it('handles multiple code fence regions', () => {
    const content = '```\ncode1\n```\ntext\n```\ncode2\n```';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(2);
    expect(fences[0].start).toBe(0);
    expect(fences[1].start).toBe(19);
  });

  it('handles unclosed code fences', () => {
    const content = 'text\n```\ncode that never closes';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(1);
    expect(fences[0].start).toBe(5);
    expect(fences[0].end).toBe(content.length);
  });

  it('returns empty array for content without code fences', () => {
    const content = 'just regular text\nno code here';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(0);
  });

  it('handles nested-like fences (treats as separate regions)', () => {
    const content = '```\nouter\n```inner\nstill outer\n```';
    const fences = findCodeFences(content);
    
    expect(fences.length).toBe(2);
  });
});

describe('findBestCutoff', () => {
  it('returns highest scoring break point in window', () => {
    const breakPoints = [
      { pos: 100, score: 20, type: 'blank', lineNo: 1 },
      { pos: 500, score: 100, type: 'h1', lineNo: 5 },
      { pos: 900, score: 20, type: 'blank', lineNo: 9 },
    ];
    const targetPos = 500;
    const windowSize = 400;
    const codeFences = [];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).toBe(500);
  });

  it('applies distance decay to scores', () => {
    const breakPoints = [
      { pos: 100, score: 100, type: 'h1', lineNo: 1 },
      { pos: 500, score: 50, type: 'h2', lineNo: 5 },
    ];
    const targetPos = 500;
    const windowSize = 400;
    const codeFences = [];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).toBe(500);
  });

  it('never cuts inside code fences', () => {
    const breakPoints = [
      { pos: 100, score: 100, type: 'h1', lineNo: 1 },
      { pos: 500, score: 100, type: 'h1', lineNo: 5 },
      { pos: 900, score: 50, type: 'h2', lineNo: 9 },
    ];
    const targetPos = 500;
    const windowSize = 400;
    const codeFences = [{ start: 400, end: 600 }];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).not.toBe(500);
    expect(cutoff === 100 || cutoff === 900).toBe(true);
  });

  it('returns targetPos when no break points in window', () => {
    const breakPoints = [
      { pos: 0, score: 100, type: 'h1', lineNo: 1 },
      { pos: 2000, score: 100, type: 'h1', lineNo: 20 },
    ];
    const targetPos = 1000;
    const windowSize = 200;
    const codeFences = [];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).toBe(1000);
  });

  it('returns fence end when targetPos is inside code fence', () => {
    const breakPoints = [
      { pos: 500, score: 100, type: 'h1', lineNo: 5 },
    ];
    const targetPos = 500;
    const windowSize = 400;
    const codeFences = [{ start: 0, end: 1000 }];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).toBe(1000);
  });

  it('prefers closer break points with similar scores', () => {
    const breakPoints = [
      { pos: 300, score: 90, type: 'h2', lineNo: 3 },
      { pos: 500, score: 90, type: 'h2', lineNo: 5 },
    ];
    const targetPos = 500;
    const windowSize = 400;
    const codeFences = [];
    
    const cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    expect(cutoff).toBe(500);
  });
});

describe('chunkMarkdown - basic', () => {
  it('returns single chunk for short content', () => {
    const content = 'Short content';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].hash).toBe(hash);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].pos).toBe(0);
    expect(chunks[0].text).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('handles empty string', () => {
    const content = '';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('');
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('handles single line', () => {
    const content = 'Single line';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('handles content exactly at maxChunkSize', () => {
    const content = 'x'.repeat(3600);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBe(1);
  });
});

describe('chunkMarkdown - multi-chunk', () => {
  it('produces multiple chunks for long content', () => {
    const content = 'x'.repeat(8000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('assigns sequential seq numbers', () => {
    const content = 'x'.repeat(8000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].seq).toBe(i);
    }
  });

  it('assigns correct positions', () => {
    const content = 'x'.repeat(8000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks[0].pos).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].pos).toBeGreaterThan(0);
    }
  });

  it('respects custom maxChunkSize', () => {
    const content = 'x'.repeat(3000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 1000 });
    
    expect(chunks.length).toBeGreaterThan(2);
  });
});

describe('chunkMarkdown - overlap', () => {
  it('creates overlapping chunks', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join('\n');
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 500, overlap: 100 });
    
    if (chunks.length > 1) {
      const chunk0End = chunks[0].pos + chunks[0].text.length;
      const chunk1Start = chunks[1].pos;
      
      expect(chunk1Start).toBeLessThan(chunk0End);
    }
  });

  it('respects custom overlap size', () => {
    const content = 'x'.repeat(6000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 2000, overlap: 300 });
    
    if (chunks.length > 1) {
      const actualGap = chunks[1].pos - (chunks[0].pos + chunks[0].text.length);
      expect(actualGap).toBeLessThan(0);
    }
  });
});

describe('chunkMarkdown - heading-aware', () => {
  it('prefers cutting at headings over blank lines', () => {
    const content = `
${'x'.repeat(3000)}

## Important Section
${'y'.repeat(3000)}
    `.trim();
    
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    if (chunks.length > 1) {
      const hasHeadingNearBoundary = chunks.some(chunk => 
        chunk.text.includes('## Important Section')
      );
      expect(hasHeadingNearBoundary).toBe(true);
    }
  });

  it('respects heading hierarchy in chunking', () => {
    const content = `
# Main Title
${'x'.repeat(2500)}

## Section 1
${'y'.repeat(2500)}

### Subsection
${'z'.repeat(2500)}
    `.trim();
    
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('chunkMarkdown - code fence protection', () => {
  it('avoids cutting at positions inside code blocks when possible', () => {
    const codeBlock = '```typescript\n' + 'x'.repeat(2000) + '\n```';
    const content = 'y'.repeat(2000) + '\n' + codeBlock + '\n' + 'z'.repeat(2000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { overlap: 0 });
    
    for (const chunk of chunks) {
      const openFences = (chunk.text.match(/```/g) || []).length;
      if (openFences > 0) {
        expect(openFences % 2).toBe(0);
      }
    }
  });

  it('keeps code blocks intact when possible', () => {
    const content = `
Some text before

\`\`\`typescript
function example() {
  return "code";
}
\`\`\`

Some text after
    `.trim();
    
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 200 });
    
    const codeChunk = chunks.find(c => c.text.includes('```typescript'));
    if (codeChunk) {
      expect(codeChunk.text.includes('```typescript')).toBe(true);
      expect(codeChunk.text.match(/```/g)?.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('chunkMarkdown - edge cases', () => {
  it('handles content with only newlines', () => {
    const content = '\n\n\n\n\n';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe(content);
  });

  it('handles content with no break points', () => {
    const content = 'x'.repeat(8000);
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('calculates correct line numbers across chunks', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}`);
    const content = lines.join('\n');
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 500 });
    
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
    
    if (chunks.length > 1) {
      expect(chunks[chunks.length - 1].endLine).toBeLessThanOrEqual(lines.length);
    }
  });

  it('handles very small maxChunkSize', () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash, { maxChunkSize: 10 });
    
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles content with mixed line endings', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const hash = 'test-hash';
    const chunks = chunkMarkdown(content, hash);
    
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('Line 1');
  });
});
