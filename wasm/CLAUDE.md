# wasm/ — dev / build / test quick reference

See **`README.md`** for the capability reference (what the port does, the
embedding API, the standalone-app design) — it is large and user-facing, so it is
**not** auto-included here; read it on demand. **This file is the operational
companion**: every build, dev, and test script in `wasm/`, what it needs, and
what it produces. Stage history lives in `docs/history/stage{1..5}.md`.

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
| `go` ≥ 1.24 | the `rvim` server + its tests | deps are fetched from the module proxy on first build (pinned by `go.sum`); needs network the first time, then cached. |
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

The page + library JS is **TypeScript** in `web/src/*.ts`, compiled by
`web/build-ts.sh` (plain `tsc`, no bundler) into the gitignored `web/dist/`
(`neovim{,-ui,-utils}.js` UMD + `.mjs` ESM + `.d.ts`/`.d.mts`, plus `app.js` /
`engine-worker.js`). `serve.js`, `build-site.sh`, and `build-lib.sh` all consume
`web/dist/`. So after editing `web/src/*.ts`, run `web/build-ts.sh` (or `cd
wasm/web && npm run build`) before reloading; `build-site.sh`/`build-lib.sh` and
`npm test` run it for you. `pre.js` / runtime / C changes still need the wasm
rebuild (`build-nvim.sh`).

The page paints through the **canvas grid renderer** — `grid-renderer/`, its
own npm package (bitmap glyph cache + `putImageData` blits + path-drawn
box-drawing/braille/legacy-computing glyphs ported from ghostty; see
`grid-renderer/README.md`). `neovim-ui.js`'s `mount_into` targets a `<canvas>`
and resolves the `GridRenderer` UMD global (index.html loads
`grid-renderer.js` before `neovim-ui.js`, like msgpack for `neovim.js`).
After editing `grid-renderer/src/*.ts`, run `grid-renderer/build-ts.sh` before
reloading. The legacy `<pre>` DOM renderer is kept as a **testing utility**
(`web/src/neovim-ui-pre-testutil.ts` → plain-CJS `web/dist/neovim-ui-pre-testutil.js`,
not shipped in the site/lib bundles).

## Build scripts

