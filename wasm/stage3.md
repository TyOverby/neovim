# Stage 3 — Browser, and remaining polish

Stage 2 produced a working interactive editor under **Node** (builtin TUI on the
main thread, engine in a worker_thread, over a `SharedArrayBuffer`). Stage 3 takes
it to the **browser** and cleans up the rough edges. Prereq reading: `stage2.md`.

## Remaining polish (Node, do first — cheap and independently testable)

1. **Live resize / SIGWINCH.** Today the initial terminal size is read via
   `ioctl(TIOCGWINSZ)`; we don't react to resizes. Add a
   `process.stdout.on('resize')` handler (client) that updates `NvimIO.winsize()`'s
   source and feeds the new size in — either deliver a `SIGWINCH` to the wasm
   (Emscripten signal plumbing) or call `nvim_ui_try_resize` over the channel. The
   client's `ui_client_set_size()` already exists; the missing piece is the wakeup.

2. **Cleaner exit timing.** Exit waits ~1 s for a DA1 response that a non-terminal
   peer never sends (`stage2.md` gotchas). Consider short-circuiting the DA1 wait
   on Emscripten, or detecting "no real terminal" and skipping it.

3. **shada / state dir.** Decide a default for environments without a writable
   state dir: ship `-i NONE` by default for wasm, or point `$XDG_STATE_HOME` at a
   writable mount. Currently the user must pass `-i NONE` on a read-only HOME.

4. **Engine stderr.** It's dropped unless `NVIM_WASM_ENGINE_LOG` is set. Consider a
   ring/console bridge so engine panics are visible without env wiring.

5. **Replace the 3 ms client poll with `Atomics.waitAsync` for the ring.**
   `waitAsync` works correctly (verified on Node 20 and 26 — an earlier note that
   it was "unreliable" was a misattribution; the real stage-1 bug was the engine
   not booting, so nothing ever called `notify`). The client poll uses a 3 ms
   interval only because one wait must cover ring + stdin + timeout + close
   together. Switching the ring part to `waitAsync` cuts idle wakeups and redraw
   latency, but the **closed-ring case still needs macrotask pacing** (resolving
   on `isClosed()` via an immediate microtask reintroduces the `os_hrtime` freeze
   from stage 2). So: `Promise.race(waitAsync, stdinPromise, setTimeout)`, with a
   `setTimeout`-paced path once the ring is closed.

## Browser stage

The main-thread ⇄ SAB ⇄ engine contract is already browser-shaped; the changes are
at the edges:

1. **Workers.** `worker_threads` → Web `Worker`. `worker.js`'s
   `require('./nvim.js')` becomes `importScripts`/ES-module load of the wasm glue.
   `child_process` is already gone (stage 2).

2. **Filesystem.** NODEFS is unavailable in the browser. Replace the `pre.js`
   NODEFS mounts with a virtual FS: `$VIMRUNTIME` from a fetched/bundled tarball
   unpacked into MEMFS (or IDBFS), user files from IDBFS / the File System Access
   API / an in-memory mount. Keep absolute-path semantics so nothing else changes.

3. **Terminal I/O on the page.** Two options for the UI surface:
   - Keep the builtin TUI and drive an **xterm.js** terminal: feed
     `process.stdout` writes into `term.write()`, and `term.onData()` into the
     stdin queue. Minimal C/JS change — `nvim_io.js`'s host-terminal ops just point
     at xterm.js instead of `process.std*`. Raw mode / winsize map to xterm.js.
   - Or swap the client for a DOM/canvas **grid renderer** fed by the same redraw
     RPC (no ANSI round-trip). Bigger, but the cleanest long-term UI.

4. **Headers.** `SharedArrayBuffer` needs COOP/COEP
   (`Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: require-corp`).

5. **JSPI in the browser.** Same `-sJSPI`; ensure the target browser has JSPI
   enabled (origin trial / flag) or ship an Asyncify fallback build.

6. **Process spawning** stays unavailable (`:terminal`, `:!`, `jobstart()`), same
   as Node — these `uv_spawn` paths return `ENOSYS`.

## Validated building blocks (don't re-derive)

- Engine in a worker over the SAB, blocking via `Atomics.wait` — works.
- Builtin TUI on the main thread, async (JSPI) poll, no busy-spin — works.
- `wasm/sab.js` SPSC ring transport — works across workers.
- `installHostTerminal` (fd 0 from a stdin queue, fd 1/2 raw out) + winsize via
  `tty.ops.ioctl_tiocgwinsz` — reuse for xterm.js by changing only the sink/source.
- Clean exit hinges on closing the SAB rings (worker `process.on('exit')`) so the
  client gets EOF, and on **never** resolving the async poll synchronously.
