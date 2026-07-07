# Stage 3 — Browser, and remaining polish

Stage 2 produced a working interactive editor under **Node** (builtin TUI on the
main thread, engine in a worker_thread). Stage 3 takes it to the **browser** and
cleans up the rough edges. Prereq reading: `stage2.md`.

## ✅ Done: browser grid UI (`wasm/web/`), on a postMessage transport

Neovim now runs in the browser. The architecture is *simpler* than the Node TUI:
the page drops the wasm builtin-TUI client entirely and instead drives the engine
with a **custom UI written in plain JavaScript**.

```
   page main thread (wasm/web/ui.js)            Web Worker (engine-worker.js)
   ┌───────────────────────────────┐ postMessage ┌──────────────────────────┐
   │ keydown → nvim_input  ─────────┼────────────▶│ nvim --embed (wasm)      │
   │ redraw  → char grid → <pre> ◀──┼─────────────┤ editor + ext_linegrid    │
   └───────────────────────────────┘             └──────────────────────────┘
       pure JS, no wasm, no JSPI                   poll() suspends via JSPI
```

- **Engine in a Web Worker** (`engine-worker.js`): the browser analogue of
  `worker.js`. `importScripts('nvim.js')`, fd 0/1 backed by a postMessage channel
  (fd 0 ← messages from the page, fd 1 → `postMessage` to the page). One binary
  serves both Node and browser.
- **Pure-JS UI on the page** (`ui.js`): a msgpack-RPC client (`@msgpack/msgpack`)
  that `nvim_ui_attach`es with `ext_linegrid`, decodes `redraw` (`grid_resize`,
  `grid_line`, `grid_scroll`, `grid_cursor_goto`, `flush`) into a 2-D char grid,
  and renders it into a `<pre>` — no fg/bg colour, just a cursor outline. Keyboard
  via `keydown → nvim_input`. RPC out via `worker.postMessage`; RPC in decoded
  from the worker's `onmessage`. No wasm/JSPI on the page.
- **Filesystem**: `$VIMRUNTIME` is `--preload-file`'d into MEMFS (`nvim.data`);
  `pre.js` grew a browser path (no `process`, no NODEFS). `extern-pre.js` fixes the
  data-file path under Node (it resolves cwd-relative otherwise — see Gotchas).
- **No special headers**: postMessage needs no `SharedArrayBuffer`, so the page
  needs no COOP/COEP and no cross-origin isolation — it runs on any static host.
  `serve.js` is a plain static server; it routes the wasm artifacts to
  `build-wasm/bin/`, so the page JS can be edited and reloaded without rebuilding.

Validated in Chrome (via the isolated-chrome harness, on a header-less server with
`crossOriginIsolated === false`): attach + initial redraw, insert-mode typing,
multi-line editing, command-line mode (`:` drawn into the bottom grid rows), `:s`
substitution. The Node TUI was validated with a `pty` harness (type + `:w` saves
to the host file). Both run over the same postMessage path.

### Why postMessage, not SharedArrayBuffer

SAB's only real job here was to let the engine **block** synchronously
(`Atomics.wait`) waiting for input. But a thread parked in a synchronous wait
never returns to its event loop, so it could never receive a `postMessage`. To use
message passing the engine must instead **suspend asynchronously** — which is
exactly what JSPI already does for the client's `poll()`. So both roles now
suspend via JSPI and exchange bytes over postMessage. Upside: no `SharedArrayBuffer`
⇒ no COOP/COEP ⇒ no `coi-serviceworker` ⇒ deploys to any static host. Cost: the
engine worker now genuinely suspends/resumes per poll (negligible for an editor).

### Browser follow-ups (not yet done)

- **Trim the preloaded runtime.** `nvim.data` is ~22 MB (the whole `runtime/`).
  A `-u NONE` editing demo needs little beyond `runtime/lua`; prune to shrink it.
- **Live resize.** The grid is fixed 80×24. Measure the `<pre>` and call
  `nvim_ui_try_resize` on window resize (`window.nvim.resize(c,r)` already exists).
- **User files / persistence.** No host FS in the browser; wire IDBFS or the File
  System Access API for real files, and a writable state dir for shada.
- **JSPI fallback.** Both roles now instantiate a JSPI module *and rely on it*.
  Browsers without JSPI need an Asyncify fallback build.

### Gotchas (this stage)

- **`ENOENT: open 'nvim.data'`.** The `--preload-file` data-package loader resolves
  its path *cwd-relative* under Node (unlike the `.wasm` loader, which uses the
  script dir), and it is emitted at the very top of `nvim.js` — before `--pre-js`.
  Fix: set `Module.locateFile` from `--extern-pre-js` (`wasm/extern-pre.js`), which
  runs before the loader. Without it, `node nvim.js` works only from `build-wasm/bin`.
- **postMessage ⇒ no synchronous blocking.** The engine must suspend (JSPI), never
  `Atomics.wait`; a blocked worker never delivers `onmessage`. Pacing the async
  poll through real events (`onmessage`/`setTimeout`, i.e. macrotasks) also keeps
  `os_hrtime` advancing — the same hazard stage 2 hit with a microtask spin.

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

5. **Process spawning** stays unavailable (`:terminal`, `:!`, `jobstart()`), same
   as the browser — these `uv_spawn` paths return `ENOSYS`.

## Validated building blocks (don't re-derive)

- Engine in a worker (Node worker_thread / browser Web Worker) over postMessage,
  `poll()` suspending via JSPI — works in both.
- Builtin TUI on the Node main thread, async (JSPI) poll, no busy-spin — works.
- Pure-JS page UI: msgpack-RPC over `worker.postMessage` + `onmessage`, redraw →
  `<pre>` grid — works with `crossOriginIsolated === false` (no SAB, no headers).
- `installHostTerminal` (fd 0 from a stdin queue, fd 1/2 raw out) + winsize via
  `tty.ops.ioctl_tiocgwinsz`.
- Clean exit: the engine worker exiting closes the channel (Node: worker `'exit'`;
  browser: `Module.onExit` → `{kind:'exit'}`) so the consumer sees EOF; and the
  async poll must **never** resolve synchronously (macrotask pacing only).
