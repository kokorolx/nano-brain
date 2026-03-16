import { log } from './logger.js';
import type { Store } from './types.js';

export interface WorkspaceProfileData {
  topTopics: Array<{ topic: string; count: number }>;
  topCollections: Array<{ collection: string; count: number }>;
  queryCount: number;
  expandCount: number;
  expandRate: number;
  lastUpdated: string;
  categoryWeights?: Record<string, number>;
  lastCategoryUpdate?: string;
}

export class WorkspaceProfile {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  loadProfile(workspaceHash: string): WorkspaceProfileData | null {
    try {
      const row = this.store.getWorkspaceProfile?.(workspaceHash);
      if (!row) return null;
      return JSON.parse(row.profile_data) as WorkspaceProfileData;
    } catch {
      return null;
    }
  }

  saveProfile(workspaceHash: string, data: WorkspaceProfileData): void {
    try {
      this.store.saveWorkspaceProfile?.(workspaceHash, JSON.stringify(data));
    } catch (err) {
      log('workspace-profile', 'Failed to save profile: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  isNewWorkspace(workspaceHash: string): boolean {
    return this.loadProfile(workspaceHash) === null;
  }

  updateFromTelemetry(workspaceHash: string): void {
    try {
      const stats = this.store.getTelemetryStats(workspaceHash);
      const topKeywords = this.store.getTelemetryTopKeywords(workspaceHash, 20);
      const existingProfile = this.loadProfile(workspaceHash);
      const expandRate = stats.queryCount > 0 ? stats.expandCount / stats.queryCount : 0;
      const profileData: WorkspaceProfileData = {
        topTopics: topKeywords.map(k => ({ topic: k.keyword, count: k.count })),
        topCollections: existingProfile?.topCollections ?? [],
        queryCount: stats.queryCount,
        expandCount: stats.expandCount,
        expandRate,
        lastUpdated: new Date().toISOString(),
      };
      this.saveProfile(workspaceHash, profileData);
      log('workspace-profile', `Updated profile for ${workspaceHash}: ${stats.queryCount} queries, ${topKeywords.length} topics`);
    } catch (err) {
      log('workspace-profile', 'Failed to update from telemetry: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}
