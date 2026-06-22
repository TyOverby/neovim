# Stage 3 — Browser, and remaining polish

Stage 2 produced a working interactive editor under **Node** (builtin TUI on the
main thread, engine in a worker_thread, over a `SharedArrayBuffer`). Stage 3 takes
it to the **browser** and cleans up the rough edges. Prereq reading: `stage2.md`.

## ✅ Done: browser grid UI (`wasm/web/`)

Neovim now runs in the browser. The architecture is *simpler* than the Node TUI:
the page drops the wasm builtin-TUI client entirely and instead drives the engine
with a **custom UI written in plain JavaScript**.

```
   page main thread (wasm/web/ui.js)            Web Worker (engine-worker.js)
   ┌───────────────────────────────┐   SAB     ┌──────────────────────────┐
   │ keydown → nvim_input  ────────┼──ring────▶│ nvim --embed (wasm)      │
   │ redraw  → char grid → <pre> ◀─┼──ring─────┤ editor + ext_linegrid    │
   └───────────────────────────────┘           └──────────────────────────┘
       pure JS, no wasm, no JSPI                 blocks in poll via Atomics.wait
```

- **Engine in a Web Worker** (`engine-worker.js`): the browser analogue of
  `worker.js`. `importScripts('sab.js','nvim.js')`, fd 0/1 backed by the SAB ring,
  `__nvimCanBlockSync=true` so it blocks in `poll()` via `Atomics.wait` (allowed
  off the main thread). One binary serves both Node and browser.
- **Pure-JS UI on the page** (`ui.js`): a msgpack-RPC client (`@msgpack/msgpack`)
  that `nvim_ui_attach`es with `ext_linegrid`, decodes `redraw` (`grid_resize`,
  `grid_line`, `grid_scroll`, `grid_cursor_goto`, `flush`) into a 2-D char grid,
  and renders it into a `<pre>` — no fg/bg colour, just a cursor outline. Keyboard
  via `keydown → nvim_input`. The reverse channel is read with `Atomics.waitAsync`
  (no JSPI needed because no wasm runs on the page).
- **Filesystem**: `$VIMRUNTIME` is `--preload-file`'d into MEMFS (`nvim.data`);
  `pre.js` grew a browser path (no `process`, no NODEFS).
- **Headers**: `serve.js` sends COOP/COEP so the page is cross-origin isolated
  and `SharedArrayBuffer` is available. The wasm artifacts are routed to
  `build-wasm/bin/`, so the page JS can be edited and reloaded without rebuilding.

Validated in Chrome (via the isolated-chrome harness): attach + initial redraw,
insert-mode typing, multi-line editing, command-line mode (`:` drawn into the
bottom grid rows), `:s` substitution, and `<Esc>` cursor semantics — both through
real keystrokes and the `window.nvim.input()` test hook.

### Browser follow-ups (not yet done)

- **Trim the preloaded runtime.** `nvim.data` is ~22 MB (the whole `runtime/`).
  A `-u NONE` editing demo needs little beyond `runtime/lua`; prune to shrink it.
- **Live resize.** The grid is fixed 80×24. Measure the `<pre>` and call
  `nvim_ui_try_resize` on window resize (`window.nvim.resize(c,r)` already exists).
- **User files / persistence.** No host FS in the browser; wire IDBFS or the File
  System Access API for real files, and a writable state dir for shada.
- **JSPI fallback.** The Worker still instantiates a JSPI module (the poll import
  is suspending even though the Worker never suspends). Browsers without JSPI need
  an Asyncify fallback build, or a Worker-only non-JSPI variant.

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

## Browser stage (original plan — mostly realised above)

This was the forward plan before the work; the ✅ section above is what shipped.
Notably we chose the second UI option (a DOM grid renderer fed by the redraw RPC)
over xterm.js, and the page runs **no wasm** at all. Kept here for the rationale.

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
