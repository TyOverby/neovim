# Stage 1 — Neovim → WebAssembly (Emscripten + Node): foundation

This document records everything done in stage 1: getting Neovim to cross-compile
to WebAssembly with Emscripten and run under Node.js, up to a working
`nvim --embed` RPC server reachable from a separate process over a
`SharedArrayBuffer`. Stage 2 (the interactive built-in TUI) is described in
`stage2.md`.

All changes are **additive and `EMSCRIPTEN`-guarded** — the native build is
unaffected (verified: `./build/bin/nvim --version` still runs).

---

## 1. Result / what works

Build:

```sh
wasm/build-deps.sh    # deps  -> .deps-wasm/usr/{lib,include}
wasm/build-nvim.sh    # nvim  -> build-wasm/bin/nvim.js (+ nvim.wasm)
```

Run (`node build-wasm/bin/nvim.js -- <nvim args>`):

| Capability | State | Test |
|---|---|---|
| `--version` | ✅ | `node nvim.js -- --version` |
| `--headless` init/quit | ✅ | `node nvim.js -- --headless -u NONE +qa` |
| `-l script.lua` | ✅ | `node nvim.js -- -u NONE -l /tmp/t.lua` |
| Full `vim.api`, Lua, bundled runtime (`$VIMRUNTIME`) | ✅ | set/get current line, buffers, `vim.version()`, `vim.inspect` |
| Real filesystem (NODERAWFS) | ✅ | reads runtime files, edits real files |
| `nvim --embed` msgpack-RPC server (over pipes) | ✅ | round-trip `nvim_eval("1+1")` → `2` |
| Engine in worker_thread ↔ client over `SharedArrayBuffer` | ✅ | `cd build-wasm/bin && node demo-rpc.js` → `PASS` |

Not in stage 1 (see stage2.md / README): interactive TUI; process spawning
(`:terminal`, `:!`, jobs) is stubbed (`ENOSYS`).

---

## 2. Environment (already present, nothing to install)

- `emcc` 3.1.69 (has `-sJSPI`), `emar`/`emranlib` = llvm-ar 19.
- Node v26 — `WebAssembly.Suspending`/`promising` available by default (JSPI), no
  flags. `Atomics.wait` wakes across worker_threads; **`Atomics.waitAsync` does
  NOT resolve on notify in this build** (worked around — see §8).
- Host **PUC Lua 5.1** (`/usr/bin/lua5.1`) + dev headers, and bundled LuaJIT at
  `.deps/usr/bin/luajit`.
- A complete native `build/` (provides generated headers + host `nlua0`).
- All dependency tarballs cached in `.deps/build/downloads/` (PUC Lua 5.1.5 was
  fetched once and staged there).

---

## 3. Cross-compilation strategy

Neovim generates a lot of C from Lua at build time. Those generators are
**host-architecture-independent** (they *parse* C/Lua source via `c_grammar.lua`,
not preprocessor output), but they need a host Lua interpreter plus the `nlua0`
Lua C-module (for `mpack`/`lpeg`). Upstream already supports pointing at a
prebuilt host `nlua0` via `NLUA0_HOST_PRG` when `CMAKE_CROSSCOMPILING` is set
(the Emscripten toolchain sets it automatically).

So stage 1 uses a **two-stage build**:

1. The native `build/` produces `build/lib/libnlua0.so` (`cmake --build build
   --target nlua0`) and we drive codegen with the host LuaJIT.
2. The wasm build (`build-wasm/`) cross-compiles the C, reusing those generators.

Key option choices for wasm (`wasm/build-nvim.sh`):

- `PREFER_LUA=ON` — link **PUC Lua 5.1**, not LuaJIT (LuaJIT cannot target wasm).
- `COMPILE_LUA=OFF` — embed Lua **source**, not bytecode (Lua 5.1 bytecode is
  word-size/endian dependent; host 64-bit bytecode would not load in wasm32).
- `CMAKE_FIND_ROOT_PATH_MODE_{LIBRARY,INCLUDE,PACKAGE}=BOTH` — the Emscripten
  toolchain confines `find_package` to its sysroot; this lets it see
  `.deps-wasm/usr`. (The toolchain only sets these `if(NOT ...)`, so a
  command-line value wins.)
