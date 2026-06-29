@README.md

# wasm/ — dev / build / test quick reference

The `README.md` above is the capability reference (what the port does, the
embedding API, the standalone-app design). **This section is the operational
companion**: every build, dev, and test script in `wasm/`, what it needs, and
what it produces. Stage history lives in `stage{1..5}.md`.

Everything is **additive and `EMSCRIPTEN`-guarded** — the normal native build is
untouched. All shell scripts are `set -euo pipefail` and resolve paths relative
to the repo root, so they run from anywhere.

## Prerequisites

| Need | For | Notes |
|---|---|---|
| `emcc` (Emscripten) ≥ 3.1.6x | the wasm engine | needs `-sJSPI`. emsdk or Debian `emscripten` apt layout both work. |
| `cmake` + `ninja` | the wasm engine | |
| A **native** build in `build/` | cross-compile codegen | provides `build/lib/libnlua0.so` (`cmake --build build --target nlua0`) + host `luajit` at `.deps/usr/bin/luajit`. |
| Node ≥ 24 (26 tested) | engine host, dev server, JS tests | Node 22 works with `--experimental-wasm-jspi`; ≤ 20 unsupported. The flag only goes on the top-level node — the engine worker inherits `process.execArgv`. |
| `go` ≥ 1.24 | the `rvim` server + its tests | deps are vendored (`wasm/rvim/vendor/`), so builds are hermetic / offline. |
| `gh` (authenticated) | `rvim/download-rvim.sh` only | |
| Chrome/Chromium ≥ 137 | browser run + `rvim/e2e` | JSPI on by default. The e2e **skips** (not fails) without it. |

## Canonical build order

```sh
# 0. one-time: native helper for codegen (host arch)
cmake --build build --target nlua0          # produces build/lib/libnlua0.so

# 1. the wasm engine (run from anywhere)
wasm/build-deps.sh                           # deps  -> .deps-wasm/usr   (slow; cached)
wasm/build-nvim.sh                           # nvim  -> build-wasm/bin/  (nvim.js/.wasm + 3 data variants)

# 2a. browser demo
node wasm/web/serve.js                        # http://localhost:8000/

# 2b. OR a redistributable npm library bundle
wasm/web/build-lib.sh _lib                    # importable bundle in _lib/

# 2c. OR the static Pages site
wasm/web/build-site.sh _site

# 2d. OR the standalone server (real FS/procs/PTY/LSP)
cd wasm/rvim && go build -o rvim ./cmd/rvim
./rvim --assets-dir <build-site output> --root ~/project --proxy
```

Only `pre.js` / runtime / C changes need a rebuild; editing the page JS
(`web/*.js`) is a plain reload under `serve.js`.

## Build scripts

