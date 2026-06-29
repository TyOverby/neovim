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
#   Usage:  wasm/web/build-lib.sh [output-dir] [version] [--variant <name>]
#             output-dir  default: <repo>/_lib
#             version     default: derived from CMakeLists.txt (NVIM_VERSION_*),
#                         else 0.0.0. Pass an explicit semver to override.
#             --variant   which runtime bundle to ship: full (default) | core |
#                         minimal. The shared nvim.wasm + the chosen variant's
#                         (nvim-<variant>.data + loader) are copied as plain
#                         nvim.data / nvim.data.js so the worker loads them with no
#                         per-embedder config. (Pass --variant all to ship every
#                         variant under its nvim-<variant>.* name instead, for an
#                         embedder that wants to select via create({ plugins }).)
#
# Prereqs: a finished `wasm/build-nvim.sh` (provides build-wasm/bin/nvim.{js,wasm}
# + nvim-<variant>.data/.data.js) and `npm install` under wasm/web (@msgpack).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB="${ROOT}/wasm/web"
DIST="${WEB}/dist"
BUILD="${ROOT}/build-wasm/bin"
MSGPACK="${WEB}/node_modules/@msgpack/msgpack/dist.umd/msgpack.min.js"
MSGPACK_ESM="${WEB}/node_modules/@msgpack/msgpack/dist.esm"

# Parse args: positional [output-dir] [version] plus an optional --variant <name>.
VARIANT="full"
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:-}"; shift 2 ;;
    --variant=*) VARIANT="${1#--variant=}"; shift ;;
    *) POS+=("$1"); shift ;;
  esac
done
set -- "${POS[@]+"${POS[@]}"}"
OUT="${1:-${ROOT}/_lib}"
case "${VARIANT}" in
  full|core|minimal|all) ;;
  *) echo "invalid --variant '${VARIANT}' (full|core|minimal|all)"; exit 1 ;;
