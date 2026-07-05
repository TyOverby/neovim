#!/usr/bin/env bash
# Build a tree-sitter grammar as an Emscripten SIDE MODULE — the same artifact
# shape `tree-sitter build --wasm` publishes — for the dynamic-loading spike
# (see README.md). Uses the bundled lua grammar's generated sources from the
# wasm deps build tree.
#
# Usage: ./build-side-module.sh [out-dir]   (default: cwd)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="${ROOT}/.deps-wasm/build/src/treesitter_lua/src"
OUT="${1:-.}"
[ -f "${SRC}/parser.c" ] || { echo "missing ${SRC}/parser.c (run wasm/build-deps.sh; the configure tree must still exist)"; exit 1; }

emcc -O2 -sSIDE_MODULE=2 -sSUPPORT_LONGJMP=wasm \
  -sEXPORTED_FUNCTIONS=_tree_sitter_lua \
  -I "${SRC}" "${SRC}/parser.c" "${SRC}/scanner.c" \
  -o "${OUT}/luadyn.so"
echo "built ${OUT}/luadyn.so ($(stat -c%s "${OUT}/luadyn.so") bytes)"
echo "probe it (needs a -sMAIN_MODULE=2 -fPIC engine build, see README.md):"
echo "  node ${ROOT}/build-wasm/bin/nvim.js -- --clean --headless -i NONE \\"
echo "    --cmd 'set noswapfile' -l $(dirname "${BASH_SOURCE[0]}")/probe.lua ${OUT}/luadyn.so"
