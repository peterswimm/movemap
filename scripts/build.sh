#!/usr/bin/env bash
# Build MoveMap module tarball.
# No native compilation needed — JS only.
# Output: dist/movemap-module.tar.gz

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_ROOT/dist/movemap"

echo "Building MoveMap..."

# Clean and create dist
rm -rf "$DIST"
mkdir -p "$DIST/config"

# Copy module files
cp "$REPO_ROOT/src/module.json"                "$DIST/"
cp "$REPO_ROOT/src/ui.mjs"                     "$DIST/"
cp "$REPO_ROOT/src/move_virtual_knobs.mjs"     "$DIST/"
cp "$REPO_ROOT/src/config/movemap_config.mjs"  "$DIST/config/"

# Create tarball
cd "$REPO_ROOT/dist"
tar -czvf movemap-module.tar.gz movemap/
cd "$REPO_ROOT"

echo "Built: dist/movemap-module.tar.gz"
echo "Contents:"
tar -tzvf "$REPO_ROOT/dist/movemap-module.tar.gz"
