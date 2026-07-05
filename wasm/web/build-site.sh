#!/usr/bin/env bash
# wasm/web/build-site.sh - Assemble the static site for GitHub Pages (or any
# static host) into a single flat directory.
#
# Everything is referenced with RELATIVE paths, so the result works under a
# project subpath like https://<user>.github.io/<repo>/. Prereqs: a finished
# `wasm/build-nvim.sh` (provides build-wasm/bin/nvim.{js,wasm,data} and installs
# the @msgpack npm dep under wasm/web/node_modules).
#
#   Usage:  wasm/web/build-site.sh [output-dir]      (default: _site)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="${ROOT}/wasm/web"
DIST="${WEB}/dist"
BUILD="${ROOT}/build-wasm/bin"
MSGPACK="${WEB}/node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js"
OUT="${1:-${ROOT}/_site}"

# The page + library JS is compiled from TypeScript (wasm/web/src) into dist/,
# the proxy client (proxy-client.js / proxy-reconnect.js, copied below) from
# wasm/src, and the canvas grid renderer from wasm/grid-renderer/src. Build all
# three first so the site always ships fresh artifacts (idempotent).
"${WEB}/build-ts.sh"
"${ROOT}/wasm/build-ts.sh"
"${ROOT}/wasm/grid-renderer/build-ts.sh"
GRID_RENDERER="${ROOT}/wasm/grid-renderer/dist/grid-renderer.js"

# Shared engine + the three runtime-variant packages (full/core/minimal). The
# demo ships all three so it can switch via create({ plugins }) in the browser.
for f in "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" \
         "${BUILD}/nvim-full.data" "${BUILD}/nvim-full.data.js"; do
  [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
done
[ -f "${MSGPACK}" ] || { echo "missing ${MSGPACK} (run: cd wasm/web && npm install)"; exit 1; }

rm -rf "${OUT}"
mkdir -p "${OUT}"

# Page + library layers (flat, relative-path references). index.html is
# hand-written (wasm/web); the JS is the tsc output from dist/.
cp "${WEB}/index.html" "${OUT}/"
cp "${DIST}/neovim.js" "${DIST}/neovim-ui.js" "${DIST}/neovim-ui-pre.js" \
   "${DIST}/neovim-utils.js" "${DIST}/neovim-utils.mjs" \
   "${DIST}/app.js" "${DIST}/engine-worker.js" "${OUT}/"
# Stage 4 IO-proxy client (one dir up, in wasm/): the engine worker
# importScripts('proxy-client.js') at runtime when a `proxy` config is passed, so
# it must sit next to nvim.js in the bundle root. Harmless when no proxy is used.
cp "${ROOT}/wasm/proxy-client.js" "${ROOT}/wasm/proxy-reconnect.js" "${OUT}/"
# index.html unconditionally loads proxy-config.js (the standalone-app hook that
# a serving app can generate with a real proxy config). A static deployment has
# no proxy server, so ship a no-op so the page runs as the no-proxy demo without
# a 404. (`node serve.js` serves the same no-op dynamically.)
printf '%s\n' '// no proxy: static deployment runs the no-proxy demo.' > "${OUT}/proxy-config.js"
# msgpack UMD bundle
cp "${MSGPACK}" "${OUT}/msgpack.min.js"
# canvas grid renderer UMD bundle (index.html loads it before neovim-ui.js)
cp "${GRID_RENDERER}" "${OUT}/grid-renderer.js"
# wasm artifacts: the shared engine + every runtime variant present (so the demo
# can switch full/core/minimal). full is required (checked above); core/minimal
# are copied if built.
cp "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${OUT}/"
for v in full core minimal; do
  if [ -f "${BUILD}/nvim-${v}.data" ]; then
    cp "${BUILD}/nvim-${v}.data" "${BUILD}/nvim-${v}.data.js" "${OUT}/"
  fi
done

# Tell GitHub Pages not to run Jekyll, so it serves every file verbatim. The
# transport is postMessage, so no COOP/COEP headers are needed — any static host
# works as-is.
touch "${OUT}/.nojekyll"

echo "==> Site assembled in ${OUT}"
ls -la "${OUT}"
