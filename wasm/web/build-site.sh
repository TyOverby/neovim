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
BUILD="${ROOT}/build-wasm/bin"
MSGPACK="${WEB}/node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js"
OUT="${1:-${ROOT}/_site}"

for f in "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${BUILD}/nvim.data"; do
  [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
done
[ -f "${MSGPACK}" ] || { echo "missing ${MSGPACK} (run: cd wasm/web && npm install)"; exit 1; }

rm -rf "${OUT}"
mkdir -p "${OUT}"

# Page + library layers (flat, relative-path references)
cp "${WEB}/index.html" "${WEB}/neovim.js" "${WEB}/neovim-ui.js" "${WEB}/app.js" \
   "${WEB}/engine-worker.js" "${OUT}/"
# msgpack UMD bundle
cp "${MSGPACK}" "${OUT}/msgpack.min.js"
# wasm artifacts
cp "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${BUILD}/nvim.data" "${OUT}/"

# Tell GitHub Pages not to run Jekyll, so it serves every file verbatim. The
# transport is postMessage, so no COOP/COEP headers are needed — any static host
# works as-is.
touch "${OUT}/.nojekyll"

echo "==> Site assembled in ${OUT}"
ls -la "${OUT}"
