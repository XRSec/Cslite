#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/deploy/scf/dist"
ESBUILD_BIN="$ROOT_DIR/node_modules/.bin/esbuild"

if [ ! -x "$ESBUILD_BIN" ]; then
  echo "Error: esbuild not found at $ESBUILD_BIN. Run npm install first." >&2
  exit 1
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

BANNER="import { createRequire as __csliteCreateRequire } from 'node:module'; const require = __csliteCreateRequire(import.meta.url);"

"$ESBUILD_BIN" "$ROOT_DIR/server/src/entry-node.ts" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=esm \
  --minify \
  --banner:js="$BANNER" \
  --external:node:sqlite \
  --external:mysql2 \
  --external:mysql2/promise \
  --outfile="$DIST_DIR/index.mjs"

"$ESBUILD_BIN" "$ROOT_DIR/server/src/entry-scf.ts" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=esm \
  --minify \
  --banner:js="$BANNER" \
  --external:node:sqlite \
  --external:mysql2 \
  --external:mysql2/promise \
  --outfile="$DIST_DIR/scf.mjs"

cp "$ROOT_DIR/deploy/scf/scf_bootstrap" "$DIST_DIR/scf_bootstrap"
chmod 755 "$DIST_DIR/scf_bootstrap"

cat > "$DIST_DIR/package.json" <<'EOF'
{
  "name": "cslite-scf",
  "private": true,
  "type": "module",
  "main": "scf.mjs",
  "dependencies": {
    "mysql2": "^3.24.6"
  }
}
EOF

npm --prefix "$DIST_DIR" install --omit=dev --no-audit --no-fund --no-package-lock

if command -v zip >/dev/null 2>&1; then
  (
    cd "$DIST_DIR"
    zip -qr "$DIST_DIR/cslite-scf.zip" index.mjs scf.mjs scf_bootstrap package.json node_modules
  )
  echo "Built SCF bundle and archive at $DIST_DIR/cslite-scf.zip"
else
  echo "Built SCF bundle at $DIST_DIR (zip not installed; skipped archive)"
fi
