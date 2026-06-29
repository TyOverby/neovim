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

# Latest successful run of the workflow on the branch.
echo "==> Finding latest successful ${WORKFLOW} run on ${REPO}@${BRANCH} ..."
run_id="$(gh run list -R "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" \
  --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
[ -n "$run_id" ] || { echo "error: no successful run found" >&2; exit 1; }

echo "==> Downloading ${ARTIFACT} from run ${run_id} into ${OUT}/ ..."
mkdir -p "$OUT"
gh run download "$run_id" -R "$REPO" -n "$ARTIFACT" -D "$OUT"

# The artifact extracts to a file named after the os/arch; land it at ./rvim.
src="${OUT%/}/${ARTIFACT}"
bin="${OUT%/}/rvim"
[ -f "$src" ] || { echo "error: expected ${src} after download" >&2; exit 1; }
mv -f "$src" "$bin"
chmod +x "$bin"
echo "==> Done: ${bin}"
