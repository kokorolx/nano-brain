## Context

The current `reset` command deletes all nano-brain data at once. Users need granular control to clean up specific categories without losing everything.

## Goals / Non-Goals

**Goals:**
- Add category flags for selective deletion
- Maintain backward compatibility (no flags = all)
- Support `--dry-run` with category flags

**Non-Goals:**
- Interactive prompts (flags only)
- Per-workspace selective reset (use `rm` command)

## Decisions

### D1: Flag-based category selection

Use explicit flags instead of interactive prompts:
- `--databases` — SQLite files
- `--sessions` — Harvested sessions
- `--memory` — Memory notes
- `--logs` — Log files
- `--vectors` — Qdrant collection

### D2: Backward compatibility

No category flags + `--confirm` = delete ALL categories (same as current behavior).

### D3: Dry-run with flags

`--dry-run` works with category flags to preview selective deletion:
```
nano-brain reset --databases --sessions --dry-run
```

### D4: Multiple flags combine

Multiple flags delete multiple categories:
```
nano-brain reset --databases --sessions --confirm
```

## Files Changed

| File | Changes |
|------|---------|
| `src/index.ts` | Update `handleReset()` with flag parsing, add LOGS_DIR constant, update `showHelp()` |

## Risks

1. User confusion about flag combinations — mitigated by clear help text
2. Partial deletion leaving inconsistent state — acceptable, user explicitly chose categories
