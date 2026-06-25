#!/usr/bin/env bash
# build-release.sh - build self-contained `rvim` release binaries.
#
# Each binary embeds the browser bundle (`-tags embed_assets`) and is statically
# linked (CGO_ENABLED=0), so it's a single file with no runtime dependencies —
# scp it to a laptop (app-server) or a remote host and run it. The SAME binary
# does every mode: `rvim --root … --proxy` (local), `rvim --remote user@host …`
# (three-tier app-server), and `rvim --serve-stdio` (the remote endpoint).
#
# Prereq: the wasm engine is built (wasm/build-deps.sh && wasm/build-nvim.sh).
#
#   ./build-release.sh                       # default platform set
#   TARGETS="linux/amd64 darwin/arm64" ./build-release.sh
set -euo pipefail
cd "$(dirname "$0")"   # wasm/rvim

# Assemble the bundle into the //go:embed dir (server/site, gitignored).
../web/build-site.sh server/site >/dev/null
echo "==> bundle: server/site ($(du -sh server/site | cut -f1))"

mkdir -p dist
export CGO_ENABLED=0
TARGETS="${TARGETS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64}"
for t in $TARGETS; do
  os="${t%/*}"; arch="${t#*/}"
  out="dist/rvim-${os}-${arch}"
  GOOS="$os" GOARCH="$arch" go build -tags embed_assets -trimpath -ldflags="-s -w" -o "$out" ./cmd/rvim
  echo "==> built $out ($(du -h "$out" | cut -f1))"
done
echo "==> done; binaries in $(pwd)/dist/"
