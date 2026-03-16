const CATEGORY_RULES: Record<string, { keywords: string[]; patterns?: RegExp[] }> = {
  'architecture-decision': {
    keywords: ['decided', 'chose', 'architecture', 'design decision', 'trade-off', 'approach'],
    patterns: [/\bdecided\s+to\b/i, /\bchose\s+\w+\s+over\b/i, /\barchitectural\b/i],
  },
  'debugging-insight': {
    keywords: ['error', 'fix', 'bug', 'stack trace', 'crash', 'exception', 'workaround'],
    patterns: [/\bfixed\s+by\b/i, /\broot\s+cause\b/i, /\bstack\s*trace\b/i],
  },
  'tool-config': {
    keywords: ['config', 'setup', 'install', 'environment', 'settings', 'configuration'],
    patterns: [/\bconfigure[ds]?\b/i, /\.ya?ml\b/i, /\.env\b/i, /\.json\b/i],
  },
  'pattern': {
    keywords: ['pattern', 'convention', 'idiom', 'best practice', 'anti-pattern'],
    patterns: [/\bpattern\b/i, /\bconvention\b/i, /\bbest\s+practice\b/i],
  },
  'preference': {
    keywords: ['prefer', 'avoid', 'like', 'dislike', 'style', 'opinion'],
    patterns: [/\bprefer\s+\w+\s+over\b/i, /\bavoid\s+using\b/i, /\bdon't\s+like\b/i],
  },
  'context': {
    keywords: ['context', 'background', 'overview', 'summary', 'explanation'],
    patterns: [/\bfor\s+context\b/i, /\bbackground\s*:/i, /\bsummary\s*:/i],
  },
  'workflow': {
    keywords: ['workflow', 'process', 'steps', 'procedure', 'checklist'],
    patterns: [/\bstep\s+\d+\b/i, /\bprocedure\s*:/i, /\bchecklist\b/i],
  },
};

export function categorize(content: string): string[] {
  const lowerContent = content.toLowerCase();
  const tags: string[] = [];

  for (const [category, rules] of Object.entries(CATEGORY_RULES)) {
    let matched = false;

    for (const keyword of rules.keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        matched = true;
        break;
      }
    }

    if (!matched && rules.patterns) {
      for (const pattern of rules.patterns) {
        if (pattern.test(content)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      tags.push(`auto:${category}`);
    }
  }

  return tags;
}
