# Neovim on WebAssembly (Emscripten + Node)

This directory contains everything needed to cross-compile Neovim to WebAssembly
with Emscripten and run it under Node.js (with JSPI — JavaScript Promise
Integration — and a `SharedArrayBuffer`-based UI transport).

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
| Real filesystem access (NODERAWFS) | ✅ |
| `nvim --embed` msgpack-RPC server | ✅ |
| Engine in a worker + client over `SharedArrayBuffer` | ✅ (see `demo-rpc.js`) |
| **Interactive built-in TUI** (`node nvim.js -- file.txt`) | ✅ (stage 2 — see `stage2.md`) |
| Browser (Web Worker + xterm.js / canvas) | 🚧 next (see `stage3.md`) |
| `:terminal`, `:!cmd`, jobs (process spawning) | ❌ stubbed (no spawn in wasm) |

## Prerequisites

- Emscripten (`emcc`) ≥ 3.1.6x (has `-sJSPI`).
- Node ≥ 22 (JSPI / `WebAssembly.Suspending` available by default; v26 tested).
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
# Interactive editor (builtin TUI on the main thread, engine in a worker):
node build-wasm/bin/nvim.js -- file.txt
# (on a read-only HOME, add `-i NONE` to disable shada — see stage2.md)

node build-wasm/bin/nvim.js -- --version
node build-wasm/bin/nvim.js -- -u NONE --headless -l script.lua
( cd build-wasm/bin && node demo-rpc.js )   # shared-memory RPC round-trip
```

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
| `pre.js` | Emscripten `--pre-js`: argv (`node nvim.js -- args`), `$VIMRUNTIME`, env, and the NODEFS mounts of the host FS. |
| `nvim_io.js` | Emscripten `--js-library`: async (JSPI) `__syscall_poll`, SAB-backed channel fds for both roles, host-terminal stdio + winsize + raw mode, and the engine-spawn glue. |
| `sab.js` | `SharedArrayBuffer` ring-buffer byte transport (browser-compatible). |
| `worker.js` | Engine endpoint: hosts `nvim --embed` wasm directly in a worker, fd 0/1 backed by the SAB. |
| `demo-rpc.js` | End-to-end proof of shared-memory RPC (client ↔ worker). |
| `stage1.md` / `stage2.md` / `stage3.md` | Records of stage 1 (cross-compile), stage 2 (interactive TUI), and the forward plan (browser). |

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

### Filesystem: MEMFS + NODEFS (not NODERAWFS)

The wasm build uses MEMFS with a NODEFS mount of the host filesystem (set up in
`pre.js`), **not** NODERAWFS. NODERAWFS routes fd I/O straight to Node fds, which
makes purely-virtual fds (the in-worker SAB channel, the client's RPC fds)
impossible. With MEMFS the channel fds are first-class virtual streams backed by
the `SharedArrayBuffer` ring (`nvim_io.js`), while real files stay reachable
through the NODEFS mount. The browser stage swaps NODEFS for a fetched/IDBFS
virtual FS — same channel ops.

## Known limitations

- No process spawning: `:terminal`, `:!`, and `jobstart()` are unavailable;
  the relevant libuv/`uv_spawn` calls fail with `ENOSYS`.
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
