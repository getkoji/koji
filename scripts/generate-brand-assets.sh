#!/usr/bin/env bash
# Generate PNG raster outputs from SVG brand sources.
#
# SVGs in assets/ are the source of truth. PNGs are derived artifacts —
# gitignored so they don't drift from the source. Regenerate whenever you
# update an SVG, then upload the PNG to wherever it's consumed
# (GitHub org avatar, repo social preview, Twitter profile, etc.).
#
# Usage:
#   scripts/generate-brand-assets.sh
#
# Requirements:
#   - Google Chrome (used for headless SVG → PNG rendering because it's
#     already on most dev machines, handles web fonts, and needs no extra
#     install). If you'd rather use rsvg-convert or ImageMagick, swap out
#     the render() function below.

set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "error: Google Chrome not found at $CHROME" >&2
  echo "       install Chrome or edit this script to use another renderer" >&2
  exit 1
fi

render() {
  local svg="$1"
  local out="$2"
  local size="$3"

  # Wrap the SVG in a minimal HTML shell so Chrome renders it at the exact
  # pixel size we want, with no scrollbars or browser chrome.
  local html
  html=$(mktemp -t koji-brand-XXXXXX.html)
  cat > "$html" <<HTML
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>
$(cat "$svg")
</body></html>
HTML

  "$CHROME" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --default-background-color=00000000 \
    --window-size="${size},${size}" \
    --screenshot="$out" \
    "file://$html" 2>/dev/null

  rm -f "$html"
  echo "  ✓ $out"
}

echo "Generating brand assets..."

# GitHub avatar — 512×512 PNG with dark background.
# Used for the getkoji org avatar and any repo-level avatar overrides.
render assets/logo-github.svg assets/logo-github.png 512

echo "Done. PNGs are gitignored — upload them where needed but don't commit."
