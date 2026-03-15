#!/usr/bin/env bash
# Run MoveMap unit tests in Node.js.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTS_DIR="$REPO_ROOT/tests"

if ! command -v node >/dev/null 2>&1; then
    echo "  [tests] Node.js not found — skipping"
    exit 0
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "${NODE_VERSION:-0}" -lt 18 ]; then
    echo "  [tests] Node.js v18+ required (found v${NODE_VERSION}) — skipping"
    exit 0
fi

echo "  [tests] Running MoveMap tests..."

PASS=0
FAIL=0

run_suite() {
    local file="$1"
    local name
    name=$(basename "$file")
    if node "$file" 2>&1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
        echo "  [tests] FAILED: $name"
    fi
}

run_suite "$TESTS_DIR/test_virtual_knobs.mjs"
run_suite "$TESTS_DIR/test_ableton_state.mjs"
run_suite "$TESTS_DIR/test_sysex.mjs"
run_suite "$TESTS_DIR/test_bank_switching.mjs"

echo "  [tests] $PASS suite(s) passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    echo "  [tests] Fix failures before releasing."
    exit 1
fi
