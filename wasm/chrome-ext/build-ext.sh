#!/usr/bin/env bash
# wasm/chrome-ext/build-ext.sh - assemble the UNPACKED Chrome extension.
#
# Compiles the extension's TypeScript (src/*.ts, two tsc passes like
# wasm/web/build-ts.sh), rebuilds the library layers it embeds, and lays out a
# load-ready extension directory:
#
#   Usage:  wasm/chrome-ext/build-ext.sh [output-dir]     (default: _ext here)
#           NVIM_EXT_VARIANT=full|core|minimal            (default: core)
#
# Load it via chrome://extensions -> Developer mode -> "Load unpacked".
#
# Prereqs: a finished wasm/build-nvim.sh (engine + runtime variants under
# build-wasm/bin, npm deps installed under wasm/web and wasm/grid-renderer).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT="${ROOT}/wasm/chrome-ext"
WEB="${ROOT}/wasm/web"
BUILD="${ROOT}/build-wasm/bin"
MSGPACK="${WEB}/node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js"
OUT="${1:-${EXT}/_ext}"
VARIANT="${NVIM_EXT_VARIANT:-core}"

case "${VARIANT}" in full|core|minimal) ;; *)
  echo "NVIM_EXT_VARIANT must be full|core|minimal (got '${VARIANT}')"; exit 1 ;;
esac

TSC="${WEB}/node_modules/.bin/tsc"
[ -x "${TSC}" ] || { echo "missing ${TSC} (run: cd wasm/web && npm install)"; exit 1; }

# Library layers this extension embeds: the core/UI (web/dist) and the canvas
# renderer (grid-renderer/dist). Rebuild both so the bundle is always fresh.
"${WEB}/build-ts.sh"
"${ROOT}/wasm/grid-renderer/build-ts.sh"
GRID_RENDERER="${ROOT}/wasm/grid-renderer/dist/grid-renderer.js"

for f in "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" \
         "${BUILD}/nvim-${VARIANT}.data" "${BUILD}/nvim-${VARIANT}.data.js"; do
  [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
done
[ -f "${MSGPACK}" ] || { echo "missing ${MSGPACK} (run: cd wasm/web && npm install)"; exit 1; }

echo "==> tsc: extension scripts"
rm -rf "${EXT}/dist-page" "${EXT}/dist-sw"
"${TSC}" -p "${EXT}/tsconfig.page.json"
"${TSC}" -p "${EXT}/tsconfig.sw.json"

echo "==> assemble ${OUT} (runtime variant: ${VARIANT})"
rm -rf "${OUT}"
mkdir -p "${OUT}"

# Extension shell.
cp "${EXT}/manifest.json" "${EXT}/offscreen.html" "${OUT}/"
cp "${EXT}/dist-page/ext-common.js" "${EXT}/dist-page/trigger.js" \
   "${EXT}/dist-page/overlay.js" "${EXT}/dist-page/offscreen.js" \
   "${EXT}/dist-sw/background.js" "${EXT}/dist-sw/ext-engine-worker.js" "${OUT}/"
# Build-time config read by offscreen.js (which runtime variant to boot).
printf 'globalThis.NVIM_EXT_CONFIG = { plugins: %s };\n' "'${VARIANT}'" > "${OUT}/ext-config.js"

# Library layers (UMD; injected into pages / loaded by the offscreen doc).
cp "${WEB}/dist/neovim.js" "${WEB}/dist/neovim-ui.js" "${WEB}/dist/engine-worker.js" "${OUT}/"
cp "${GRID_RENDERER}" "${OUT}/grid-renderer.js"
cp "${MSGPACK}" "${OUT}/msgpack.min.js"

# The engine + the selected runtime variant.
cp "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${OUT}/"
cp "${BUILD}/nvim-${VARIANT}.data" "${BUILD}/nvim-${VARIANT}.data.js" "${OUT}/"

rm -rf "${EXT}/dist-page" "${EXT}/dist-sw"

echo "==> unpacked extension assembled in ${OUT}"
ls -la "${OUT}"
