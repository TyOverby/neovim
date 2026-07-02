#!/usr/bin/env bash
# Download the most recent CI-built `rvim` binary for an os/arch.
#
# Pulls the `rvim-<os>-<arch>` artifact from the latest SUCCESSFUL run of the
# deploy-wasm-pages.yml workflow (the build that also deploys Pages) and lands it
# at <OUT>/rvim. Defaults to this machine's os/arch; override by passing them or
# via env.
#
#   ./download-rvim.sh                 # host os/arch  -> ./rvim
#   ./download-rvim.sh linux amd64     # explicit      -> ./rvim
#   OUT=/usr/local/bin ./download-rvim.sh darwin arm64 # -> /usr/local/bin/rvim
#
# Env: REPO (default TyOverby/neovim), BRANCH (default wasm-build),
#      OUT (output dir, default .). Requires the `gh` CLI, authenticated.
set -euo pipefail

REPO="${REPO:-TyOverby/neovim}"
BRANCH="${BRANCH:-wasm-build}"
WORKFLOW="deploy-wasm-pages.yml"
OUT="${OUT:-.}"

# Default os/arch to this host, normalized to Go's GOOS/GOARCH spelling.
host_os() { case "$(uname -s)" in Linux) echo linux ;; Darwin) echo darwin ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac; }
host_arch() { case "$(uname -m)" in x86_64|amd64) echo amd64 ;; arm64|aarch64) echo arm64 ;; *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; esac; }

OS="${1:-$(host_os)}"
ARCH="${2:-$(host_arch)}"
ARTIFACT="rvim-${OS}-${ARCH}"

command -v gh >/dev/null || { echo "error: gh CLI not found (https://cli.github.com)" >&2; exit 1; }

# Newest completed run that actually HAS our artifact. Deliberately NOT
# `--status success`: the run-level conclusion conflates unrelated jobs — a
# hung/cancelled/failed Pages `deploy` marks the whole run cancelled even
# though every build-rvim job succeeded and uploaded fresh artifacts. Filtering
# on run success then silently falls back to an OLDER run's binary (stale
# bundle). So instead walk recent completed runs newest-first and take the
# first one the artifact can be downloaded from.
echo "==> Finding newest ${WORKFLOW} run on ${REPO}@${BRANCH} with ${ARTIFACT} ..."
run_ids="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" \
  --limit 15 --json databaseId,status --jq '.[] | select(.status == "completed") | .databaseId')"
[ -n "$run_ids" ] || { echo "error: no completed runs found" >&2; exit 1; }

mkdir -p "$OUT"
# Download into a fresh temp subdir: gh's path-traversal guard rejects
# `-D .` (and any pre-populated destination can confuse it), and this keeps a
# failed download from leaving partial files in OUT.
tmpdir="$(mktemp -d "${OUT%/}/.rvim-dl.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

run_id=""
for id in $run_ids; do
  echo "==> Trying run ${id} ..."
  if gh run download "$id" -R "$REPO" -n "$ARTIFACT" -D "$tmpdir" 2>/dev/null; then
    run_id="$id"
    break
  fi
done
[ -n "$run_id" ] || { echo "error: no recent run has artifact ${ARTIFACT} (expired, or the build-rvim jobs failed?)" >&2; exit 1; }
echo "==> Downloaded ${ARTIFACT} from run ${run_id}"

# The artifact extracts to a file named after the os/arch; land it at ./rvim.
src="${tmpdir}/${ARTIFACT}"
bin="${OUT%/}/rvim"
[ -f "$src" ] || { echo "error: expected ${src} after download" >&2; exit 1; }
mv -f "$src" "$bin"
chmod +x "$bin"
echo "==> Done: ${bin}"
