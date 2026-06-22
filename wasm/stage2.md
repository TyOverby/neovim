# Stage 2 — Interactive built-in TUI over the SAB channel

Goal: a real interactive editor with `node nvim.js` (no `--embed`) — keystrokes
in the terminal, rendered screen out — using **nvim's own built-in TUI**
(`src/nvim/tui/`) on the main thread, talking to the engine (in a worker) over
the `SharedArrayBuffer` channel built in stage 1.

Decision (chosen): reuse the built-in TUI rather than write a JS grid renderer.
It reuses nvim's battle-tested terminal handling (terminfo, key parsing,
true-color, grid diffing) and keeps the C protocol unchanged.

Prereq reading: `stage1.md` §5 (architecture) and §8 (gotchas).

---

## Target topology

```
  main thread = TUI client (nvim, built-in UI)      worker = engine (nvim --embed)
  - real terminal fd0/fd1 (raw tty in/out)          - stdin/stdout = SAB channel
  - ui_client_channel_id = SAB channel  <--- msgpack RPC over SharedArrayBuffer --->
  - non-blocking (JSPI) poll                         - blocks in poll() via Atomics.wait
```

Two **separate wasm instances**: the client runs the TUI; the engine runs the
editor. They share only the SAB. `node nvim.js` (main) is the client; it asks JS
to spawn the engine worker.

---

## Work items (in order)

### Step 1 — Switch the ENGINE build off NODERAWFS → MEMFS + NODEFS

Why: NODERAWFS routes fd I/O straight to Node fds, so the in-worker SAB channel
(which must be a *virtual* fd 0/1) doesn't work — the worker has no stdin stream,
and `--embed`'s `channel_from_stdio` dups fd0/1 and `uv_guess_handle` does a
path-based `fstat`. With default FS (MEMFS) we can install **custom stream ops**
on fd 0/1 (already written in `nvim_io.js` `installChannelStream`), while real
file access comes from a `NODEFS` mount.

- Replace `-sNODERAWFS=1` with `-sFORCE_FILESYSTEM=1` for the engine; in
  `pre.js`/a preRun, `FS.mkdir('/host'); FS.mount(NODEFS, { root: '/' }, '/host')`
  (or mount `/` if the platform allows), then `FS.chdir(process.cwd under /host)`
  and point `$VIMRUNTIME` at the mounted runtime path.
- Keep NODERAWFS for the *client* if convenient (its fd0/1 are the real tty), or
  unify both on MEMFS+NODEFS. Cleanest: one build, MEMFS+NODEFS, used by both
  roles. Decide based on how the client's tty fds behave under MEMFS (may need a
  TTY device for fd0/1 — Emscripten provides `TTY` ops).
- Re-verify stage-1 paths (`--headless`, `-l`, `--embed` over pipes) after the
  FS switch — file reads/writes and `$VIMRUNTIME` lookup must still work.

Acceptance: `demo-rpc.js` still PASSes, but now with the engine's fd0/1 backed by
the SAB **directly in the worker** (no child process / pipe bridge). At that
point `worker.js` drops `child_process` and instead `require('./nvim.js')` with
`globalThis.__nvimServerChannel` set (the hooks already exist in `pre.js` +
`nvim_io.js`); the engine blocks in `poll()` via `Atomics.wait` (works).

### Step 2 — `ui_client_start_server()` Emscripten path (no spawn)

In `src/nvim/ui_client.c`, add an `#ifdef __EMSCRIPTEN__` branch that, instead of
`channel_job_start()`:

1. Calls a JS glue function (add to `nvim_io.js`, e.g. `nvim_wasm_start_engine`)
   that: allocates the SAB, spawns the engine worker with it + the same argv, and
   returns the client-side fd numbers for the channel (read fd / write fd backed
   by SAB stream ops installed via `installChannelStream`).
2. Creates an nvim RPC channel over those fds. Add a small
   `channel_from_fds(in_fd, out_fd)` helper next to `channel_from_stdio()` in
   `channel.c` (same `kChannelStreamStdio` + `rstream_init_fd`/`wstream_init_fd`
   + `rpc_start`, minus the embedded-mode dup dance).
3. Returns that channel id as `ui_client_channel_id`.

Keep `EM_JS`/library-call plumbing minimal; the heavy lifting (SAB, worker
lifecycle) stays in JS.

