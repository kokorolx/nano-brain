import type { MemoryChunk, BreakPoint, CodeFenceRegion } from './types.js';
import * as path from 'path'

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
  let runningLineCount = 1;
  while (currentPos < content.length) {
    const targetPos = currentPos + maxChunkSize;
    let cutoff: number;
    if (targetPos >= content.length) {
      cutoff = content.length;
    } else {
      cutoff = findBestCutoff(breakPoints, targetPos, windowSize, codeFences);
    }
    const chunkText = content.slice(currentPos, cutoff);
    const startLine = runningLineCount;
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
    const prevPos = currentPos;
    if (nextPos <= currentPos) {
      currentPos = cutoff;
    } else {
      currentPos = nextPos;
    }
    const advancedSlice = content.slice(prevPos, currentPos);
    runningLineCount += (advancedSlice.match(/\n/g) || []).length;
    seq++;
  }
  return chunks;
}


const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rb': 'ruby',
  '.erb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
}

export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || 'text'
}

const FUNCTION_DEF_PATTERNS = [
  /^(export\s+)?(async\s+)?function\s+/,
  /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
  /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/,
  /^(export\s+)?class\s+/,
  /^(export\s+)?(interface|type)\s+/,
  /^def\s+\w+\s*\(/,
  /^class\s+\w+/,
  /^func\s+\w+\s*\(/,
  /^fn\s+\w+/,
  /^pub\s+(fn|struct|enum|trait)\s+/,
  /^(public|private|protected)?\s*(static)?\s*(async)?\s*\w+\s*\([^)]*\)\s*{/,
]

const IMPORT_EXPORT_PATTERNS = [
  /^import\s+/,
  /^export\s+/,
  /^from\s+/,
  /^require\s*\(/,
  /^module\.exports/,
  /^package\s+/,
  /^use\s+/,
]

export function findSourceCodeBreakPoints(content: string): BreakPoint[] {
  const breakPoints: BreakPoint[] = []
  const lines = content.split('\n')
  let pos = 0
  let prevLineBlank = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1
    const trimmed = line.trim()

    if (trimmed === '') {
      if (prevLineBlank) {
        breakPoints.push({ pos, score: 90, type: 'double-blank', lineNo })
      } else {
        breakPoints.push({ pos, score: 40, type: 'blank', lineNo })
      }
      prevLineBlank = true
    } else {
      prevLineBlank = false

      let matched = false

      for (const pattern of FUNCTION_DEF_PATTERNS) {
        if (pattern.test(trimmed)) {
          breakPoints.push({ pos, score: 80, type: 'function-def', lineNo })
          matched = true
          break
        }
      }

      if (!matched) {
        for (const pattern of IMPORT_EXPORT_PATTERNS) {
          if (pattern.test(trimmed)) {
            breakPoints.push({ pos, score: 60, type: 'import-export', lineNo })
            matched = true
            break
          }
        }
      }

      if (!matched) {
        breakPoints.push({ pos, score: 1, type: 'line', lineNo })
      }
    }

    pos += line.length + 1
  }

  return breakPoints
}

export function chunkSourceCode(
  content: string,
  hash: string,
  filePath: string,
  workspaceRoot: string,
  options?: ChunkOptions
): MemoryChunk[] {
  const maxChunkSize = options?.maxChunkSize ?? 3600
  const overlap = options?.overlap ?? 540
  const windowSize = 800

  const relativePath = path.relative(workspaceRoot, filePath)
  const language = inferLanguage(filePath)

  const createMetadataHeader = (startLine: number, endLine: number): string => {
    return `File: ${relativePath}\nLanguage: ${language}\nLines: ${startLine}-${endLine}\n\n`
  }

  if (content.length <= maxChunkSize) {
    const lineCount = content.split('\n').length
    const header = createMetadataHeader(1, lineCount)
    return [{
      hash,
      seq: 0,
      pos: 0,
      text: header + content,
      startLine: 1,
      endLine: lineCount,
    }]
  }

  const breakPoints = findSourceCodeBreakPoints(content)
  const chunks: MemoryChunk[] = []
  let currentPos = 0
  let seq = 0
  let runningLineCount = 1
  while (currentPos < content.length) {
    const targetPos = currentPos + maxChunkSize
    let cutoff: number
    if (targetPos >= content.length) {
      cutoff = content.length
    } else {
      cutoff = findBestSourceCodeCutoff(breakPoints, targetPos, windowSize)
    }
    const chunkText = content.slice(currentPos, cutoff)
    const startLine = runningLineCount
    const endLine = startLine + chunkText.split('\n').length - 1
    const header = createMetadataHeader(startLine, endLine)
    chunks.push({
      hash,
      seq,
      pos: currentPos,
      text: header + chunkText,
      startLine,
      endLine,
    })
    if (cutoff >= content.length) {
      break
    }
    const nextPos = cutoff - overlap
    const prevPos = currentPos
    if (nextPos <= currentPos) {
      currentPos = cutoff
    } else {
      currentPos = nextPos
    }
    const advancedSlice = content.slice(prevPos, currentPos)
    runningLineCount += (advancedSlice.match(/\n/g) || []).length
    seq++
  }
  return chunks
}

function findBestSourceCodeCutoff(
  breakPoints: BreakPoint[],
  targetPos: number,
  windowSize: number
): number {
  const windowStart = targetPos - windowSize
  const windowEnd = targetPos + windowSize

  const candidateBreaks = breakPoints.filter(
    bp => bp.pos >= windowStart && bp.pos <= windowEnd
  )

  if (candidateBreaks.length === 0) {
    return targetPos
  }

  let bestBreak = candidateBreaks[0]
  let bestScore = -1

  for (const bp of candidateBreaks) {
    const distance = Math.abs(bp.pos - targetPos)
    const distancePenalty = Math.pow(distance / windowSize, 2) * 0.7
    const finalScore = bp.score * (1 - distancePenalty)

    if (finalScore > bestScore) {
      bestScore = finalScore
      bestBreak = bp
    }
  }

  return bestBreak.pos
}