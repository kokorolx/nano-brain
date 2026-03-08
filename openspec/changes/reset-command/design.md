## Context

Users need a way to fully reset nano-brain state. Currently requires 4 manual steps across different locations. The `init --force --all` command only deletes SQLite files — it misses Qdrant vectors and harvested session files.

## Goals / Non-Goals

**Goals:**
- Single command to delete all nano-brain data
- Safe by default (requires `--confirm`)
- Dry-run support to preview deletions
- Best-effort Qdrant cleanup (skip if unreachable)

**Non-Goals:**
- Deleting config.yml (user configuration should survive reset)
- Per-workspace reset (already handled by `rm` and `init --force`)

## Decisions

### D1: Command name and flags

`nano-brain reset --confirm [--dry-run]`

- `--confirm` is mandatory — prevents accidental data loss
- `--dry-run` previews what would be deleted without deleting
- No positional arguments

### D2: Deletion targets

| Target | Location | Method |
|--------|----------|--------|
| SQLite databases | `~/.nano-brain/data/*.sqlite` | `fs.unlinkSync` each file |
| Harvested sessions | `~/.nano-brain/sessions/` | `fs.rmSync(dir, { recursive: true })` |
| Qdrant collection | `http://localhost:6333/collections/nano-brain` | HTTP DELETE, skip if unreachable |

### D3: Qdrant URL resolution

Read `vector.url` from config.yml if present, otherwise default to `http://localhost:6333`. Use existing `resolveHostUrl()` helper. Best-effort — if Qdrant is down, log a warning and continue.

### D4: Output format

Show what was deleted with counts:
```
🗑️  Deleted 3 database files from ~/.nano-brain/data/
🗑️  Deleted harvested sessions from ~/.nano-brain/sessions/
🗑️  Deleted Qdrant collection 'nano-brain' (1,234 vectors)
✅ Reset complete.
```

## Files Changed

| File | Changes |
|------|---------|
| `src/index.ts` | Add `handleReset()`, add `case 'reset'` in switch, update `showHelp()` |

## Risks

1. Accidental data loss — mitigated by mandatory `--confirm` flag
2. Qdrant unreachable — handled gracefully with warning message
