---
description: Rescan codebase and refresh all nano-brain indexes after branch switch or code changes.
---

## When to Use

- After `git checkout`, `git pull`, or branch switch
- After major code changes (new files, deleted files, refactors)
- When search results seem stale or missing recent changes

## Steps

1. Call `memory_index_codebase` with `root` = current workspace path
   - Detects new, changed, and deleted files via content hash
   - Only re-indexes what changed (incremental)

2. Call `memory_update` to refresh session and note indexes

3. Call `memory_status` and report:

```
Reindex complete:
- Codebase: X files (Y new, Z updated)
- Pending embeddings: N
```

## Notes

- Reindexing is incremental — unchanged files are skipped
- New/changed files need embedding — happens in background
- If many pending embeddings, they process automatically over time
