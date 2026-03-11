import * as crypto from 'crypto';

export function generateQueryId(): string {
  return crypto.randomUUID();
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 0));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 0));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

export function detectReformulation(
  currentQuery: string,
  recentQueries: Array<{ id: number; query_text: string }>
): number | null {
  const current = currentQuery.toLowerCase();
  for (const recent of recentQueries) {
    const prev = recent.query_text.toLowerCase();
    if (current === prev) continue;
    const jaccard = jaccardSimilarity(current, prev);
    if (jaccard > 0.5) return recent.id;
    const maxLen = Math.max(current.length, prev.length);
    if (maxLen > 0) {
      const lev = levenshteinDistance(current, prev);
      if (lev < maxLen * 0.3) return recent.id;
    }
  }
  return null;
}
