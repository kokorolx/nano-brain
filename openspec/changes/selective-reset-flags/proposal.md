## Why

The `reset --confirm` command is all-or-nothing — it deletes databases, sessions, memory, and Qdrant vectors together. Users cannot selectively clean up specific data categories (e.g., only clear sessions while keeping the database).

## What Changes

- Add category flags to `reset` command:
  - `--databases` — Delete SQLite workspace databases (`~/.nano-brain/data/*.sqlite`)
  - `--sessions` — Delete harvested session markdown (`~/.nano-brain/sessions/`)
  - `--memory` — Delete memory notes (`~/.nano-brain/memory/`)
  - `--logs` — Delete log files (`~/.nano-brain/logs/`)
  - `--vectors` — Delete Qdrant collection vectors
- Existing flags unchanged: `--confirm` (required), `--dry-run` (preview)
- No flags + `--confirm` = delete ALL (backward compatible)

## Capabilities

### New Capabilities
- Selective deletion via category flags
- Memory directory deletion (`~/.nano-brain/memory/`)
- Logs directory deletion (`~/.nano-brain/logs/`)

### Modified Capabilities
- `reset`: Now supports category flags for selective deletion

## Impact

- `src/index.ts`: Update `handleReset()` with flag parsing and selective deletion logic
- `src/index.ts`: Update `showHelp()` with new flags documentation
- No breaking changes — existing `reset --confirm` behavior preserved
