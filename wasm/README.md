# Neovim on WebAssembly (Emscripten + Node / Browser)

This directory contains everything needed to cross-compile Neovim to WebAssembly
with Emscripten and run it either **under Node.js** (interactive builtin TUI) or
**in a browser** (a custom JavaScript grid UI on the page). Both use JSPI —
JavaScript Promise Integration — where wasm runs, and a `SharedArrayBuffer`-based
transport between the editor and its UI.

It is **additive**: the normal native build is unchanged. Every change to the
shared build files (`CMakeLists.txt`, `cmake.deps/…`) is guarded by
`if(EMSCRIPTEN)` / `CMAKE_SYSTEM_NAME STREQUAL "Emscripten"`.

## Status

What works today (`node nvim.js -- <args>`):

| Capability | State |
|---|---|
| Cross-compile nvim + all deps to wasm | ✅ |
| `--version`, `--headless`, `-l script.lua` | ✅ |
| Full Lua + `vim.api` + bundled runtime (`$VIMRUNTIME`) | ✅ |
| Real filesystem access (MEMFS + NODEFS under Node) | ✅ |
| `nvim --embed` msgpack-RPC server | ✅ |
| Engine in a worker + client over `SharedArrayBuffer` | ✅ (see `demo-rpc.js`) |
| **Interactive built-in TUI** (`node nvim.js -- file.txt`) | ✅ (stage 2 — see `stage2.md`) |
| **Browser: engine in a Web Worker + pure-JS grid UI** | ✅ (stage 3 — see `stage3.md`, `wasm/web/`) |
| `:terminal`, `:!cmd`, jobs (process spawning) | ❌ stubbed (no spawn in wasm) |

## Prerequisites

- Emscripten (`emcc`) ≥ 3.1.6x (has `-sJSPI`).
- Node with JSPI (`WebAssembly.Suspending`):
  - **v24+** (v26 tested): on by default, no flag.
  - **v22**: pass `--experimental-wasm-jspi` (e.g.
    `node --experimental-wasm-jspi build-wasm/bin/nvim.js -- file.txt`). The engine
    worker inherits `process.execArgv`, so the flag only goes on the top-level node.
  - **v20 and older**: unsupported (only the older `WebAssembly.Suspender` API).
  The `nvim` wrapper in `build-wasm/bin/` adds the flag automatically when needed.
- For the **browser** UI: a JSPI-capable browser (Chrome ≥ 137, on by default) and
  Node (for `serve.js` and the `@msgpack/msgpack` npm dep — installed automatically
  by `build-nvim.sh`).
- A **native** build in `build/` providing the host codegen helper
  `build/lib/libnlua0.so` (`cmake --build build --target nlua0`), plus a host
  Lua 5.1 / LuaJIT interpreter. See *How cross-compilation works*.
- `ninja`, `cmake`.

## Build

```sh
wasm/build-deps.sh     # cross-compiles libuv, lua, lpeg, luv, tree-sitter,
                       # unibilium, utf8proc + TS parsers -> .deps-wasm/usr
wasm/build-nvim.sh     # cross-compiles nvim -> build-wasm/bin/nvim.js (+ .wasm)
```

Then:

```sh
# Interactive editor (builtin TUI on the main thread, engine in a worker).
# The `nvim` wrapper enables JSPI as needed and, for now, defaults to a clean
# session (-u NONE -i NONE); override with $NVIM_WASM_DEFAULTS.
build-wasm/bin/nvim file.txt

# Or invoke node directly (Node 22/23 need the JSPI flag; 24+ don't):
node build-wasm/bin/nvim.js -- file.txt

node build-wasm/bin/nvim.js -- --version
node build-wasm/bin/nvim.js -- -u NONE --headless -l script.lua
( cd build-wasm/bin && node demo-rpc.js )   # shared-memory RPC round-trip
```

### Browser (engine in a Web Worker + pure-JS grid UI)

```sh
node wasm/web/serve.js          # COOP/COEP static server (default :8000)
# then open http://localhost:8000/  in a JSPI-capable browser (Chrome ≥ 137)
```

The page (`wasm/web/`) runs `nvim --embed` in a Web Worker and renders the
`ext_linegrid` grid into a `<pre>` with a small msgpack-RPC client on the main
thread — **no wasm and no JSPI on the page**, only in the Worker. Click the grid
and type. See `stage3.md` for the design and `wasm/web/` for the code.

### Deploy to a static host (GitHub Pages)

The site is fully static — no backend. The only requirement is that the page be
*cross-origin isolated* (for `SharedArrayBuffer`). On hosts that can send headers,
set COOP `same-origin` + COEP `require-corp`. On hosts that can't (GitHub Pages),
`index.html` loads `coi-serviceworker.js`, which injects those headers via a
service worker (one extra reload on first visit; a no-op when headers are already
present, so the dev server is unaffected).

```sh
wasm/web/build-site.sh _site   # gather the flat, relative-path bundle into _site/
```

