#!/usr/bin/env bash
# Precompress a static bundle in place for embedding into tvim (-tags
# embed_assets). For each compressible asset above a size threshold, write
# `<file>.gz` and DROP the raw original, so the binary ships only the compressed
# bytes and the server serves them with `Content-Encoding: gzip` (no per-request
# compression, far smaller download). The AssetServer handles the rest: it
# prefers a `.gz` sibling for gzip-capable clients and gunzips on the fly for the
# rare client that can't take gzip.
#
# Run this on the build-site.sh output BEFORE `go build -tags embed_assets`:
#
#   ../web/build-site.sh server/site
#   ./precompress.sh server/site
#   go build -tags embed_assets -o tvim ./cmd/tvim
#
# Idempotent: an already-compressed file (raw gone, .gz present) is skipped.
# Only touches the embed copy — build-site.sh's own output (used by the Pages
# deploy and the dev --assets-dir path) is left raw, since GitHub Pages and the
# Range-streaming dev path both want the uncompressed files.
set -euo pipefail

DIR="${1:-server/site}"
[ -d "$DIR" ] || { echo "precompress: not a directory: $DIR" >&2; exit 1; }

# Only compress files whose served Content-Type benefits and that are big enough
# to beat gzip's ~20-byte overhead. Tiny files (proxy-config.js, .nojekyll) stay
# raw. Extensions mirror server/static.go's contentTypes.
THRESHOLD=1024
exts="wasm data js mjs html css json map"

shopt -s nullglob
compressed=0
saved_raw=0
saved_gz=0
while IFS= read -r -d '' f; do
  ext="${f##*.}"
  case " $exts " in *" $ext "*) ;; *) continue ;; esac
  [ -f "$f" ] || continue                 # skip dirs / already-removed
  size=$(stat -c%s "$f")
  [ "$size" -ge "$THRESHOLD" ] || continue
  gzip -9 -n -c "$f" > "$f.gz"
  gzsize=$(stat -c%s "$f.gz")
  rm -f "$f"
  compressed=$((compressed + 1))
  saved_raw=$((saved_raw + size))
  saved_gz=$((saved_gz + gzsize))
  printf '  %-22s %8d -> %8d\n' "$(basename "$f")" "$size" "$gzsize"
done < <(find "$DIR" -type f -print0)

if [ "$compressed" -eq 0 ]; then
  echo "==> precompress: nothing to compress in $DIR (already done?)"
else
  printf '==> precompress: %d files, %d -> %d bytes (%.0f%%) in %s\n' \
    "$compressed" "$saved_raw" "$saved_gz" \
    "$(awk "BEGIN{print 100*$saved_gz/$saved_raw}")" "$DIR"
fi
