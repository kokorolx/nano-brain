import type { MemoryChunk, BreakPoint, CodeFenceRegion } from './types.js';

export interface ChunkOptions {
  maxChunkSize?: number;
  minChunkSize?: number;
  overlap?: number;
}

export function findBreakPoints(content: string): BreakPoint[] {
  const breakPoints: BreakPoint[] = [];
  const lines = content.split('\n');
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.startsWith('# ')) {
      breakPoints.push({ pos, score: 100, type: 'h1', lineNo });
    } else if (line.startsWith('## ')) {
      breakPoints.push({ pos, score: 90, type: 'h2', lineNo });
    } else if (line.startsWith('### ')) {
      breakPoints.push({ pos, score: 80, type: 'h3', lineNo });
    } else if (line.startsWith('#### ') || line.startsWith('##### ') || line.startsWith('###### ')) {
      breakPoints.push({ pos, score: 70, type: 'h4-h6', lineNo });
    } else if (line.startsWith('```')) {
      breakPoints.push({ pos, score: 80, type: 'code-fence', lineNo });
    } else if (line.trim() === '---' || line.trim() === '***' || line.trim() === '___') {
      breakPoints.push({ pos, score: 60, type: 'hr', lineNo });
    } else if (line.trim() === '') {
      breakPoints.push({ pos, score: 20, type: 'blank', lineNo });
    } else if (/^(\s*)([-*+]|\d+\.)\s/.test(line)) {
      breakPoints.push({ pos, score: 5, type: 'list', lineNo });
    } else {
      breakPoints.push({ pos, score: 1, type: 'newline', lineNo });
    }

    pos += line.length + 1;
  }

  return breakPoints;
}

export function findCodeFences(content: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const lines = content.split('\n');
  let pos = 0;
  let fenceStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (fenceStart === null) {
        fenceStart = pos;
      } else {
        regions.push({ start: fenceStart, end: pos + line.length });
        fenceStart = null;
      }
    }

    pos += line.length + 1;
  }

  if (fenceStart !== null) {
    regions.push({ start: fenceStart, end: content.length });
  }

  return regions;
}

export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetPos: number,
  windowSize: number,
  codeFences: CodeFenceRegion[]
): number {
  const windowStart = targetPos - windowSize;
  const windowEnd = targetPos + windowSize;

  const candidateBreaks = breakPoints.filter(
    bp => bp.pos >= windowStart && bp.pos <= windowEnd
  );

  if (candidateBreaks.length === 0) {
    const insideTargetFence = codeFences.some(
      fence => targetPos >= fence.start && targetPos < fence.end
    );
    if (insideTargetFence) {
      const fence = codeFences.find(f => targetPos >= f.start && targetPos < f.end);
      if (fence) {
        return fence.end;
      }
    }
    return targetPos;
  }

  let bestBreak = candidateBreaks[0];
  let bestScore = -1;

  for (const bp of candidateBreaks) {
    const insideFence = codeFences.some(
      fence => bp.pos >= fence.start && bp.pos < fence.end
    );

    if (insideFence) {
      continue;
    }

    const distance = Math.abs(bp.pos - targetPos);
    const distancePenalty = Math.pow(distance / windowSize, 2) * 0.7;
    const finalScore = bp.score * (1 - distancePenalty);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestBreak = bp;
    }
  }

  if (bestScore === -1) {
    const insideTargetFence = codeFences.some(
      fence => targetPos >= fence.start && targetPos < fence.end
    );
    if (insideTargetFence) {
      const fence = codeFences.find(f => targetPos >= f.start && targetPos < f.end);
      if (fence) {
        return fence.end;
      }
    }
    return targetPos;
  }

  return bestBreak.pos;
}

export function chunkMarkdown(
  content: string,
  hash: string,
  options?: ChunkOptions
): MemoryChunk[] {
  const maxChunkSize = options?.maxChunkSize ?? 3600;
  const minChunkSize = options?.minChunkSize ?? 200;
  const overlap = options?.overlap ?? 540;
  const windowSize = 800;

  if (content.length <= maxChunkSize) {
    return [{
      hash,
      seq: 0,
      pos: 0,
      text: content,
      startLine: 1,
      endLine: content.split('\n').length,
    }];
  }

  const breakPoints = findBreakPoints(content);
  const codeFences = findCodeFences(content);
  const chunks: MemoryChunk[] = [];
  let currentPos = 0;
  let seq = 0;

  while (currentPos < content.length) {
    const targetPos = currentPos + maxChunkSize;

    let cutoff: number;
    if (targetPos >= content.length) {
      cutoff = content.length;
    } else {
      cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    }

    const chunkText = content.slice(currentPos, cutoff);
    const beforeChunk = content.slice(0, currentPos);
    const startLine = beforeChunk.split('\n').length;
    const endLine = startLine + chunkText.split('\n').length - 1;

    chunks.push({
      hash,
      seq,
      pos: currentPos,
      text: chunkText,
      startLine,
      endLine,
    });

    if (cutoff >= content.length) {
      break;
    }

    const nextPos = cutoff - overlap;
    if (nextPos <= currentPos) {
      currentPos = cutoff;
    } else {
      currentPos = nextPos;
    }
    seq++;
  }

  return chunks;
}
