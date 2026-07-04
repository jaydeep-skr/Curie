#!/usr/bin/env bash
# =============================================================================
# release.sh
#
# Local release helper.  Run after `build_bundle.sh` and after archiving in
# Xcode.  Signs the zip with Sparkle, updates appcast.xml, and prints the
# GitHub CLI command to create the release.
#
# Usage:
#   bash macos/scripts/release.sh --version 1.2.0 --build 202505120930
#
# Prerequisites:
#   - Xcode archive already exported to macos/CurieApp/build/export/Curie.app
#   - SPARKLE_PRIVATE_KEY_PATH env var pointing to your private key file
#     (or pass --key /path/to/sparkle_private_key)
#   - Sparkle's `sign_update` tool on PATH
#     (ships inside Sparkle.framework/Versions/B/Resources/sign_update)
#   - gh (GitHub CLI) installed and authenticated
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MACOS_DIR="$REPO_ROOT/macos"
APP_DIR="$MACOS_DIR/CurieApp/build/export"
APPCAST="$MACOS_DIR/appcast.xml"

VERSION=""
BUILD=""
KEY_PATH="${SPARKLE_PRIVATE_KEY_PATH:-}"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --version) VERSION="$2"; shift 2;;
        --build)   BUILD="$2";   shift 2;;
        --key)     KEY_PATH="$2";shift 2;;
        *) echo "Unknown arg: $1"; exit 1;;
    esac
done

[[ -z "$VERSION" ]] && { echo "Error: --version required"; exit 1; }
[[ -z "$BUILD"   ]] && BUILD="$(date +%Y%m%d%H%M)"
[[ -z "$KEY_PATH" ]] && { echo "Error: set SPARKLE_PRIVATE_KEY_PATH or pass --key"; exit 1; }

APP_PATH="$APP_DIR/Curie.app"
ZIP_PATH="$APP_DIR/Curie-${VERSION}.zip"

# ── 1. Zip the .app ───────────────────────────────────────────────────────────
echo "▶ Zipping $APP_PATH…"
cd "$APP_DIR"
ditto -c -k --keepParent Curie.app "Curie-${VERSION}.zip"
SIZE=$(stat -f%z "$ZIP_PATH")
echo "   Size: ${SIZE} bytes"

# ── 2. Sign with Sparkle ──────────────────────────────────────────────────────
echo "▶ Signing with Sparkle…"
# `sign_update` prints the EdDSA signature as a single string
SIG=$(sign_update "$ZIP_PATH" "$KEY_PATH")
echo "   Signature: ${SIG:0:24}…"

# ── 3. Update appcast.xml ─────────────────────────────────────────────────────
echo "▶ Updating $APPCAST…"
python3 "$MACOS_DIR/scripts/update_appcast.py" \
    --appcast   "$APPCAST" \
    --version   "$VERSION" \
    --build     "$BUILD" \
    --sig       "$SIG" \
    --size      "$SIZE" \
    --tag       "v${VERSION}" \
    --gh-org    "YOUR_ORG" \
    --gh-repo   "curie"

# ── 4. Commit and push appcast.xml ────────────────────────────────────────────
cd "$REPO_ROOT"
git add macos/appcast.xml
git commit -m "chore: appcast for v${VERSION}"
git push origin HEAD

# ── 5. Create GitHub Release ──────────────────────────────────────────────────
echo ""
echo "▶ Creating GitHub Release v${VERSION}…"
gh release create "v${VERSION}" \
    "$ZIP_PATH" \
    --title "Curie v${VERSION}" \
    --generate-notes

echo ""
echo "✅  Released v${VERSION}!"
echo "   ZIP  : $ZIP_PATH"
echo "   Users with the app will see the update prompt on next launch."
