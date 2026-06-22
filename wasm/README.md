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
| `nvim --embed` msgpack-RPC server (over pipes) | ✅ |
| Engine in a worker + client over `SharedArrayBuffer` | ✅ (see `demo-rpc.js`) |
| Interactive built-in TUI | 🚧 in progress (see *Architecture*) |
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
| `pre.js` | Emscripten `--pre-js`: argv (`node nvim.js -- args`), `$VIMRUNTIME`, env (Emscripten doesn't inherit `process.env`). |
| `nvim_io.js` | Emscripten `--js-library`: a `__syscall_poll` that doesn't crash under NODERAWFS, and SAB-backed stdin/stdout for the server role. |
| `sab.js` | `SharedArrayBuffer` ring-buffer byte transport (browser-compatible). |
| `worker.js` | Server endpoint: runs `nvim --embed`, exposed to the main thread over the SAB. |
| `demo-rpc.js` | End-to-end proof of shared-memory RPC (client ↔ worker). |

## Changes to shared build files (all `EMSCRIPTEN`-guarded)

- `cmake.deps/cmake/BuildLua.cmake` — use the CMake-configured `emar`/`emranlib`.
- `cmake.deps/cmake/BuildLuv.cmake` — hand luv the libuv/Lua paths (Emscripten's
  find-root restriction hides `.deps-wasm/usr` from `find_package`).
- `cmake.deps/cmake/BuildLibuv.cmake` + `cmake/PatchLibuvEmscripten.cmake` —
  teach libuv's build to use the portable `poll(2)` backend on Emscripten
  (`posix-poll.c` etc.) and include `uv/posix.h`. libuv has no Emscripten branch
  upstream, so it otherwise builds with no I/O backend.
- `src/nvim/CMakeLists.txt` — one `if(EMSCRIPTEN)` block: link `uv_stubs.c`,
  the JSPI / NODERAWFS / `SUPPORT_LONGJMP=wasm` link flags, `--pre-js`,
  `--js-library`.

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
  off the main thread it uses `Atomics.wait` (proven working); on the main
  thread (the UI) blocking is forbidden, so the client stays event-driven.
- `demo-rpc.js` demonstrates the full path with a minimal JS client. The
  remaining work for an interactive editor is the **client side**: run the real
  built-in TUI (or a JS renderer) on the main thread, attach over the SAB
  channel, and wire terminal stdin/stdout.

### Node stage vs browser stage

`worker.js` currently launches the engine as a child `node nvim.js --embed`
process and bridges its pipes to the SAB (reusing the already-working pipe RPC
path). The browser stage will instead host the engine wasm *directly* in the
worker and back its stdin/stdout fds with the SAB (the `installChannelStream`
hooks in `nvim_io.js`), so the child process and the bridge go away — the
main-thread ⇄ SAB contract is identical either way.

> NODERAWFS note: NODERAWFS makes file access trivial but routes fd I/O straight
> to Node fds, which makes purely-virtual fds (the in-worker SAB channel)
> awkward. The clean browser-stage path is to switch the engine build to
> MEMFS + a `NODEFS`/in-memory mount so the channel fds are first-class virtual
> streams. The `nvim_io.js` channel ops are written for that model already.

## Known limitations

- No process spawning: `:terminal`, `:!`, and `jobstart()` are unavailable;
  the relevant libuv/`uv_spawn` calls fail with `ENOSYS`.
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
