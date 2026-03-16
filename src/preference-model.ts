import { log } from './logger.js';
import type { Store } from './types.js';
import { WorkspaceProfile } from './workspace-profile.js';

export interface PreferenceConfig {
  enabled: boolean;
  min_queries: number;
  weight_min: number;
  weight_max: number;
  baseline_expand_rate: number;
}

export const DEFAULT_PREFERENCE_CONFIG: PreferenceConfig = {
  enabled: true,
  min_queries: 20,
  weight_min: 0.5,
  weight_max: 2.0,
  baseline_expand_rate: 0.1,
};

export interface CategoryExpandRate {
  accessed: number;
  expanded: number;
}

export function computeCategoryExpandRates(
  store: Store,
  workspaceHash: string
): Record<string, CategoryExpandRate> {
  const db = store.getDb();
  const rates: Record<string, CategoryExpandRate> = {};

  try {
    const telemetryRows = db.prepare(`
      SELECT result_docids, expanded_indices
      FROM search_telemetry
      WHERE workspace_hash = ?
        AND expanded_indices != '[]'
        AND timestamp > datetime('now', '-30 days')
    `).all(workspaceHash) as Array<{ result_docids: string; expanded_indices: string }>;

    for (const row of telemetryRows) {
      let resultDocids: string[];
      let expandedIndices: number[];
      try {
        resultDocids = JSON.parse(row.result_docids) as string[];
        expandedIndices = JSON.parse(row.expanded_indices) as number[];
      } catch {
        continue;
      }

      if (!Array.isArray(resultDocids) || !Array.isArray(expandedIndices)) continue;

      const expandedDocids = new Set<string>();
      for (const idx of expandedIndices) {
        if (idx >= 0 && idx < resultDocids.length) {
          expandedDocids.add(resultDocids[idx]);
        }
      }

      for (let i = 0; i < resultDocids.length; i++) {
        const docid = resultDocids[i];
        const doc = store.findDocument(docid);
        if (!doc) continue;

        const tags = store.getDocumentTags(doc.id);
        const categoryTags = tags.filter(t => t.startsWith('auto:') || t.startsWith('llm:'));

        for (const tag of categoryTags) {
          if (!rates[tag]) {
            rates[tag] = { accessed: 0, expanded: 0 };
          }
          rates[tag].accessed++;
          if (expandedDocids.has(docid)) {
            rates[tag].expanded++;
          }
        }
      }
    }
  } catch (err) {
    log('preference-model', 'Failed to compute category expand rates: ' + (err instanceof Error ? err.message : String(err)));
  }

  return rates;
}

export function computeCategoryWeights(
  store: Store,
  workspaceHash: string,
  config: PreferenceConfig
): Record<string, number> {
  const stats = store.getTelemetryStats(workspaceHash);
  if (stats.queryCount < config.min_queries) {
    log('preference-model', `Cold start: ${stats.queryCount} queries < ${config.min_queries} min_queries, returning neutral weights`);
    return {};
  }

  const rates = computeCategoryExpandRates(store, workspaceHash);
  const weights: Record<string, number> = {};

  for (const [category, rate] of Object.entries(rates)) {
    if (rate.accessed === 0) continue;

    const expandRate = rate.expanded / rate.accessed;
    let weight = expandRate / config.baseline_expand_rate;
    weight = Math.max(config.weight_min, Math.min(config.weight_max, weight));
    weights[category] = weight;
  }

  log('preference-model', `Computed ${Object.keys(weights).length} category weights for workspace ${workspaceHash}`);
  return weights;
}

export function updatePreferenceWeights(
  store: Store,
  workspaceHash: string,
  config: PreferenceConfig
): void {
  try {
    const weights = computeCategoryWeights(store, workspaceHash, config);
    const profile = new WorkspaceProfile(store);
    const existingData = profile.loadProfile(workspaceHash);

    const updatedData = {
      ...(existingData ?? {
        topTopics: [],
        topCollections: [],
        queryCount: 0,
        expandCount: 0,
        expandRate: 0,
        lastUpdated: new Date().toISOString(),
      }),
      categoryWeights: weights,
      lastCategoryUpdate: new Date().toISOString(),
    };

    profile.saveProfile(workspaceHash, updatedData);
    log('preference-model', `Updated preference weights for workspace ${workspaceHash}: ${Object.keys(weights).length} categories`);
  } catch (err) {
    log('preference-model', 'Failed to update preference weights: ' + (err instanceof Error ? err.message : String(err)));
  }
}