esac

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
# Which runtime variants to ship: a single one, or all three for create({plugins}).
if [ "${VARIANT}" = "all" ]; then SHIP_VARIANTS=(full core minimal); else SHIP_VARIANTS=("${VARIANT}"); fi
for f in "${BUILD}/nvim.js" "${BUILD}/nvim.wasm"; do
  [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
done
for v in "${SHIP_VARIANTS[@]}"; do
  for f in "${BUILD}/nvim-${v}.data" "${BUILD}/nvim-${v}.data.js"; do
    [ -f "$f" ] || { echo "missing $f (run wasm/build-nvim.sh first)"; exit 1; }
  done
done
[ -f "${MSGPACK}" ] || { echo "missing ${MSGPACK} (run: cd wasm/web && npm install)"; exit 1; }
[ -f "${MSGPACK_ESM}/index.mjs" ] || { echo "missing ${MSGPACK_ESM}/index.mjs (run: cd wasm/web && npm install)"; exit 1; }

# The page + library JS is compiled from TypeScript (wasm/web/src) into dist/ by
# build-ts.sh; the proxy client (proxy-client.js / proxy-reconnect.js, copied
# below) from wasm/src. Build both first so the bundle always ships fresh artifacts.
"${WEB}/build-ts.sh"
"${ROOT}/wasm/build-ts.sh"

rm -rf "${OUT}"
mkdir -p "${OUT}"

# --- library JS: UMD source + ESM entry points + engine worker + types -------
# All compiled from src/*.ts into dist/ (see build-ts.sh).
cp "${DIST}/neovim.js" "${DIST}/neovim-ui.js" "${DIST}/neovim-utils.js" \
   "${DIST}/neovim.mjs" "${DIST}/neovim-ui.mjs" "${DIST}/neovim-utils.mjs" \
   "${DIST}/engine-worker.js" "${OUT}/"
# TypeScript declarations: .d.ts for require()/UMD consumers, .d.mts for ESM.
cp "${DIST}"/neovim.d.ts "${DIST}"/neovim-ui.d.ts "${DIST}"/neovim-utils.d.ts \
   "${DIST}"/neovim.d.mts "${DIST}"/neovim-ui.d.mts "${DIST}"/neovim-utils.d.mts "${OUT}/"
# Stage 4 IO-proxy client (lives in wasm/, one dir up): the engine worker
# importScripts('proxy-client.js') at runtime when create({ proxy }) is used, so
# it must sit next to nvim.js in the bundle root. Harmless when no proxy is used.
cp "${ROOT}/wasm/proxy-client.js" "${ROOT}/wasm/proxy-reconnect.js" "${OUT}/"
# msgpack UMD dep (the <script> global path; also handed to engine-worker.js)
cp "${MSGPACK}" "${OUT}/msgpack.min.js"
# msgpack ESM build (the .mjs entry imports this so ESM `create()` works with NO
# separate msgpack wiring). It is multi-file with relative .mjs imports, so copy
# the whole dist.esm tree into msgpack.esm/ -- preserving the sibling .mjs files
# that index.mjs imports. (.d.ts/.map are optional; keep them, they're harmless.)
mkdir -p "${OUT}/msgpack.esm"
cp -R "${MSGPACK_ESM}/." "${OUT}/msgpack.esm/"
# engine wasm assets (resolved relative to the worker at runtime; see neovim.js):
# the shared nvim.wasm + nvim.js, plus the chosen runtime variant(s) under their
# nvim-<variant>.data / nvim-<variant>.data.js names. engine-worker.js loads
# nvim-<plugins>.data.js (default plugins='full'); a single non-full bundle is
# selected by the embedder with create({ plugins: '<variant>' }).
cp "${BUILD}/nvim.js" "${BUILD}/nvim.wasm" "${OUT}/"
for v in "${SHIP_VARIANTS[@]}"; do
  cp "${BUILD}/nvim-${v}.data" "${BUILD}/nvim-${v}.data.js" "${OUT}/"
done

# --- generated package.json (npm-publishable / importable) -------------------
# `main` -> the UMD core (require()/bundlers); `exports` map -> the ESM entry
# points so `import` resolves to the .mjs wrappers, with the renderer under a
# subpath. `files` is implicit (publish the whole flat dir). The shipped runtime
# variant package(s) are exported under their nvim-<variant>.data(.js) names.
VARIANT_EXPORTS=""
for v in "${SHIP_VARIANTS[@]}"; do
  VARIANT_EXPORTS="${VARIANT_EXPORTS}
    \"./nvim-${v}.data\": \"./nvim-${v}.data\",
    \"./nvim-${v}.data.js\": \"./nvim-${v}.data.js\","
done
cat > "${OUT}/package.json" <<JSON
{
  "name": "neovim-wasm",
  "version": "${VERSION}",
  "description": "Neovim compiled to WebAssembly: a headless msgpack-RPC core plus a default grid renderer, runnable entirely in the browser.",
  "type": "module",
  "main": "neovim.js",
  "module": "neovim.mjs",
  "types": "neovim.d.ts",
  "exports": {
    ".": {
      "types": "./neovim.d.ts",
      "import": "./neovim.mjs",
      "require": "./neovim.js",
      "default": "./neovim.mjs"
    },
    "./ui": {
      "types": "./neovim-ui.d.ts",
      "import": "./neovim-ui.mjs",
      "require": "./neovim-ui.js",
      "default": "./neovim-ui.mjs"
    },
    "./utils": {
      "types": "./neovim-utils.d.ts",
      "import": "./neovim-utils.mjs",
      "require": "./neovim-utils.js",
      "default": "./neovim-utils.mjs"
    },
    "./engine-worker.js": "./engine-worker.js",
    "./nvim.js": "./nvim.js",
    "./nvim.wasm": "./nvim.wasm",${VARIANT_EXPORTS}
    "./msgpack.min.js": "./msgpack.min.js",
    "./msgpack.esm/": "./msgpack.esm/"
  },
  "license": "Apache-2.0"
}
JSON

# Serve every file verbatim under static hosts (mirror build-site.sh).
touch "${OUT}/.nojekyll"

echo "==> Library bundle assembled in ${OUT} (version ${VERSION}, runtime variant: ${VARIANT})"
ls -la "${OUT}"
if [ "${VARIANT}" = "all" ]; then
  SELECT_HINT="// all three variants shipped; pick one (default 'full'):
  const nvim = create({ baseUrl: '/lib/', plugins: 'core', args: ['-n'] });"
elif [ "${VARIANT}" = "full" ]; then
  SELECT_HINT="// 'full' is the default; no plugins option needed.
  const nvim = create({ baseUrl: '/lib/', args: ['-n'] });"
else
  SELECT_HINT="// this bundle ships only the '${VARIANT}' runtime; select it:
  const nvim = create({ baseUrl: '/lib/', plugins: '${VARIANT}', args: ['-n'] });"
fi
cat <<USAGE

Import from the bundle (host it under any same-origin path, e.g. /lib/):

  // ESM -- no separate msgpack wiring needed; neovim.mjs bundles the ESM build.
  import { create } from '/lib/neovim.mjs';
  import { mount_into } from '/lib/neovim-ui.mjs';
  ${SELECT_HINT}
  await nvim.ready;

  // or UMD via <script> (sets globalThis.Neovim / globalThis.NeovimUI):
  // <script src="/lib/msgpack.min.js"></script>
  // <script src="/lib/neovim.js"></script>
  // <script src="/lib/neovim-ui.js"></script>

baseUrl makes engine-worker.js, nvim.js, nvim.wasm and the nvim-<variant>.data
package all resolve under that path. NOTE: new Worker() is same-origin only, so
baseUrl may be a subpath of the page's origin but not a different-origin CDN (yet).
USAGE
