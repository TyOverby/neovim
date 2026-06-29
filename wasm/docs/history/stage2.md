# Stage 2 — Interactive built-in TUI over the SAB channel  ✅ DONE (later removed)

> **Historical.** The wasm builtin-TUI client described here has since been
> **removed**. It was a stepping stone to prove the engine-in-a-worker + JSPI +
> postMessage architecture under Node before the browser UI existed; once the
> browser UI (stage 3) worked and the headless `wasm/web/e2e.test.js` covered the
> engine path, the in-wasm TUI client (its `ui_client.c` / `channel_from_fds` /
> `nvim_io.js` host-terminal glue and the `wasm/nvim` launcher) was dropped. This
> file is kept only as a record of how it worked. The transport also moved from
> the `SharedArrayBuffer` channel below to plain postMessage (see stage 3).

Goal (achieved): a real interactive editor with `node nvim.js -- file.txt` — the
builtin TUI renders to the terminal, keystrokes edit the buffer, `:w`/`:wq` save,
`:q` restores the terminal — using **nvim's own builtin TUI** (`src/nvim/tui/`)
on the main thread, talking to the engine (`nvim --embed`, in a worker_thread)
over the `SharedArrayBuffer` channel from stage 1.

```
  main thread = TUI client (nvim builtin UI)        worker = engine (nvim --embed)
  - real terminal fd 0/1/2 (raw tty in/out)         - fd 0/1 = SAB channel (virtual)
  - RPC channel on fresh fds 9/10  <--- msgpack-RPC over SharedArrayBuffer --->
  - non-blocking poll (JSPI suspend)                - blocks in poll() via Atomics.wait
```

Two **separate wasm instances** sharing only the SAB. `node nvim.js -- file` is
the client; it asks JS to spawn the engine worker.

What works, validated end-to-end (via a Python `pty` harness, `wasm/` has no test
runner): boot + initial render, truecolor output, keyboard input round-trip
(insert mode, typing, `:` commands), multi-line editing, motions (`gg`), operators
(`dd`), `:w`/`:wq` writing the file, and `:q`/`:wq` exiting with the terminal
fully restored (leaves alt-screen, shows cursor, raw mode off). The stage-1
`demo-rpc.js` still passes, now with the engine hosted **directly** in the worker.

---

## What was built (by the stage-1 plan's steps)

### Step 1 — Engine off NODERAWFS → MEMFS + NODEFS  ✅
`-sNODERAWFS=1` → `-sFORCE_FILESYSTEM=1 -lnodefs.js` (`src/nvim/CMakeLists.txt`).
`wasm/pre.js` now mounts each existing host top-level dir (`/home`, `/usr`, `/tmp`,
…) via NODEFS onto the same path, so absolute host paths ($VIMRUNTIME, cwd, file
args) resolve unchanged, and `FS.chdir(process.cwd())`. This makes fd 0/1 *virtual*
streams so they can be backed by the SAB channel. `wasm/worker.js` now hosts the
engine wasm **directly** (`require('./nvim.js')` with `globalThis.__nvim*` set) —
the stage-1 child-process + pipe bridge is gone. `channel_from_stdio()`
(`src/nvim/channel.c`) skips the embedded-mode dup/redirect dance on Emscripten and
uses fd 0/1 directly (where the channel stream ops live).

### Step 2 — `ui_client_start_server()` Emscripten path  ✅
`src/nvim/ui_client.c` has an `#ifdef __EMSCRIPTEN__` branch that calls JS glue
`nvim_wasm_start_engine()` (in `wasm/nvim_io.js`) and then `channel_from_fds()`.
`channel_from_fds(in_fd, out_fd)` (new, `src/nvim/channel.c`, declared in
`channel.h`) opens an RPC channel over two explicit fds — like
`channel_from_stdio()` but not tied to fd 0/1 and not gated on headless/embedded;
it reuses `kChannelStreamStdio` (the client has no other stdio channel). The JS
glue allocates the SAB, spawns the engine worker, installs the client side of the
channel on two fresh fds, switches the terminal to raw mode, and returns the fds.

### Step 3 — Non-blocking (JSPI) `__syscall_poll`  ✅
`__syscall_poll` is now `__async: true`. The engine (off main thread) still blocks
synchronously via `Atomics.wait`. The client (main thread) suspends via JSPI:
`NvimIO.pollWaitAsync()` returns a Promise that resolves when terminal stdin or the
channel ring becomes readable, or the libuv timeout elapses. fd 0 reads a queue fed
by `process.stdin.on('data')` (raw mode); fd 1/2 write raw bytes to
`process.stdout`/`stderr`.