| Script | Produces / does | Prereqs · key flags |
|---|---|---|
| `web/build-ts.sh` | Compiles the page + library **TypeScript** (`web/src/*.ts`) into `web/dist/` (gitignored): `neovim{,-ui,-utils}.js` (UMD + global), `.mjs` (ESM), `.d.ts`/`.d.mts`, `app.js`, `engine-worker.js`, plus the plain-CJS `neovim-ui-pre-testutil.js` (test-only, not shipped). Three `tsc` passes (no bundler); cores are UMD-wrapped by `web/tools/umd-wrap.mjs`. Also runnable as `npm run build` in `wasm/web`. | Needs `npm install` in `wasm/web` (the `typescript` devDependency). |
| `grid-renderer/build-ts.sh` | Compiles the **canvas grid renderer** package (`grid-renderer/src/*.ts`, app-agnostic — see `grid-renderer/README.md`) into `grid-renderer/dist/` (gitignored): `dist/cjs/**` (CommonJS + `.d.ts`, what Node/tests `require()`) and `dist/grid-renderer.js` (single-file UMD linked by `grid-renderer/tools/bundle-umd.mjs`; sets `globalThis.GridRenderer`). `serve.js` / `build-site.sh` / `build-lib.sh` ship the UMD next to `neovim-ui.js`. | Needs `npm install` in `wasm/grid-renderer` (`typescript`, `canvas`). `build-nvim.sh` / `build-site.sh` / `build-lib.sh` run it for you. |
| `build-ts.sh` | Compiles the wasm/ host **TypeScript** (`src/*.ts`) **in place** (gitignored) to the filenames the engine build + hosts expect: `proxy-client.js` / `proxy-reconnect.js` (UMD — `require()` in Node + `self.ProxyClient`/`ProxyReconnect` under classic-worker importScripts) and `worker.js` (Node worker_thread host, CommonJS). Two `tsc` passes; proxy client UMD-wrapped by `tools/umd-wrap.mjs`. The six Emscripten link inputs (`pre.js`, `extern-pre.js`, `nvim_io.js`, `nvim_{fs,proc,sock}_proxy.js`) are **not** built here — they stay hand-written. | Needs `npm install` in `wasm/` (`typescript` + `@types/node`). `build-nvim.sh` / `build-site.sh` / `build-lib.sh` run it for you. |
| `build-deps.sh` | Cross-compiles libuv, PUC Lua 5.1, lpeg, luv, tree-sitter (+ parsers), unibilium, utf8proc → `.deps-wasm/usr`. Vendors libuv internal headers into the install (for `uv_stubs.c`). | **Fast path**: exits early if `.deps-wasm/usr/lib/liblua.a` exists. CI caches only `.deps-wasm/usr` (never the configure tree — it embeds emsdk's absolute path). Force a rebuild by removing `.deps-wasm`. |
| `build-nvim.sh [extra cmake args…]` | Cross-compiles `nvim` → `build-wasm/bin/nvim.{js,wasm}`; compiles the wasm/ host TS (`build-ts.sh`) and copies the Node engine host (`worker.js`, `proxy-client.js`, `proxy-reconnect.js`) next to it; stages + `file_packager`s the **three runtime variants** (`nvim-{full,core,minimal}.data` + `.data.js`); generates `doc/tags` for `full`; runs the **boot gate**; installs `wasm/` + `wasm/web` npm deps. Extra args pass through to the configure `cmake`. | Needs `build-deps.sh` done + `build/lib/libnlua0.so` + `.deps/usr/bin/luajit`. Runtime is **not** baked into `nvim.wasm` — it's packaged out-of-band per variant (see *Runtime variants* below). |
| `web/build-site.sh [out=_site]` | Flat, relative-path **demo site** (all three variants, msgpack UMD, a no-op `proxy-config.js`, `.nojekyll`). For GitHub Pages / any static host. Runs `build-ts.sh` first, then ships `web/dist/`. | Needs `build-nvim.sh` + `npm install` in `wasm/web`. |
| `web/build-lib.sh [out=_lib] [version] [--variant full\|core\|minimal\|all]` | Redistributable **npm library** bundle: UMD + ESM entry points + **`.d.ts`/`.d.mts` types**, engine worker, msgpack (UMD + ESM under `msgpack.esm/`), engine assets, generated `package.json` with an `exports` map (incl. `types`). Runs `build-ts.sh` first. `--variant` selects which runtime(s) to ship (default `full`; `all` = switchable at runtime). Version defaults from `CMakeLists.txt`. | Same prereqs as `build-site.sh`. |
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
| `node wasm/web/e2e.test.js` | Boots the real engine in a Node `worker_thread` (`worker.js`) and drives it through the compiled `dist/neovim.js` + `neovim-ui.js` + `neovim-utils.js` — locks the core/renderer split + the msgpack-RPC contract end to end. Also covers `screenToCells` (the canvas-renderer cell resolution) and the `<pre>` test utility (`dist/neovim-ui-pre-testutil.js`). | Needs `build-nvim.sh` + `wasm/web` npm deps + `dist/` built (`web/build-ts.sh`). Node ≥ 24 (or 22 + flag). Run as `npm test` in `wasm/web` (its `pretest` builds `dist/` first). |
| `cd wasm/grid-renderer && npm run bench` | Renderer benchmark: per-frame wall time for scroll/edit/noop/sprites scenarios + cache-get/blit/rasterize microbenches (seeded-deterministic content; cairo-on-CPU — treat results as relative, run before/after a perf change). Flags: `--cols/--rows/--dpr/--frames`, or name specific scenarios. | Needs `npm install` in `wasm/grid-renderer`. |
| `cd wasm/grid-renderer && npm test` | The canvas renderer's own suite: **snapshot (golden-image) tests** of every path-drawn Unicode block + text styles/decorations against committed PNGs in `test/baselines/` (on node-canvas/cairo, no browser; NOT a skia binding - those retain every blit payload and OOM sustained rendering), plus unit tests of the glyph cache/LRU, damage tracking, cursor, and wide cells. On failure inspect `test/__artifacts__/<name>.{actual,diff}.png`; accept intended changes with `npm run promote` (re-review the images, then commit the baselines). Text-scene baselines are font-dependent (DejaVu Sans Mono assumed); sprite scenes are pure geometry and machine-stable. | Needs `npm install` in `wasm/grid-renderer`. No engine build needed. |
| `node wasm/web/reconnect.test.js` | The `ReconnectingProxy` fault-injection test: real facade + real `proxy-client` + a mock WS server, with a mid-flight drop → asserts in-flight fail-fast, during-outage fail-fast, auto-reconnect, pushes survive. Drives the compiled `wasm/proxy-{client,reconnect}.js`. | Needs `ws` + the wasm/ TS built (both via `build-nvim.sh`, or `cd wasm && npm install && ./build-ts.sh`). |
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
  into `wasm/web/node_modules`, and `typescript` + `@types/node` into
  `wasm/node_modules` (for `wasm/build-ts.sh`), if missing.
- **wasm/ TS host.** Runs `wasm/build-ts.sh` to compile `wasm/src/*.ts` →
  `proxy-client.js` / `proxy-reconnect.js` / `worker.js` before copying them next
  to `nvim.js` in `build-wasm/bin`.

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
io-proxy). See `rvim/README.md` and `docs/history/stage5.md`.

