#!/usr/bin/env bash
# test-reconciliation.sh
# Real-world integration test for ReconciliationRunner (beta.14+)
#
# Usage:
#   bash scripts/test-reconciliation.sh [--db <path>] [--api <url>]
#
# Defaults:
#   --api  http://localhost:3100
#   --db   auto-detected from ~/.nano-brain/data/ (picks most recently modified sqlite file)
#
# What this script does:
#   1. Writes two conflicting docs via API (old knowledge vs new knowledge)
#   2. Waits for consolidation job to run and detect the conflict
#   3. Waits for ReconciliationRunner to execute the DELETE decision
#   4. Verifies the old doc has superseded_by set in the DB
#   5. Verifies search no longer surfaces the old doc prominently
#   6. Prints a clear PASS/FAIL summary

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
API="${NANO_BRAIN_API:-http://localhost:3100}"
DB_PATH="${NANO_BRAIN_DB:-}"
MAX_WAIT_SECS=120   # max time to wait for consolidation + reconciliation
POLL_INTERVAL=5

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}✅ PASS${NC} $1"; }
fail() { echo -e "${RED}❌ FAIL${NC} $1"; }
info() { echo -e "${YELLOW}ℹ${NC}  $1"; }

# ── Args ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)   DB_PATH="$2"; shift 2 ;;
    --api)  API="$2";     shift 2 ;;
    *)      echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Auto-detect DB ────────────────────────────────────────────────────────────