- `DEPS_PREFIX=.deps-wasm/usr`, `LUA_LIBRARY`/`LUA_INCLUDE_DIR`/`LUA_MATH_LIBRARY`
  pointed explicitly at the bundled Lua (CMake's `FindLua` searches for a libm
  that doesn't exist as a separate file under Emscripten — math is in libc).
- `NLUA0_HOST_PRG=build/lib/libnlua0.so`, `LUA_GEN_PRG=LUA_PRG=.deps/usr/bin/luajit`.

---

## 4. The hard problems and how they were solved

### 4.1 libuv has no wasm I/O backend (the linchpin)

libuv's CMake has no branch for `CMAKE_SYSTEM_NAME == "Emscripten"`, so it built
with **no platform I/O backend** — `uv__io_poll`, `uv__platform_loop_init`,
`uv__hrtime`, etc. were undefined at link. Fix
(`cmake.deps/cmake/PatchLibuvEmscripten.cmake`, applied via
`BuildLibuv.cmake`'s `PATCH_COMMAND`, idempotent):

- Add an Emscripten branch that compiles libuv's portable `poll(2)` backend:
  `src/unix/{posix-poll,posix-hrtime,no-fsevents,no-proctitle}.c`.
- Make `include/uv/unix.h` include `uv/posix.h` on `__EMSCRIPTEN__` (it provides
  the loop's `poll_fds` fields that `posix-poll.c` needs).

Empirically validated first that libuv otherwise compiles under emcc (it does —
only `pthread_setname_np`/`getname_np` tripped it, see §4.4).

### 4.2 JSPI + setjmp/longjmp → "trying to suspend JS frames"

With `-sJSPI`, the editor crashed the moment the event loop tried to suspend.
Root cause: Emscripten's default setjmp/longjmp (used heavily by Lua's error
handling and nvim) is implemented with JS `invoke_*` trampolines; those JS stack
frames sit between the JSPI-promising `main` and the suspend point, and JSPI
cannot suspend across JS frames. Fix: **`-sSUPPORT_LONGJMP=wasm`** (wasm-native
setjmp/longjmp, no JS trampolines), applied uniformly to **deps and nvim**, at
compile and link (Lua's `.a` must match nvim's model).

### 4.3 `__syscall_poll` crash under NODERAWFS

Emscripten's stock `poll()` dereferences `stream.stream_ops.poll`, which is
undefined for NODERAWFS streams (pipes / the RPC channel) → `TypeError`. We
replace `__syscall_poll` in `wasm/nvim_io.js` with one that never crashes,
reports readiness, and (for the SAB server role) blocks via `Atomics.wait`.

### 4.4 libuv/libc symbol gaps

- `pthread_setname_np`/`pthread_getname_np`: declared under `_GNU_SOURCE` but
  unimplemented in Emscripten libc. `wasm/shim.h` provides `static inline` stubs
  for TUs compiled *without* `_GNU_SOURCE` (libuv's deps build), and
  `wasm/uv_stubs.c` provides the real symbols for the `_GNU_SOURCE` side.
- `sched_get_priority_{min,max}`, `pthread_setschedparam`: declared, unimplemented
  → stubbed in `wasm/uv_stubs.c`.
- libuv sys-info functions omitted by the Emscripten build (`uv_uptime`,
  `uv_cpu_info`, `uv_get_*_memory`, `uv_resident_set_memory`, `uv_loadavg`,
  `uv_interface_addresses`, `uv_exepath`): conservative stubs in
  `wasm/uv_stubs.c`. (`uv_{set,get}_process_title` and `uv_fs_event_*` come from
  libuv's own `no-proctitle.c`/`no-fsevents.c` via the patch.)

### 4.5 PUC Lua Makefile under Emscripten

`BuildLua.cmake` sed-patches the Lua Makefile to use the CMake-configured
archiver (`emar`/`emranlib`) — GNU `ar` cannot build a valid symbol index for
wasm objects.

### 4.6 luv can't find libuv/Lua under the find-root restriction

`BuildLuv.cmake` hands luv `LIBUV_INCLUDE_DIR`/`LIBUV_LIBRARIES` and
`LUA_INCLUDE_DIR`/`LUA_LIBRARIES` explicitly on Emscripten (its
`find_package(Libuv)`/`find_package(Lua)` can't see `.deps-wasm/usr`).

### 4.7 Passing argv / env to the module

Emscripten's `var Module` shadows any `globalThis.Module` a `require()`-ing host
sets, and `ENV` starts as fixed `web_user` stubs (no `process.env` inheritance).
Fix: `wasm/pre.js` (`--pre-js`) runs *inside* the module with real `process`
access — it parses the `node nvim.js -- <args>` convention, sets `$VIMRUNTIME`
(in-tree `runtime/`), and copies through `HOME`/`TERM`/`XDG_*`/etc. It also reads
optional `globalThis.__nvimArgs` / `__nvimServerChannel` overrides used by the
worker host.

---

## 5. The separate-process + shared-memory architecture

Modern Neovim's TUI is a **separate process** from the editor: the TUI spawns
`nvim --embed` and talks msgpack-RPC to it (TUI input →
`rpc_send_event(ui_client_channel_id, "nvim_input")`; engine → TUI redraw).
`uv_spawn` cannot work in single-threaded wasm, so we keep the split and change
the **transport** to shared memory — which is also exactly what the browser
target needs (page ↔ Worker, no pipes).

```
   main thread (UI client)            worker_thread (engine)
   ┌─────────────────────┐           ┌──────────────────────┐
   │ terminal in/out      │  msgpack  │ nvim --embed (wasm)  │
   │ TUI render + input ──┼──RPC──────┼─> editor             │
   └─────────┬───────────┘  over SAB  └──────────┬───────────┘
             └───────────  SharedArrayBuffer  ────┘
                       (two SPSC ring buffers + Atomics)
```

`wasm/demo-rpc.js` proves the path today with a minimal JS client: it spawns the
engine in a worker, sends `nvim_eval("1+1")` over the SAB, and reads back
`94 01 00 c0 02` (`[response, msgid 0, nil err, 2]`).

**Node stage vs browser stage.** `wasm/worker.js` currently launches the engine
as a child `node nvim.js --embed` process and bridges its pipes to the SAB
(reusing the working pipe RPC path). The browser stage will host the engine wasm
*directly* in the worker and back its stdin/stdout fds with the SAB (the
`installChannelStream` hooks in `nvim_io.js`), removing the child + bridge — the
main-thread ⇄ SAB contract is identical either way. See stage2.md §"FS rework".

---

## 6. Files added (`wasm/`)

| File | Purpose |
|---|---|
| `build-deps.sh` | Cross-compile bundled deps → `.deps-wasm/usr`. |
| `build-nvim.sh` | Configure + build nvim → `build-wasm/bin/nvim.js`; install JS helpers. |
| `shim.h` | Force-included into every emcc compile (`EMCC_CFLAGS`); pthread thread-name stubs for non-`_GNU_SOURCE` TUs. |
| `uv_stubs.c` | libuv/libc symbols the Emscripten builds omit. Linked into nvim only on wasm. |
| `pre.js` | `--pre-js`: argv convention, `$VIMRUNTIME`, env, worker channel/argv overrides. |
| `nvim_io.js` | `--js-library`: `__syscall_poll` replacement; SAB-backed stdin/stdout stream ops for the server role. |
| `sab.js` | `SharedArrayBuffer` SPSC ring-buffer byte transport (browser-compatible). |
| `worker.js` | Engine endpoint: `nvim --embed` exposed over the SAB. |
| `demo-rpc.js` | End-to-end shared-memory RPC proof. |
| `README.md` | User-facing overview + build/run + architecture. |
| `stage1.md` / `stage2.md` | This record + the forward plan. |

## 7. Files changed (tracked, all `EMSCRIPTEN`-guarded)

- `cmake.deps/cmake/BuildLua.cmake` — `emar`/`emranlib` via `CMAKE_AR`/`CMAKE_RANLIB`.
- `cmake.deps/cmake/BuildLuv.cmake` — explicit libuv/Lua paths on Emscripten.
- `cmake.deps/cmake/BuildLibuv.cmake` (+ new `cmake.deps/cmake/PatchLibuvEmscripten.cmake`) — `poll()` backend.
- `src/nvim/CMakeLists.txt` — one `if(EMSCRIPTEN)` block: `uv_stubs.c`, link flags (`-sJSPI -sSUPPORT_LONGJMP=wasm -sNODERAWFS -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=8MB -sEXIT_RUNTIME -sENVIRONMENT=node`), `--pre-js`, `--js-library`.

## 8. Gotchas worth remembering

- `Atomics.waitAsync` does **not** wake on `notify` in this Node build; the
  worker bridge polls the ring instead. The *engine* blocks fine with
  synchronous `Atomics.wait` (off the main thread).
- The **main/UI thread must never `Atomics.wait`** — in Node it also stalls the
  worker's console forwarding; in the browser it's outright forbidden. The client
  stays event-driven.
- `process.exit()` truncates async piped stdout writes — demo logs go to stderr.
- `EMCC_CFLAGS` changes are not tracked by ninja; the build scripts do clean
  rebuilds when the force-included flags change.
- NODERAWFS routes fd I/O straight to Node fds, which fights *virtual* fds
  (worker has no stdin stream; `uv_guess_handle` does path-based `fstat`). This is
  why stage 2 switches the engine to MEMFS + NODEFS (see stage2.md).
