import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceProfile, type WorkspaceProfileData } from '../src/workspace-profile.js';
import { createStore } from '../src/store.js';
import type { Store } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('WorkspaceProfile', () => {
  let store: Store;
  let dbPath: string;
  let profile: WorkspaceProfile;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-profile-test-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    store = createStore(dbPath);
    profile = new WorkspaceProfile(store);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true });
    } catch {}
  });

  describe('isNewWorkspace', () => {
    it('should return true for new workspace', () => {
      expect(profile.isNewWorkspace('abc123')).toBe(true);
    });

    it('should return false after saving profile', () => {
      const data: WorkspaceProfileData = {
        topTopics: [],
        topCollections: [],
        queryCount: 0,
        expandCount: 0,
        expandRate: 0,
        lastUpdated: new Date().toISOString(),
      };
      profile.saveProfile('abc123', data);
      expect(profile.isNewWorkspace('abc123')).toBe(false);
    });
  });

  describe('saveProfile and loadProfile', () => {
    it('should save and load profile data', () => {
      const data: WorkspaceProfileData = {
        topTopics: [{ topic: 'auth', count: 10 }],
        topCollections: [{ collection: 'codebase', count: 50 }],
        queryCount: 100,
        expandCount: 25,
        expandRate: 0.25,
        lastUpdated: '2025-01-01T00:00:00Z',
      };
      
      profile.saveProfile('test-hash', data);
      const loaded = profile.loadProfile('test-hash');
      
      expect(loaded).not.toBeNull();
      expect(loaded?.topTopics).toEqual(data.topTopics);
      expect(loaded?.topCollections).toEqual(data.topCollections);
      expect(loaded?.queryCount).toBe(100);
      expect(loaded?.expandCount).toBe(25);
      expect(loaded?.expandRate).toBe(0.25);
    });

    it('should return null for non-existent profile', () => {
      const loaded = profile.loadProfile('nonexistent');
      expect(loaded).toBeNull();
    });

    it('should update existing profile', () => {
      const data1: WorkspaceProfileData = {
        topTopics: [],
        topCollections: [],
        queryCount: 10,
        expandCount: 2,
        expandRate: 0.2,
        lastUpdated: '2025-01-01T00:00:00Z',
      };
      
      profile.saveProfile('update-test', data1);
      
      const data2: WorkspaceProfileData = {
        topTopics: [{ topic: 'updated', count: 5 }],
        topCollections: [],
        queryCount: 20,
        expandCount: 5,
        expandRate: 0.25,
        lastUpdated: '2025-01-02T00:00:00Z',
      };
      
      profile.saveProfile('update-test', data2);
      const loaded = profile.loadProfile('update-test');
      
      expect(loaded?.queryCount).toBe(20);
      expect(loaded?.topTopics).toEqual([{ topic: 'updated', count: 5 }]);
    });
  });
});
