#!/usr/bin/env bash
# wasm/build-ts.sh - compile the wasm/ TypeScript sources (src/) into the JS the
# engine build + browser/Node hosts consume. Mirrors wasm/web/build-ts.sh.
#
# The TypeScript in src/ is the SOURCE OF TRUTH. From it this produces, IN PLACE
# at the wasm/ root (gitignored), the same filenames the rest of the toolchain
# already expects:
#
#   proxy-client.js     UMD: require() in Node (worker.js, reconnect.test.js) AND
#   proxy-reconnect.js   self.ProxyClient/ProxyReconnect under classic-worker
#                        importScripts (wasm/web/src/engine-worker.ts).
#   worker.js           Node worker_thread engine host (CommonJS).
#
# HOW: two `tsc` passes (no bundler). The proxy client compiles to CommonJS and is
# UMD-wrapped by tools/umd-wrap.mjs (tsc's own deprecated `module: umd` does not
# assign a global). worker.ts compiles straight to a CommonJS Node script.
#
# The six Emscripten engine-build inputs in wasm/ (pre.js, extern-pre.js,
# nvim_io.js, nvim_{fs,proc,sock}_proxy.js) are NOT built here -- they are
# hand-written Emscripten library/pre-js DSL, linked into nvim.js by
# src/nvim/CMakeLists.txt, and stay committed JS.
#
#   Usage:  wasm/build-ts.sh            (writes wasm/{proxy-client,proxy-reconnect,worker}.js)
#
# Prereq: `npm install` under wasm/ (provides the typescript + @types/node devDeps).
set -euo pipefail

WASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${WASM}"

TSC="${WASM}/node_modules/.bin/tsc"
[ -x "${TSC}" ] || { echo "missing ${TSC} (run: cd wasm && npm install)"; exit 1; }

TMP_LIB="${WASM}/dist-lib"
TMP_WORKER="${WASM}/dist-worker"

rm -rf "${TMP_LIB}" "${TMP_WORKER}"

echo "==> tsc: proxy client (CommonJS, for UMD wrap)"
"${TSC}" -p "${WASM}/tsconfig.lib.json"
echo "==> tsc: node worker host"
"${TSC}" -p "${WASM}/tsconfig.worker.json"

echo "==> wrap proxy client into UMD-with-global"
node "${WASM}/tools/umd-wrap.mjs" "${TMP_LIB}/proxy-client.js"    "${WASM}/proxy-client.js"    ProxyClient
node "${WASM}/tools/umd-wrap.mjs" "${TMP_LIB}/proxy-reconnect.js" "${WASM}/proxy-reconnect.js" ProxyReconnect

echo "==> emit node worker host"
cp "${TMP_WORKER}/worker.js" "${WASM}/worker.js"

rm -rf "${TMP_LIB}" "${TMP_WORKER}"

echo "==> built: proxy-client.js proxy-reconnect.js worker.js"
