#!/usr/bin/env bash
# =============================================================================
# build_bundle.sh
#
# Builds the JS/TS codebase, downloads a universal Node.js binary, and copies
# everything into CurieApp/CurieApp/Resources/ so Xcode can bundle it.
#
# Run from the REPO ROOT (parent of both the JS project and macos/):
#   bash macos/scripts/build_bundle.sh
#
# Prerequisites:
#   - Node.js 18+ on PATH (for the build, not for bundling)
#   - npm on PATH
#   - curl, lipo (both ship with macOS)
#   - rsync (ships with macOS)
# =============================================================================
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

NODE_VER="22.14.0"
RESOURCES_DIR="macos/CurieApp/CurieApp/Resources"
REPO_ROOT="$(pwd)"

# ── 1. Build the JS project ───────────────────────────────────────────────────

echo "▶ Installing npm dependencies…"
npm ci

echo "▶ Compiling TypeScript server + Vite client…"
npm run build

echo "▶ Pruning to production dependencies…"
# Use a temp dir so we don't clobber the dev node_modules
PROD_TMP="$(mktemp -d)"
cp package.json package-lock.json "$PROD_TMP/"
cd "$PROD_TMP"
npm ci --omit=dev 2>/dev/null
cd "$REPO_ROOT"

# ── 2. Copy build outputs into Resources ─────────────────────────────────────

echo "▶ Copying build outputs to $RESOURCES_DIR/app/…"
mkdir -p "$RESOURCES_DIR/app"

rsync -a --delete dist/             "$RESOURCES_DIR/app/dist/"
rsync -a --delete "$PROD_TMP/node_modules/" "$RESOURCES_DIR/app/node_modules/"
cp package.json                     "$RESOURCES_DIR/app/package.json"

rm -rf "$PROD_TMP"

# ── 3. Download universal Node.js binary ──────────────────────────────────────

NODE_BIN="$RESOURCES_DIR/node"

if [[ -f "$NODE_BIN" ]]; then
    echo "▶ node binary already present — skipping download."
    echo "   (delete $NODE_BIN to force re-download)"
else
    echo "▶ Downloading Node.js v${NODE_VER} (x64 + arm64)…"
    TMP_DIR="$(mktemp -d)"
    pushd "$TMP_DIR" > /dev/null

    curl -# -O "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-x64.tar.gz"
    curl -# -O "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-arm64.tar.gz"

    echo "▶ Extracting…"
    tar xf "node-v${NODE_VER}-darwin-x64.tar.gz"
    tar xf "node-v${NODE_VER}-darwin-arm64.tar.gz"

    echo "▶ Creating universal binary with lipo…"
    lipo -create \
        "node-v${NODE_VER}-darwin-x64/bin/node" \
        "node-v${NODE_VER}-darwin-arm64/bin/node" \
        -output node_universal

    popd > /dev/null
    cp "$TMP_DIR/node_universal" "$NODE_BIN"
    chmod +x "$NODE_BIN"
    rm -rf "$TMP_DIR"

    echo "▶ Universal node binary written to $NODE_BIN"
    file "$NODE_BIN"
fi

# ── 4. Verify ─────────────────────────────────────────────────────────────────

echo ""
echo "✅  Bundle contents:"
echo "   node binary : $(du -sh "$NODE_BIN" | cut -f1)"
echo "   dist/       : $(du -sh "$RESOURCES_DIR/app/dist" | cut -f1)"
echo "   node_modules: $(du -sh "$RESOURCES_DIR/app/node_modules" | cut -f1)"
echo ""
echo "Now open macos/CurieApp/CurieApp.xcodeproj in Xcode and build."
