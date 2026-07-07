#!/usr/bin/env bash
# wasm/grid-renderer/build-ts.sh - compile the renderer TypeScript.
#
# Produces (gitignored):
#   dist/cjs/**        tsc CommonJS output + .d.ts (what Node/tests require())
#   dist/grid-renderer.js   single-file UMD (browser <script> -> globalThis.GridRenderer,
#                           require() in Node) linked by tools/bundle-umd.mjs
#
# Prereq: `npm install` under wasm/grid-renderer (typescript devDependency).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${HERE}"

TSC="${HERE}/node_modules/.bin/tsc"
[ -x "${TSC}" ] || { echo "missing ${TSC} (run: cd wasm/grid-renderer && npm install)"; exit 1; }

rm -rf "${HERE}/dist"
mkdir -p "${HERE}/dist"

echo "==> tsc: src/ -> dist/cjs"
"${TSC}" -p "${HERE}/tsconfig.json" --outDir "${HERE}/dist/cjs"

echo "==> link dist/cjs -> dist/grid-renderer.js (UMD, global GridRenderer)"
node "${HERE}/tools/bundle-umd.mjs" "${HERE}/dist/cjs" index "${HERE}/dist/grid-renderer.js" GridRenderer

echo "==> done:"
ls -la "${HERE}/dist"