| Script | Produces / does | Prereqs · key flags |
|---|---|---|
| `build-deps.sh` | Cross-compiles libuv, PUC Lua 5.1, lpeg, luv, tree-sitter (+ parsers), unibilium, utf8proc → `.deps-wasm/usr`. Vendors libuv internal headers into the install (for `uv_stubs.c`). | **Fast path**: exits early if `.deps-wasm/usr/lib/liblua.a` exists. CI caches only `.deps-wasm/usr` (never the configure tree — it embeds emsdk's absolute path). Force a rebuild by removing `.deps-wasm`. |
| `build-nvim.sh [extra cmake args…]` | Cross-compiles `nvim` → `build-wasm/bin/nvim.{js,wasm}`; copies the Node engine host (`worker.js`, `proxy-client.js`, `proxy-reconnect.js`) next to it; stages + `file_packager`s the **three runtime variants** (`nvim-{full,core,minimal}.data` + `.data.js`); generates `doc/tags` for `full`; runs the **boot gate**; installs `wasm/web` npm deps. Extra args pass through to the configure `cmake`. | Needs `build-deps.sh` done + `build/lib/libnlua0.so` + `.deps/usr/bin/luajit`. Runtime is **not** baked into `nvim.wasm` — it's packaged out-of-band per variant (see *Runtime variants* below). |
| `web/build-site.sh [out=_site]` | Flat, relative-path **demo site** (all three variants, msgpack UMD, a no-op `proxy-config.js`, `.nojekyll`). For GitHub Pages / any static host. | Needs `build-nvim.sh` + `npm install` in `wasm/web`. |
| `web/build-lib.sh [out=_lib] [version] [--variant full\|core\|minimal\|all]` | Redistributable **npm library** bundle: UMD + ESM entry points, engine worker, msgpack (UMD + ESM under `msgpack.esm/`), engine assets, generated `package.json` with an `exports` map. `--variant` selects which runtime(s) to ship (default `full`; `all` = switchable at runtime). Version defaults from `CMakeLists.txt`. | Same prereqs as `build-site.sh`. |
| `rvim/build-release.sh` | Cross-compiles **self-contained `rvim` binaries** (`CGO_ENABLED=0`, `-tags embed_assets`, bundle baked in) into `rvim/dist/` for a target set. | Needs the wasm engine built. `TARGETS="linux/amd64 darwin/arm64" ./build-release.sh` to override (default: linux/darwin × amd64/arm64). Embeds via `web/build-site.sh server/site` first. |
| `rvim/precompress.sh [dir=server/site]` | Gzips embeddable assets in place (`.gz`, drops the raw) so the embedded binary serves `Content-Encoding: gzip`. Idempotent; ~47 MB → ~20 MB binary. **Only** run on the embed copy. CI runs it before the embed build. | Run between `build-site.sh server/site` and `go build -tags embed_assets`. |
| `rvim/download-rvim.sh [os] [arch]` | Pulls the latest **CI-built** `rvim-<os>-<arch>` artifact (from `deploy-wasm-pages.yml`) → `./rvim`. Defaults to host os/arch. | Needs `gh`. Env: `REPO` (default `TyOverby/neovim`), `BRANCH` (default `wasm-build`), `OUT` (default `.`). |

## Running the engine directly (headless, Node)

```sh
node build-wasm/bin/nvim.js -- --version
node build-wasm/bin/nvim.js -- -u NONE --headless -l script.lua
# Node 22/23: prefix `node --experimental-wasm-jspi …`; 24+ need no flag.
```

Under Node the runtime is read straight from the on-disk `runtime/` tree via the
NODEFS mount (`pre.js` points `$VIMRUNTIME` at `../../runtime`) — the `.data`
packages are a browser-only concern.

## Tests

| Command | What it tests | Notes |
|---|---|---|
| `node wasm/web/e2e.test.js` | Boots the real engine in a Node `worker_thread` (`worker.js`) and drives it through `neovim.js` + `neovim-ui.js` + `neovim-utils.js` — locks the core/renderer split + the msgpack-RPC contract end to end. | Needs `build-nvim.sh` + `wasm/web` npm deps. Node ≥ 24 (or 22 + flag). Also runnable as `npm test` in `wasm/web`. |
| `node wasm/web/reconnect.test.js` | The `ReconnectingProxy` fault-injection test: real facade + real `proxy-client` + a mock WS server, with a mid-flight drop → asserts in-flight fail-fast, during-outage fail-fast, auto-reconnect, pushes survive. | Needs `ws` (installed by `build-nvim.sh`). |
| `cd wasm/rvim && go test ./...` | Frame codec unit tests + the **in-process conformance suite** (every IO seam: base/fs/proc/pty/sock, the jail, disconnect cleanup, the SSH-stdio relay, `--rc`, the session-host daemon). No Node, no network. | If `$HOME/go` is read-only, prefix `GOMODCACHE=/tmp/gomodcache`. Run under `-race` for the proc/pty/sock paths. |
| `cd wasm/rvim && go run ./cmd/conformance` | The same conformance scenarios with a pass/fail summary (non-test entry point). | |
| `cd wasm/rvim/e2e && go test -v` | **Headless-Chrome** browser→engine→Go-server e2e: real FS read/write, `system()` spawn, `glob`, a `:terminal` PTY, the `--remote` relay, `--rc` modes, durable-terminal rehydrate. | **Separate Go module** (keeps chromedp out of the production build). **Skips** without Chrome or a built bundle. Point at a prebuilt bundle with `RVIM_BUNDLE=<build-site output>`; else it runs `build-site.sh` itself. |

## What `build-nvim.sh` does internally (so changes don't break it)

- **Runtime variants.** `nvim.wasm` is runtime-agnostic. The script stages three
  subsets of `runtime/` and `file_packager`s each into `nvim-<variant>.data` +
  `.data.js`. The exact file-inclusion lists (`SYNTAX_FRAMEWORK`, `PACKADD_PLUGINS`,
  `CORE_BOOT_FILES`, `SYNTAX_LANGS`) live in the script — **the subset is a build
  artifact**, not a runtime toggle. `create({ plugins })` only selects which
  already-built package to load.
- **The boot gate (`verify_variant`).** Each staged variant must boot clean under
  `-n` (plugins loaded) inside an isolated empty `$HOME` — no `E###` and no
  "Press ENTER" prompt (a prompt blocks all RPC → unusable variant). Two traps the
  trimmed variants navigate: `pack/`-`packadd`ing plugin scripts (`netrwPlugin`,
  `matchit`) and the default `syntax on` needing the syntax framework. A failure
  **fails the build**.
- **Help tags.** `doc/tags` (gitignored) is regenerated for `full` by running the
  just-built engine under Node with `:helptags`; without it `:help <topic>` → E149.
- **npm deps.** Installs `@msgpack/msgpack` (UI client) + `ws` (reconnect test)
  into `wasm/web/node_modules` if missing.

## The `rvim` standalone server (runtime usage)

Single Go binary, multiple modes (all from `wasm/rvim/cmd/rvim`). Binds
`127.0.0.1` only; `--proxy` makes visiting the page the standalone app.

```sh
./rvim --root ~/project --port 8001 --proxy            # local (same machine)
./rvim --remote user@host --root /remote/project --proxy   # three-tier over SSH stdio
```

Key flags: `--root` (FS jail, default cwd), `--mount` (`/host`), `--port` (8001),
`--assets-dir` (serve the bundle off disk for dev) vs. embedded (`-tags
embed_assets`), `--rc remote|local|builtin` (where the in-browser nvim's config /
`$HOME` comes from), `--remote-rvim` (path to `rvim` on the remote). **Internal**
(don't pass by hand): `--serve-stdio` (the remote endpoint), `--session-host` /
`--session` / `--daemon-sock` (the durable-PTY daemon, auto-spawned by the
io-proxy). See `rvim/README.md` and `stage5.md`.

## Layout map

| Path | Role |
|---|---|
| `build-deps.sh`, `build-nvim.sh` | the two-step wasm engine build. |
| `shim.h`, `uv_stubs.c`, `extern-pre.js`, `pre.js` | compile/link glue (force-include, libc/libuv gap-fills, argv/`$VIMRUNTIME`/env, `locateFile`). |
| `nvim_io.js` | JSPI `__syscall_poll` + the postMessage channel for fd 0/1. |
| `nvim_fs_proxy.js`, `nvim_proc_proxy.js`, `nvim_sock_proxy.js` | the stage-4 **opt-in** `--js-library` proxy backends (FS / process+PTY / socket+DNS). Inert with no proxy. |
| `proxy-client.js`, `proxy-reconnect.js` | the proxy wire client/codec + the `ReconnectingProxy` facade. |
| `worker.js` | Node engine host (worker_thread) — used by `e2e.test.js`. |
| `web/` | browser target: `neovim.js` (RPC core), `neovim-ui.js` (renderer), `neovim-utils.js` (helpers), `app.js` (page glue), `engine-worker.js` (Web Worker host), `serve.js`, `build-site.sh`, `build-lib.sh`, `*.mjs` ESM mirrors, `e2e.test.js`, `reconnect.test.js`. |
| `rvim/` | the Go server: `server/` (HTTP + `/proxy` WS + handler families + session-host), `cmd/rvim` (binary), `cmd/conformance`, `proxy/` (codec), `conformance/` (in-process suite), `e2e/` (headless-Chrome, separate module). |
| `stage{1..5}.md` | design history per stage. |
| `*.log` | gitignored build logs from prior runs. |