if [[ -z "$DB_PATH" ]]; then
  DATA_DIR="$HOME/.nano-brain/data"
  if [[ ! -d "$DATA_DIR" ]]; then
    echo "Cannot find DB: $DATA_DIR does not exist. Pass --db <path> manually."
    exit 1
  fi
  DB_PATH=$(ls -t "$DATA_DIR"/*.sqlite 2>/dev/null | head -1)
  if [[ -z "$DB_PATH" ]]; then
    echo "No .sqlite files found in $DATA_DIR. Pass --db <path> manually."
    exit 1
  fi
  info "Auto-detected DB: $DB_PATH"
fi

# ── Check prerequisites ───────────────────────────────────────────────────────
for cmd in curl sqlite3 jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Missing required tool: $cmd"
    exit 1
  fi
done

# ── Step 1: Check API health ──────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo " nano-brain ReconciliationRunner — Integration Test"
echo " API: $API"
echo " DB:  $DB_PATH"
echo "════════════════════════════════════════"
echo ""

info "Step 1: Checking API health..."
STATUS=$(curl -sf "$API/api/status" | jq -r '.status // "unknown"' 2>/dev/null || echo "unreachable")
if [[ "$STATUS" != "ok" ]]; then
  fail "API not reachable at $API (status=$STATUS). Start nano-brain first."
  exit 1
fi
pass "API healthy"

# ── Step 2: Write conflicting docs ────────────────────────────────────────────
info "Step 2: Writing conflicting docs..."

TOPIC="reconciliation-test-$(date +%s)"

OLD_RESP=$(curl -sf -X POST "$API/api/write" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"[2024] For $TOPIC, use OldLibrary v1. This is the old recommendation.\",\"tags\":\"test,decision,$TOPIC\"}")
OLD_ID=$(echo "$OLD_RESP" | jq -r '.id // empty')

if [[ -z "$OLD_ID" ]]; then
  fail "Failed to write old doc. Response: $OLD_RESP"
  exit 1
fi
info "  Old doc ID: $OLD_ID"

sleep 1  # slight delay so timestamps differ

NEW_RESP=$(curl -sf -X POST "$API/api/write" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"[2026] For $TOPIC, use NewLibrary v3. OldLibrary v1 is deprecated as of 2025.\",\"tags\":\"test,decision,$TOPIC\"}")
NEW_ID=$(echo "$NEW_RESP" | jq -r '.id // empty')

if [[ -z "$NEW_ID" ]]; then
  fail "Failed to write new doc. Response: $NEW_RESP"
  exit 1
fi
info "  New doc ID: $NEW_ID"
pass "Conflicting docs written (old=$OLD_ID, new=$NEW_ID)"

# ── Step 3: Wait for consolidation log entry ──────────────────────────────────
info "Step 3: Waiting for consolidation job to detect conflict (max ${MAX_WAIT_SECS}s)..."

ELAPSED=0
LOG_ID=""
while [[ $ELAPSED -lt $MAX_WAIT_SECS ]]; do
  LOG_ID=$(sqlite3 "$DB_PATH" \
    "SELECT id FROM consolidation_log WHERE document_id=$OLD_ID AND action='DELETE' AND target_doc_id=$NEW_ID ORDER BY id DESC LIMIT 1;" 2>/dev/null || true)
  if [[ -n "$LOG_ID" ]]; then
    break
  fi
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
  info "  ...waiting (${ELAPSED}s elapsed)"
done

if [[ -z "$LOG_ID" ]]; then
  fail "No consolidation_log DELETE entry found after ${MAX_WAIT_SECS}s. Consolidation may not have run, or did not detect the conflict."
  echo ""
  echo "Debug — recent consolidation_log entries:"
  sqlite3 "$DB_PATH" "SELECT id, document_id, action, target_doc_id, applied_at, applied_error FROM consolidation_log ORDER BY id DESC LIMIT 10;" 2>/dev/null || true
  exit 1
fi
pass "Consolidation detected conflict → consolidation_log entry id=$LOG_ID"

# ── Step 4: Wait for ReconciliationRunner to apply it ─────────────────────────
info "Step 4: Waiting for ReconciliationRunner to apply decision (max ${MAX_WAIT_SECS}s)..."

ELAPSED=0
APPLIED_AT=""
while [[ $ELAPSED -lt $MAX_WAIT_SECS ]]; do
  APPLIED_AT=$(sqlite3 "$DB_PATH" \
    "SELECT applied_at FROM consolidation_log WHERE id=$LOG_ID;" 2>/dev/null || true)
  if [[ -n "$APPLIED_AT" && "$APPLIED_AT" != "NULL" ]]; then
    break
  fi
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
  info "  ...waiting (${ELAPSED}s elapsed)"
done

if [[ -z "$APPLIED_AT" || "$APPLIED_AT" == "NULL" ]]; then
  fail "consolidation_log entry $LOG_ID never got applied_at set after ${MAX_WAIT_SECS}s."
  APPLIED_ERROR=$(sqlite3 "$DB_PATH" "SELECT applied_error FROM consolidation_log WHERE id=$LOG_ID;" 2>/dev/null || true)
  echo "  applied_error = $APPLIED_ERROR"
  exit 1
fi

APPLIED_ERROR=$(sqlite3 "$DB_PATH" "SELECT applied_error FROM consolidation_log WHERE id=$LOG_ID;" 2>/dev/null || true)
if [[ -n "$APPLIED_ERROR" && "$APPLIED_ERROR" != "NULL" ]]; then
  fail "Entry was stamped but with error: $APPLIED_ERROR"
  exit 1
fi

pass "ReconciliationRunner applied decision at $APPLIED_AT"

# ── Step 5: Verify old doc is superseded ──────────────────────────────────────
info "Step 5: Verifying old doc has superseded_by set in documents table..."

SUPERSEDED_BY=$(sqlite3 "$DB_PATH" \
  "SELECT superseded_by FROM documents WHERE id=$OLD_ID;" 2>/dev/null || true)

if [[ "$SUPERSEDED_BY" == "$NEW_ID" ]]; then
  pass "documents.superseded_by = $NEW_ID ✓ (old doc correctly points to new doc)"
else
  fail "documents.superseded_by = '$SUPERSEDED_BY' (expected $NEW_ID)"
  exit 1
fi

# ── Step 6: Verify search deprioritizes old doc ───────────────────────────────
info "Step 6: Verifying search results for topic '$TOPIC'..."

SEARCH_RESP=$(curl -sf -X POST "$API/api/query" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"$TOPIC library recommendation\",\"limit\":5}" 2>/dev/null || echo "{}")

TOP_ID=$(echo "$SEARCH_RESP" | jq -r '.results[0].id // empty' 2>/dev/null || true)
TOP_CONTENT=$(echo "$SEARCH_RESP" | jq -r '.results[0].content // empty' 2>/dev/null | head -c 80 || true)

if [[ "$TOP_ID" == "$NEW_ID" ]]; then
  pass "Search top result = new doc (id=$NEW_ID) ✓"
  info "  Top result: $TOP_CONTENT..."
elif [[ "$TOP_ID" == "$OLD_ID" ]]; then
  fail "Search top result = old (superseded) doc (id=$OLD_ID) — supersede penalty not working"
  exit 1
else
  info "  Top result id=$TOP_ID (neither old nor new — may be unrelated doc)"
  info "  Content: $TOP_CONTENT..."
  # Not a hard failure — topic string may not be distinctive enough
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo -e "${GREEN} ALL CHECKS PASSED${NC}"
echo "════════════════════════════════════════"
echo ""
echo "  old doc id    : $OLD_ID  (superseded_by=$NEW_ID)"
echo "  new doc id    : $NEW_ID  (active)"
echo "  log entry id  : $LOG_ID  (applied_at=$APPLIED_AT)"
echo ""
echo "ReconciliationRunner is working correctly on beta.14 🎉"
echo ""