### Step 4 — Terminal sizing, raw mode, lifecycle  ✅
`ioctl(TIOCGWINSZ)` reports the real `process.stdout.{rows,columns}` (we patch the
terminal streams' `tty.ops.ioctl_tiocgwinsz`). Raw mode via
`process.stdin.setRawMode(true)`, restored on exit. On engine quit, `worker.js`
closes the rings so the client sees EOF → `exit_on_closed_chan` → `os_exit` →
`tui_stop` restores the terminal. (Live resize / SIGWINCH is not wired yet — see
stage 3.)

### Step 5 — End-to-end bring-up  ✅  (see "What works" above)

---

## Hard problems and fixes (the non-obvious ones)

1. **Channel install ran too early.** Installing channel stream ops in `preRun`
   no-ops: `FS.init()` creates the standard streams (fd 0/1/2) during
   `initRuntime`, *after* preRun. Moved to `onRuntimeInitialized` (after
   `createStandardStreams`). Symptom: engine read fd 0 EOF immediately →
   `chan_close_on_err: closed by the peer` → silent exit 1.

2. **`uv_guess_handle` → UV_FILE.** We used to clear `stream.tty`; that makes
   `isatty(fd)` false, so libuv classifies the channel fd as a non-tty char device
   = `UV_FILE` and reads it as a *file* (immediate EOF). Fix: keep `stream.tty`
   set (FS routes read/write through our `stream_ops` regardless); isatty stays
   true → `UV_TTY` → the pipe path. Same trick for the client's fresh fds
   (`FS.open('/dev/null')` for a real char-device node, then swap in channel ops).

3. **`Module['arguments']` mutated.** Emscripten's `callMain()` does
   `args.unshift(thisProgram)` in place, so by the time the client glue reads it,
   the engine would get `["--embed","/usr/bin/nvim","file"]`. Fix: `pre.js` stashes
   a pristine `Module['nvimUserArgs']`.

4. **Busy-spin froze the exit timeout.** `pollWaitAsync` resolved *synchronously*
   when the channel was closed (`isClosed()` stays true forever), creating a
   microtask-only tight loop that starved Node's macrotask queue and froze the
   wall-clock — so `tui_stop`'s 1 s DA1-wait (`LOOP_PROCESS_EVENTS_UNTIL`, which
   measures elapsed time with `os_hrtime`) never timed out, and the terminal was
   never restored. Fix: never resolve synchronously; pace every wake through a 3 ms
   `setInterval` (a real macrotask). stdin still wakes instantly via `NvimIO.wake`.

5. **Client never saw the engine die.** The new in-worker engine exits via
   `process.exit()`; nothing closed the SAB rings, so the client never got EOF.
   Fix: `worker.js` closes the rings on the worker's `process.on('exit')`.

---

## Gotchas / environment notes

- **shada on a read-only state dir.** If `$XDG_STATE_HOME` / `~/.local/state` is
  read-only (as in some sandboxes), shada writes fail `EROFS` (or, headless, can
  hang); this clutters exit and can delay the timed teardown. Not a wasm bug — run
  with `-i NONE` to disable shada. In a normal writable HOME it just works.
- **No real DA1 response.** `tui_stop` sends a DA1 query and waits ≤1 s for the
  terminal's reply before restoring. A real terminal answers instantly; a bare pty
  (or the browser) won't, so exit takes ~1 s. Acceptable.
- **Engine logs.** `worker.js` redirects the engine's `$NVIM_LOG_FILE` to
  `<path>.engine` (worker_threads inherit env, else both instances interleave).
  Set `NVIM_WASM_ENGINE_LOG` to capture the engine's stray stdout/stderr; set
  `NVIM_WASM_IO_LOG` for the JS I/O layer's trace; build with
  `-DNVIM_WASM_TRACE` (wasm only) to lower nvim's log level to DEBUG.
- **One build, two roles.** The same `nvim.js` is both client and engine; the role
  is chosen at boot (engine if `globalThis.__nvimServerChannel` is set, else the
  builtin-UI client wires itself up in `nvim_wasm_start_engine`).

---

## Files changed in stage 2

| File | Change |
|---|---|
| `src/nvim/CMakeLists.txt` | `-sNODERAWFS=1` → `-sFORCE_FILESYSTEM=1 -lnodefs.js`. |
| `src/nvim/channel.c` | New `channel_from_fds()`; skip the embedded dup-dance on Emscripten. |
| `src/nvim/channel.h` | Declare `channel_from_fds()` (wasm). |
| `src/nvim/ui_client.c` | Emscripten `ui_client_start_server()` path (no spawn). |
| `src/nvim/log.h` | `-DNVIM_WASM_TRACE` (wasm) lowers the min log level (debug aid). |
| `wasm/pre.js` | NODEFS mounts + cwd; pristine `nvimUserArgs`; pass `NVIM_LOG_FILE`. |
| `wasm/nvim_io.js` | Channel ops refactor, client fds, host-terminal stdio, winsize, raw mode, engine-spawn glue, async JSPI poll. |
| `wasm/worker.js` | Host the engine wasm directly; close rings on exit; split engine log. |

See `stage3.md` for the browser stage and remaining polish.
