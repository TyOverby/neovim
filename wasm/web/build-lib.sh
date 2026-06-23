#!/usr/bin/env bash
# wasm/web/build-lib.sh - Assemble a redistributable LIBRARY bundle (distinct
# from the demo *site* built by build-site.sh) into a single flat directory.
#
# The site bundle is a runnable demo page; this library bundle is what an
# embedder consumes: the library JS (UMD + ESM entry points), the engine worker,
# the msgpack UMD dep, the engine wasm assets, and a generated package.json with
# an `exports` map so it is npm-publishable / importable. Everything is referenced
# with RELATIVE paths and `.nojekyll` is dropped, mirroring build-site.sh, so the
# bundle works under any base path / subpath.
#
#   Usage:  wasm/web/build-lib.sh [output-dir] [version]
#             output-dir  default: <repo>/_lib
#             version     default: derived from CMakeLists.txt (NVIM_VERSION_*),
#                         else 0.0.0. Pass an explicit semver to override.
#
# Prereqs: a finished `wasm/build-nvim.sh` (provides build-wasm/bin/nvim.{js,wasm,
# data}) and `npm install` under wasm/web (provides @msgpack/msgpack).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="${ROOT}/wasm/web"
BUILD="${ROOT}/build-wasm/bin"
MSGPACK="${WEB}/node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js"
MSGPACK_ESM="${WEB}/node_modules/@msgpack/msgpack/dist.esm"
OUT="${1:-${ROOT}/_lib}"

# --- version: explicit arg > CMakeLists NVIM_VERSION_* > 0.0.0 ----------------
VERSION="${2:-}"
if [ -z "${VERSION}" ]; then
  CMK="${ROOT}/CMakeLists.txt"
  if [ -f "${CMK}" ]; then
    maj="$(sed -n 's/^set(NVIM_VERSION_MAJOR \([0-9]*\)).*/\1/p' "${CMK}" | head -1)"
    min="$(sed -n 's/^set(NVIM_VERSION_MINOR \([0-9]*\)).*/\1/p' "${CMK}" | head -1)"
    pat="$(sed -n 's/^set(NVIM_VERSION_PATCH \([0-9]*\)).*/\1/p' "${CMK}" | head -1)"
    if [ -n "${maj}" ] && [ -n "${min}" ] && [ -n "${pat}" ]; then
      VERSION="${maj}.${min}.${pat}"
    fi
  fi
fi
VERSION="${VERSION:-0.0.0}"

# --- preconditions (same guard shape as build-site.sh) -----------------------
for f in "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${BUILD}/nvim.data"; do
  [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
done
[ -f "${MSGPACK}" ] || { echo "missing ${MSGPACK} (run: cd wasm/web && npm install)"; exit 1; }
[ -f "${MSGPACK_ESM}/index.mjs" ] || { echo "missing ${MSGPACK_ESM}/index.mjs (run: cd wasm/web && npm install)"; exit 1; }

rm -rf "${OUT}"
mkdir -p "${OUT}"

# --- library JS: UMD source + ESM entry points + engine worker ---------------
cp "${WEB}/neovim.js" "${WEB}/neovim-ui.js" \
   "${WEB}/neovim.mjs" "${WEB}/neovim-ui.mjs" \
   "${WEB}/engine-worker.js" "${OUT}/"
# msgpack UMD dep (the <script> global path; also handed to engine-worker.js)
cp "${MSGPACK}" "${OUT}/msgpack.min.js"
# msgpack ESM build (the .mjs entry imports this so ESM `create()` works with NO
# separate msgpack wiring). It is multi-file with relative .mjs imports, so copy
# the whole dist.esm tree into msgpack.esm/ -- preserving the sibling .mjs files
# that index.mjs imports. (.d.ts/.map are optional; keep them, they're harmless.)
mkdir -p "${OUT}/msgpack.esm"
cp -R "${MSGPACK_ESM}/." "${OUT}/msgpack.esm/"
# engine wasm assets (resolved relative to the worker at runtime; see neovim.js)
cp "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${BUILD}/nvim.data" "${OUT}/"

# --- generated package.json (npm-publishable / importable) -------------------
# `main` -> the UMD core (require()/bundlers); `exports` map -> the ESM entry
# points so `import` resolves to the .mjs wrappers, with the renderer under a
# subpath. `files` is implicit (publish the whole flat dir).
cat > "${OUT}/package.json" <<JSON
{
  "name": "neovim-wasm",
  "version": "${VERSION}",
  "description": "Neovim compiled to WebAssembly: a headless msgpack-RPC core plus a default grid renderer, runnable entirely in the browser.",
  "type": "module",
  "main": "neovim.js",
  "module": "neovim.mjs",
  "exports": {
    ".": {
      "import": "./neovim.mjs",
      "require": "./neovim.js",
      "default": "./neovim.mjs"
    },
    "./ui": {
      "import": "./neovim-ui.mjs",
      "require": "./neovim-ui.js",
      "default": "./neovim-ui.mjs"
    },
    "./engine-worker.js": "./engine-worker.js",
    "./nvim.js": "./nvim.js",
    "./nvim.wasm": "./nvim.wasm",
    "./nvim.data": "./nvim.data",
    "./msgpack.min.js": "./msgpack.min.js",
    "./msgpack.esm/": "./msgpack.esm/"
  },
  "license": "Apache-2.0"
}
JSON

# Serve every file verbatim under static hosts (mirror build-site.sh).
touch "${OUT}/.nojekyll"

echo "==> Library bundle assembled in ${OUT} (version ${VERSION})"
ls -la "${OUT}"
cat <<USAGE

Import from the bundle (host it under any same-origin path, e.g. /lib/):

  // ESM -- no separate msgpack wiring needed; neovim.mjs bundles the ESM build.
  import { create } from '/lib/neovim.mjs';
  import { mount_into } from '/lib/neovim-ui.mjs';
  const nvim = create({ baseUrl: '/lib/', args: ['-n'] });
  await nvim.ready;

  // or UMD via <script> (sets globalThis.Neovim / globalThis.NeovimUI):
  // <script src="/lib/msgpack.min.js"></script>
  // <script src="/lib/neovim.js"></script>
  // <script src="/lib/neovim-ui.js"></script>

baseUrl makes engine-worker.js, nvim.js, nvim.wasm and nvim.data all resolve
under that path. NOTE: new Worker() is same-origin only, so baseUrl may be a
subpath of the page's origin but not a different-origin CDN (yet).
USAGE