## Layout map

| Path | Role |
|---|---|
| `build-deps.sh`, `build-nvim.sh` | the two-step wasm engine build. |
| `shim.h`, `uv_stubs.c`, `extern-pre.js`, `pre.js` | compile/link glue (force-include, libc/libuv gap-fills, argv/`$VIMRUNTIME`/env, `locateFile`). |
| `nvim_io.js` | JSPI `__syscall_poll` + the postMessage channel for fd 0/1. |
| `nvim_fs_proxy.js`, `nvim_proc_proxy.js`, `nvim_sock_proxy.js` | the stage-4 **opt-in** `--js-library` proxy backends (FS / process+PTY / socket+DNS). Inert with no proxy. |
| `src/proxy-client.ts`, `src/proxy-reconnect.ts` | **TypeScript** source for the proxy wire client/codec + the `ReconnectingProxy` facade. `build-ts.sh` compiles them to UMD `proxy-client.js` / `proxy-reconnect.js` at the wasm/ root (gitignored). |
| `src/worker.ts` | **TypeScript** source for the Node engine host (worker_thread) — used by `e2e.test.js`. `build-ts.sh` compiles it to `worker.js` (gitignored). |
| `build-ts.sh` (+ `tsconfig.*.json`, `tools/umd-wrap.mjs`, `package.json`) | the wasm/ TS build (see the build-scripts table). |
| `grid-renderer/` | the **canvas grid renderer** npm package (app-agnostic): `src/renderer.ts` (GridRenderer: glyph cache + putImageData), `src/rasterizer.ts`, `src/sprite-canvas.ts` (ghostty coverage-canvas port), `src/draw/*` (path-drawn box/block/braille/powerline/branch/legacy-computing glyphs, ported from ghostty `src/font/sprite/draw/*.zig`), `test/` (snapshot harness + baselines), `build-ts.sh` + `tools/bundle-umd.mjs`. See `grid-renderer/README.md`. |
| `web/src/` | browser target **TypeScript source**: `neovim.ts` (RPC core), `neovim-ui.ts` (headless Screen + canvas UI via grid-renderer), `neovim-ui-pre-testutil.ts` (legacy `<pre>` renderer, test utility), `neovim-utils.ts` (helpers), `*.mts` (ESM entry points), `app.ts` (page glue), `engine-worker.ts` (Web Worker host). |
| `web/` | build + run harness: `build-ts.sh` (+ `tsconfig.*.json`, `tools/umd-wrap.mjs`), `serve.js`, `build-site.sh`, `build-lib.sh`, `e2e.test.js`, `reconnect.test.js`. `dist/` = gitignored `tsc` output (the `.js`/`.mjs`/`.d.ts` everything else consumes). |
| `rvim/` | the Go server: `server/` (HTTP + `/proxy` WS + handler families + session-host), `cmd/rvim` (binary), `cmd/conformance`, `proxy/` (codec), `conformance/` (in-process suite), `e2e/` (headless-Chrome, separate module). |
| `docs/history/stage{1..5}.md` | design history per stage. |
| `*.log` | gitignored build logs from prior runs. |