### Step 3 — Non-blocking (JSPI) `__syscall_poll` for the main thread

The client must not `Atomics.wait`. Make `__syscall_poll` `__async: true` (JSPI)
and, when nothing is ready and `timeout != 0`, `await` a race of:

- terminal stdin readability — a Promise resolved by a `process.stdin.on('data')`
  handler that buffers bytes (raw mode) into a JS queue;
- SAB channel readability — **poll the ring** (NOT `Atomics.waitAsync`, which is
  broken here — see stage1 §8), e.g. a short `setTimeout` retry loop, or a
  microtask that checks `channel.in.available()`;
- the libuv `timeout` via `setTimeout`.

Then recompute readiness and return. Engine (worker) keeps the synchronous
`Atomics.wait` path (`NvimIO.canBlockSync`). Branch on
`!Module.nvimCanBlockSync` for the async path.

Wire the client's stdin: `installChannelStream`-style ops for fd 0 (read side =
the JS stdin queue) and fd 1/2 (write side = `process.stdout/err.write`). Raw
mode via `process.stdin.setRawMode(true)` (NvimIO.enableRawMode already exists);
restore on exit.

### Step 4 — Terminal sizing, signals, lifecycle

- Window size: nvim queries `uv_tty_get_winsize`. Provide it from
  `process.stdout.{columns,rows}`; feed resize via a `process.stdout.on('resize')`
  handler → `nvim_ui_try_resize` (the client already does this in
  `ui_client.c`). May need a tty `ioctl(TIOCGWINSZ)` shim in `nvim_io.js`.
- `os_isatty`/`uv_guess_handle` for fd0/1 must report TTY so the builtin UI is
  used. Under MEMFS, register fd0/1 as TTY devices (Emscripten `TTY`), or shim
  `uv_guess_handle`.
- SIGINT/SIGWINCH: map to Node `process.on('SIGINT'/'SIGWINCH')` if needed (most
  signal handling already degrades gracefully).
- Clean teardown: restore raw mode + alternate screen on exit (the TUI emits the
  sequences; ensure `EXIT_RUNTIME`/atexit runs them and `restoreTerminal` fires).

### Step 5 — End-to-end bring-up

- `node build-wasm/bin/nvim.js -- file.txt` should show the editor. Expect to
  iterate on: initial `nvim_ui_attach` options, redraw decoding, key encoding,
  and timing (engine init vs first attach).
- Add a non-interactive smoke test: drive the client's stdin with a scripted byte
  sequence (`iHELLO<Esc>:wq<CR>`) and assert the file contents — gives a
  regression test without a real TTY.

---

## Risks / open questions

- **MEMFS+NODEFS performance & path mapping** — large repos, symlinks, cwd. Mount
  point vs `/` and how `$VIMRUNTIME`/cwd resolve. Biggest unknown; do Step 1 first
  and re-validate everything.
- **TTY under MEMFS for the client** — getting `isatty`, winsize, and raw mode
  right may need an Emscripten TTY device or targeted shims in `nvim_io.js`.
- **JSPI async poll correctness** — racing stdin/SAB/timeout without busy-spin or
  missed wakeups; ensure the engine's redraw latency is acceptable.
- **Two wasm instances, memory** — each instance is ~5 MB wasm + heap; fine for
  Node, watch for the browser.

## Browser stage (after Node interactive works)

- `worker_thread` → `Worker`; `child_process` already gone after Step 1.
- Main page hosts the UI: either keep the built-in TUI driving an xterm.js
  terminal, or swap the client for a DOM/canvas grid renderer fed by the same RPC.
- Requires COOP/COEP headers for `SharedArrayBuffer`.
- `$VIMRUNTIME` + user files come from a virtual FS (IDBFS / fetched bundle)
  instead of NODEFS.

## Quick reference — validated building blocks (don't re-derive)

- wasm nvim runs as `--embed` RPC server (stage 1).
- `wasm/sab.js` SPSC ring transport works across worker_threads.
- Synchronous `Atomics.wait` wakes off-main-thread; `Atomics.waitAsync` does not.
- `installChannelStream` + the `__syscall_poll` blocking branch already implement
  the server-role SAB fds; reuse for the client role with the async variant.
- `pre.js` already reads `globalThis.__nvimServerChannel` / `__nvimArgs`.