`.github/workflows/deploy-wasm-pages.yml` does this automatically on every push to
`wasm-build`: it builds the native host helpers, cross-compiles the deps + nvim to
wasm, assembles the site, and deploys to Pages. Enable it once under
**Settings → Pages → Source: GitHub Actions**.

## How cross-compilation works

Neovim generates a lot of C from Lua at build time. Those generators are
host-architecture-independent (they *parse* C/Lua), but they need a host Lua
interpreter plus the `nlua0` Lua C-module. The upstream build already supports
pointing at a prebuilt host `nlua0` via `NLUA0_HOST_PRG` when
`CMAKE_CROSSCOMPILING` is set (Emscripten sets it automatically). So:

- The native `build/` produces `libnlua0.so` and we drive codegen with the host
  LuaJIT (`.deps/usr/bin/luajit`). Generated headers are reused as-is for wasm.
- `PREFER_LUA=ON` links **PUC Lua 5.1** instead of LuaJIT (LuaJIT can't target
  wasm — this is the one thing you flagged early).
- `COMPILE_LUA=OFF` embeds Lua *source*, not bytecode (Lua 5.1 bytecode is
  word-size/endian dependent; host bytecode wouldn't load in wasm32).

## Files in this directory

| File | Purpose |
|---|---|
| `build-deps.sh` | Cross-compile the bundled dependencies to wasm. |
| `build-nvim.sh` | Configure + build nvim to wasm; install launcher/helpers. |
| `shim.h` | Force-included into every emcc compile (`EMCC_CFLAGS`); small libc gap fills (pthread thread-name stubs). |
| `uv_stubs.c` | libuv / libc functions the Emscripten builds omit (sys-info, `uv_exepath`, `sched_*`, `pthread_*_np`). Linked into nvim only for wasm. |
| `pre.js` | Emscripten `--pre-js`: argv, the SAB-channel globals, `$VIMRUNTIME`, and the environment. Node path mounts the host FS via NODEFS; browser path uses the preloaded runtime in MEMFS. |
| `nvim_io.js` | Emscripten `--js-library`: async (JSPI) `__syscall_poll`, SAB-backed channel fds for both roles, host-terminal stdio + winsize + raw mode, and the engine-spawn glue. |
| `sab.js` | `SharedArrayBuffer` ring-buffer byte transport (Node + browser; dual export). |
| `worker.js` | Node engine endpoint: hosts `nvim --embed` wasm in a worker_thread, fd 0/1 backed by the SAB. |
| `demo-rpc.js` | End-to-end proof of shared-memory RPC (client ↔ worker). |
| `web/` | Browser target: `index.html`, `ui.js` (main-thread grid UI + msgpack-RPC client), `engine-worker.js` (Web Worker engine host), `serve.js` (COOP/COEP dev server), `coi-serviceworker.js` (header shim for header-less hosts), `build-site.sh` (assemble the static bundle). Uses `@msgpack/msgpack` (npm). |
| `stage1.md` / `stage2.md` / `stage3.md` | Records of stage 1 (cross-compile), stage 2 (interactive TUI), and stage 3 (browser grid UI). |

## Changes to shared build files (all `EMSCRIPTEN`-guarded)

- `cmake.deps/cmake/BuildLua.cmake` — use the CMake-configured `emar`/`emranlib`.
- `cmake.deps/cmake/BuildLuv.cmake` — hand luv the libuv/Lua paths (Emscripten's
  find-root restriction hides `.deps-wasm/usr` from `find_package`).
- `cmake.deps/cmake/BuildLibuv.cmake` + `cmake/PatchLibuvEmscripten.cmake` —
  teach libuv's build to use the portable `poll(2)` backend on Emscripten
  (`posix-poll.c` etc.) and include `uv/posix.h`. libuv has no Emscripten branch
  upstream, so it otherwise builds with no I/O backend.
- `src/nvim/CMakeLists.txt` — one `if(EMSCRIPTEN)` block: link `uv_stubs.c`,
  the JSPI / `FORCE_FILESYSTEM` + `nodefs.js` / `SUPPORT_LONGJMP=wasm` link flags,
  `ENVIRONMENT=node,web,worker`, `--preload-file` of the runtime into MEMFS,
  `--pre-js`, `--js-library`.
- `src/nvim/channel.c` / `channel.h` — `channel_from_fds()` (RPC over two explicit
  fds, for the TUI client); skip the embedded dup-dance on Emscripten.
- `src/nvim/ui_client.c` — Emscripten `ui_client_start_server()` path that spawns
  the engine worker instead of a child process (stage 2).
- `src/nvim/log.h` — `-DNVIM_WASM_TRACE` (wasm) lowers the min log level (debug aid).

## Architecture: separate processes + shared memory

Modern Neovim's TUI is a **separate process** from the editor server: the TUI
spawns `nvim --embed` and talks msgpack-RPC to it (TUI input →
`rpc_send_event(ui_client_channel_id, "nvim_input")`). Process spawning is
impossible in single-threaded wasm, so we keep the split but change the
*transport* to shared memory — which is also what the browser requires:

```
   main thread (UI client)            worker_thread (engine)
   ┌─────────────────────┐           ┌──────────────────────┐
   │ terminal in/out      │  msgpack  │ nvim --embed (wasm)  │
   │ TUI render + input ──┼──RPC──────┼─> editor             │
   └─────────┬───────────┘  over SAB  └──────────┬───────────┘
             └───────────  SharedArrayBuffer  ────┘
                       (two ring buffers, Atomics)
```

- The **engine** blocks waiting for input by suspending in `poll()`:
  off the main thread it uses `Atomics.wait`; on the main thread (the UI)
  blocking is forbidden, so the client suspends asynchronously via JSPI.
- The **builtin TUI** runs on the main thread (`src/nvim/tui/`), keeping fd 0/1/2
  for the real terminal and talking to the engine over the SAB. Stage 2 made this
  fully interactive (`node nvim.js -- file.txt`); see `stage2.md` for the design
  and the hard problems solved. `demo-rpc.js` still exercises the raw RPC path.

### Architecture: the browser web UI (`wasm/web/`)

The browser target keeps the same engine-over-SAB split but replaces the wasm
builtin-TUI client with a **custom UI written in plain JavaScript**. The result is
actually *simpler* than the Node TUI: the page runs **no wasm and no JSPI at all**.

```
   page main thread (wasm/web/ui.js)            Web Worker (engine-worker.js)
   ┌───────────────────────────────┐   SAB     ┌──────────────────────────┐
   │ keydown → nvim_input  ─────────┼──ring────▶│ nvim --embed (wasm)      │
   │ redraw  → char grid → <pre> ◀──┼──ring─────┤ editor + ext_linegrid    │
   └───────────────────────────────┘           └──────────────────────────┘
       pure JS, no wasm, no JSPI                 blocks in poll() via Atomics.wait
```

- **Engine in a Web Worker** (`engine-worker.js`) — the browser analogue of
  `worker.js`. It `importScripts('sab.js','nvim.js')`, backs fd 0/1 with the SAB
  ring, and sets `__nvimCanBlockSync=true` so the engine blocks in `poll()` via
  `Atomics.wait` (allowed off the main thread). The same `nvim.wasm` serves both
  Node and browser (`-sENVIRONMENT=node,web,worker`).
- **Pure-JS UI on the page** (`ui.js`) — a msgpack-RPC client (`@msgpack/msgpack`)
  that:
  1. `nvim_ui_attach`es with `{ ext_linegrid: true }`;
  2. decodes `redraw` notifications (`grid_resize`, `grid_line`, `grid_scroll`,
     `grid_cursor_goto`, `flush`) into a 2-D character grid;
  3. renders that grid into a `<pre>` — **no fg/bg colour**, just a cursor outline.
     The command line and messages are drawn by Neovim into the bottom grid rows
     (we don't request `ext_cmdline`/`ext_messages`), so `:`, `:w`, etc. show up;
  4. maps DOM `keydown` → `nvim_input`.

  Because no wasm runs on the page, there is nothing to suspend, so **no JSPI is
  needed main-thread**: the reverse ring is read with `Atomics.waitAsync`. Only
  the Worker instantiates a JSPI module (its poll import is suspending even though
  it never actually suspends), so the *browser* must support JSPI (Chrome ≥ 137).
- **Filesystem** — no host FS, so `$VIMRUNTIME` is preloaded into MEMFS at build
  time (see below). `-u NONE -i NONE` by default (no config, no shada).
- **Cross-origin isolation** — `SharedArrayBuffer` requires the page to be
  cross-origin isolated (COOP `same-origin` + COEP `require-corp`). The dev server
  `serve.js` sends those headers; for header-less hosts the vendored
  `coi-serviceworker.js` injects them via a service worker (see *Deploy*).
- **Testing hook** — `window.nvim.input(keys)`, `.gridText()`, `.resize(c,r)` and
  `.state()` are exposed for driving/asserting from automation or the console.

`stage3.md` records the design, what shipped, and the remaining browser follow-ups
(trim the ~22 MB preloaded runtime, live resize, IDBFS for real files).

### Filesystem: MEMFS + NODEFS (not NODERAWFS)

The wasm build uses MEMFS with a NODEFS mount of the host filesystem (set up in
`pre.js`), **not** NODERAWFS. NODERAWFS routes fd I/O straight to Node fds, which
makes purely-virtual fds (the in-worker SAB channel, the client's RPC fds)
impossible. With MEMFS the channel fds are first-class virtual streams backed by
the `SharedArrayBuffer` ring (`nvim_io.js`), while real files stay reachable
through the NODEFS mount. In the **browser** there is no host FS, so `$VIMRUNTIME`
is bundled into MEMFS at build time (`--preload-file runtime@/usr/share/nvim/runtime`,
shipped as `nvim.data`) and `pre.js` skips the NODEFS mounts — same channel ops.

## Known limitations

- No process spawning: `:terminal`, `:!`, and `jobstart()` are unavailable;
  the relevant libuv/`uv_spawn` calls fail with `ENOSYS`.
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
