## Why

No single command exists to fully reset nano-brain. Users must manually delete SQLite databases, Qdrant collections, harvested markdown files, and harvest state across multiple locations. This is error-prone and undiscoverable.

## What Changes

- Add `nano-brain reset` command that deletes all nano-brain data in one shot:
  - All SQLite database files in the data directory
  - All harvested session markdown files and harvest state
  - Qdrant `nano-brain` collection (if reachable)
- Requires `--confirm` flag to prevent accidental data loss
- Supports `--dry-run` to preview what would be deleted

## Capabilities

### New Capabilities
- `reset`: CLI command to delete all nano-brain data (databases, harvested sessions, Qdrant vectors)

### Modified Capabilities

## Impact

- `src/index.ts`: New `handleReset` function + case in command switch + help text update
- No API changes, no breaking changes to existing commands
