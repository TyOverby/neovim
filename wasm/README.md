# neovim.js

`neovim.js` is a distribution of neovim that has been compiled to
wasm/javascript in order to run in a browser.  Unlike other project that host a
[Gui for neovim](https://neovim.io/doc/user/gui/) in the browser (with the guts
of neovim still running on a computer somewhere), `neovim.js` runs the entire
editor in the browser, removing the need to host a native server somewhere, and
the per-keystroke network round-trip that it entails.

There are three ways to use `neovim.js`: 

* As a standalone javascript library  
* As a chrome extension  
* As a hosted application

In all of these cases, the core neovim instance is run in a webworker, and can
be controlled by routing [neovim RPC calls](https://neovim.io/doc/user/api/#RPC) 
over [postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).

## As a library

Web app authors who want a good text editing component can embed neovim
directly in their application.  This can be a headless neovim instance with a
custom UI layer, or use our default UI renderer.

The sections below are split into two parts: **Available today**, a quickstart
against the API that ships right now, and a **Planned API** that captures where
the embedding experience is headed. Anything in the planned section is annotated
with whether it is live yet.

### Available today

The browser library is two UMD modules plus the `@msgpack/msgpack` global. You
load them with `<script>` tags (exactly as `wasm/web/index.html` does) — there is
no ESM `import`-from-URL build yet. The scripts must be served alongside the
engine assets (`engine-worker.js`, `nvim.js`/`nvim.wasm`/`nvim.data`); see
`wasm/web/build-site.sh` for assembling that bundle.

```html
<pre id="screen"></pre>

<!-- msgpack global, then the headless core, then the default renderer. -->
<script src="msgpack.min.js"></script>   <!-- @msgpack/msgpack UMD: globalThis.MessagePack -->
<script src="neovim.js"></script>        <!-- globalThis.Neovim -->
<script src="neovim-ui.js"></script>     <!-- globalThis.NeovimUI -->
<script>
  // 1. Core: spawn `nvim --embed` in a Web Worker and speak msgpack-RPC to it.
  //    `args` are nvim args WITHOUT `--embed` (the worker prepends it). This
  //    returns the instance SYNCHRONOUSLY — it is NOT a promise. To wait for the
  //    engine to be ready, await `nvim.ready` (a separate promise), not create().
  const nvim = Neovim.create({ args: ['-n'] });   // engineUrl defaults to 'engine-worker.js'

  // Out-of-band engine status: { kind: 'booting' | 'stdout' | 'stderr' | 'exit' | 'error', ... }
  nvim.onStatus((s) => {
    if (s.kind === 'error') { console.error('engine error', s.error); }
  });

  // 2. Renderer: mount the default grid UI into a <pre> and forward keystrokes.
  //    Accepts only { cols, rows } today. Rendering is a monochrome character
  //    grid (no syntax/fg/bg colour, just a cursor outline).
  const ui = NeovimUI.mount_into(nvim, document.getElementById('screen'), {
    cols: 80,
    rows: 24,
  });

  // 3. `nvim.ready` resolves (to the instance) once nvim_get_api_info round-trips,
  //    which also populates `nvim.chan` (this client's RPC channel id).
  nvim.ready.then(async () => {
    console.log('attached on channel', nvim.chan);

    // You have the full neovim RPC API over `request` (returns a Promise):
    await nvim.request('nvim_command', ['edit /tmp/scratch.txt']);

    // Drive the editor with raw key input:
    nvim.input('iHello<Esc>');

    // Subscribe to any notification method; the handler gets the params array.
    // Returns an unsubscribe function.
    const off = nvim.onNotification('redraw', (params) => { /* ... */ });
    // off();  // call to unsubscribe
  });
</script>
```

This is a trimmed version of the real page glue in `wasm/web/app.js`; read that
file for the complete, working example (including the status line).

You have the full power of the neovim RPC API via `nvim.request(...)`, and can
even build extensions as an embedder, allowing neovim to seamlessly communicate
with the rest of your application — by registering RPC notification handlers and
having neovim call `rpcnotify(nvim.chan, ...)` back at you.

#### Reference: the real surface today

`Neovim.create({ args, engineUrl, transport, MessagePack })` → instance
(synchronous). For the browser it spawns `engine-worker.js` as a Web Worker.
`args` are nvim args without `--embed`; `engineUrl` defaults to
`'engine-worker.js'`. (`Neovim.createNvim({ transport, MessagePack })` is the
lower-level, transport-supplied entry point used by the Node e2e test.)

The returned **instance**:

| Member | Description |
|---|---|
| `request(method, params)` | Send an RPC request. Returns a `Promise` of the result. |
| `notify(method, params)` | Send an RPC notification (no response). |
| `input(keys)` | Convenience for `notify('nvim_input', [keys])`. |
| `onNotification(method, fn)` | Subscribe to a notification (e.g. `'redraw'`); `fn` gets the params array. Returns an unsubscribe fn. |
| `onStatus(fn)` | Subscribe to out-of-band transport status (`{ kind, ... }`). Returns an unsubscribe fn. |
| `onRequest(fn)` | Set a handler `fn(method, params)` for requests the engine makes of the client (without one, the client replies nil). |
| `chan` | This client's RPC channel id. `null` until ready. |
| `ready` | A `Promise` that resolves to the instance once `nvim_get_api_info` round-trips (and `chan` is set). |
| `dispose()` | Tear down the transport / engine and reject in-flight requests. |

`NeovimUI.mount_into(instance, el, { cols, rows })` → `{ screen, resize(c, r),
dispose() }`. Wires the instance to a `<pre>`, attaches the UI
(`nvim_ui_attach` with `ext_linegrid`), renders on flush, and forwards
keystrokes. `screen` is a `NeovimUI.Screen` (the headless grid model);
`resize(c, r)` issues `nvim_ui_try_resize`; `dispose()` unsubscribes from
`redraw`. `NeovimUI.Screen` and `NeovimUI.keyToNvim` are also exported for
headless use.

### Planned API

The snippet below is the longer-term vision for the embedding API. It does **not**
run today — each feature is annotated with its current status. Today only
`args`, `engineUrl`, and `transport` are wired up on `create()`, and there is no
ESM build, no awaitable `create()`, no `neovim_utils.js`, and no `create_autocmd`
/ `add_notify_handler` / `read_file` instance methods.

```js
// PLANNED: ESM import-from-URL is not supported yet — today these are UMD
// modules loaded via <script> tags (see "Available today" above).
import neovim from 'https://tyoverby.com/neovim.js';

// utilities for hooking up a neovim instance to a dom element
import { mount_into } from 'https://tyoverby.com/neovim_ui.js';

// PLANNED: neovim_utils.js does not exist yet.
import { open_file_in_editor } from 'https://tyoverby.com/neovim_utils.js';

// PLANNED: `await neovim.create(...)` — create() is synchronous today and is NOT
// awaitable. The real pattern is: `const nvim = neovim.create({...}); await nvim.ready;`
const instance = await neovim.create({
  // PLANNED: selects between differently-packaged `nvim.data` runtime bundles
  // (a full runtime vs. a smaller core set). NOT about toggling `-u NONE`.
  plugins: 'full',
  // PLANNED: not implemented — only args/engineUrl/transport work today.
  cwd: "/bar",
  // PLANNED: not implemented.
  filesystem: { "/bar/foo.txt": "content of /bar/foo.txt" },
  // PLANNED: not implemented.
  env: { "HOME": "/bar" },
  // PLANNED: not implemented.
  clipboard: "browser"
});

// PLANNED: neovim_utils.js helper — does not exist yet.
await open_file_in_editor(instance, "/bar/foo.txt");

const notification_name = "file_saved";

// PLANNED: instance.create_autocmd is not a method today. You can already get
// the same effect with the real API by sending the equivalent nvim_command /
// nvim_create_autocmd RPC via `instance.request(...)`, using `instance.chan`.
await instance.create_autocmd(["BufWritePost"], {
    "pattern": ["*"],
    "group": "MyPlugin",
    "command": `call rpcnotify(${instance.chan}, '${notification_name}', expand('<afile>:p'), bufnr('%'))`
});

// PLANNED: instance.add_notify_handler is not a method today. The shipping
// equivalent is `instance.onNotification('file_saved', fn)`.
await instance.add_notify_handler('file_saved', async function ([filename]) {
  // PLANNED: instance.read_file does not exist yet.
  let contents = await instance.read_file(filename);
  alert(filename + " has been saved: " + contents);
});

// mount_into ships today, but PLANNED: it accepts only { cols, rows } now —
// `font_family` / `font_size` are not yet supported, and rendering is monochrome.
const ui = await mount_into(instance, document.querySelector(".code-container", {
  font_family: "monospace",
  font_size: 16,
});
```

The end goal is that you have the full power of the neovim RPC API, and can even
build extensions as an embedder, allowing neovim to seamlessly communicate with
the rest of your application.

## As a chrome extension

Have you ever been on a webpage and wished that a textarea on the page was
neovim instead?  Now you don't have to!  With a single keybinding, you can
replace a textarea with a full vim, copying the current contents of the
textarea into a vim buffer, and write back into the textarea with `:w`.

The vim instance that the page uses is actually a long-lived extension-owned
web-worker, so startup time is minimized, and the users `vimrc` can be
configured and follow them around between sites.

## As a standalone application

The most ambitious part of the project, the standalone `neovim.js` application
is designed to be a full replacement for running neovim on a remote server.
With a standard neovim setup, typing responsiveness is tied to the latency of
your connection to the machine that is running neovim, so if you're renting a
computer half way around the world, the experience is borderline unusable.  But
with the standalone `neovim.js` application, you start the server on a remote
machine, and visit the page that it's hosting.  Because the entire vim engine
is local to your browser, text editing and plugin execution is lightning fast.
Filesystem access, network connections, shells, LSP servers, commands, and
PTY's are all transparently proxied through the server, so they run for real on
the system that you care about.

# Neovim on WebAssembly (Emscripten + Node / Browser)

This directory contains everything needed to cross-compile Neovim to WebAssembly
with Emscripten and run it **in a browser** (a custom JavaScript grid UI on the
page), with the same engine also runnable **headlessly under Node.js** (for the
e2e test and `--headless`/`-l` scripting). It uses JSPI — JavaScript Promise
Integration — where wasm runs, and **postMessage** between the editor (in a
worker) and its UI. No `SharedArrayBuffer`, so the browser build needs no special
HTTP headers and runs on any static host.

> An earlier stage shipped an interactive **builtin TUI** that ran the wasm UI
> client on the Node main thread (`nvim file.txt`). It was a stepping stone to
> prove the worker + JSPI + postMessage architecture under Node, and has been
> removed now that the browser UI works and the headless e2e test covers the
> engine path. `stage2.md` records it for history.

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
| Engine in a worker + JS client over `postMessage` | ✅ |
| **Browser: engine in a Web Worker + pure-JS grid UI** | ✅ (stage 3 — see `stage3.md`, `wasm/web/`) |
| Headless end-to-end test (engine in a Node worker) | ✅ (`wasm/web/e2e.test.js`) |
| `:terminal`, `:!cmd`, jobs (process spawning) | ❌ stubbed (no spawn in wasm) |

## Prerequisites

- Emscripten (`emcc`) ≥ 3.1.6x (has `-sJSPI`).
- Node with JSPI (`WebAssembly.Suspending`):
  - **v24+** (v26 tested): on by default, no flag.
  - **v22**: pass `--experimental-wasm-jspi` (e.g.
    `node --experimental-wasm-jspi build-wasm/bin/nvim.js -- --version`). The engine
    worker inherits `process.execArgv`, so the flag only goes on the top-level node.
  - **v20 and older**: unsupported (only the older `WebAssembly.Suspender` API).
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
# Browser grid UI (the primary target): serve the page and open it.
node wasm/web/serve.js          # then open http://localhost:8000/

# Headless end-to-end test (boots the engine in a Node worker_thread).
node wasm/web/e2e.test.js

# Headless engine directly (Node 22/23 need the JSPI flag; 24+ don't):
node build-wasm/bin/nvim.js -- --version
node build-wasm/bin/nvim.js -- -u NONE --headless -l script.lua
```

### Browser (engine in a Web Worker + pure-JS grid UI)

```sh
node wasm/web/serve.js          # plain static server (default :8000)
# then open http://localhost:8000/  in a JSPI-capable browser (Chrome ≥ 137)
```

The page (`wasm/web/`) runs `nvim --embed` in a Web Worker and renders the
`ext_linegrid` grid into a `<pre>` with a small msgpack-RPC client on the main
thread — **no wasm and no JSPI on the page**, only in the Worker. Click the grid
and type. See `stage3.md` for the design and `wasm/web/` for the code.

### Deploy to a static host (GitHub Pages)

The site is fully static — no backend. Because the transport is postMessage (not
`SharedArrayBuffer`), the page needs **no COOP/COEP headers and no cross-origin
isolation**, so it works on any static host, including GitHub Pages, with nothing
special to configure.

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
| `build-nvim.sh` | Configure + build nvim to wasm; install the Node engine host (`worker.js`). |
| `shim.h` | Force-included into every emcc compile (`EMCC_CFLAGS`); small libc gap fills (pthread thread-name stubs). |
| `uv_stubs.c` | libuv / libc functions the Emscripten builds omit (sys-info, `uv_exepath`, `sched_*`, `pthread_*_np`). Linked into nvim only for wasm. |
| `extern-pre.js` | Emscripten `--extern-pre-js` (runs before everything): under Node, points `locateFile` at nvim.js's dir so the preloaded `nvim.data` resolves from any cwd. |
| `pre.js` | Emscripten `--pre-js`: argv, the postMessage-channel global, `$VIMRUNTIME`, and the environment. Node path mounts the host FS via NODEFS; browser path uses the preloaded runtime in MEMFS. |
| `nvim_io.js` | Emscripten `--js-library`: async (JSPI) `__syscall_poll` and the postMessage-backed channel stream ops for the engine's fd 0/1. |
| `worker.js` | Node engine host: runs `nvim --embed` wasm in a worker_thread, fd 0/1 carried over the worker's postMessage channel (the Node analogue of `web/engine-worker.js`; used by the e2e test). |
| `web/` | Browser target, split into the layers the goals call for: `neovim.js` (headless msgpack-RPC core — a transport-agnostic instance), `neovim-ui.js` (default renderer: a headless `Screen` grid-decode + DOM `mount_into`), `app.js` (page glue that composes them), `index.html`, `engine-worker.js` (Web Worker engine host), `serve.js` (plain static dev server), `build-site.sh` (assemble the static bundle), `e2e.test.js` (headless end-to-end test over a Node worker engine). Uses `@msgpack/msgpack` (npm). |
| `stage1.md` / `stage2.md` / `stage3.md` | History: stage 1 (cross-compile), stage 2 (interactive TUI — since removed), stage 3 (browser grid UI). |

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
  `--extern-pre-js`, `--pre-js`, `--js-library`.
- `src/nvim/channel.c` — for the engine's `nvim --embed` channel, skip the
  embedded dup/redirect dance on Emscripten (fd 0/1 are virtual postMessage
  streams, not real pipes; no child to protect them from).
- `src/nvim/log.h` — `-DNVIM_WASM_TRACE` (wasm) lowers the min log level (debug aid).

## Architecture: engine in a worker + message passing

Modern Neovim already splits the **editor server** (`nvim --embed`) from its
**UI client**, which talk msgpack-RPC (UI input → `nvim_input`; server → `redraw`).
We keep that split but run the engine in a *worker* and make the *transport*
**postMessage**, with the client written in plain JavaScript on the other side:

```
   client (plain JS)                    worker (engine)
   ┌─────────────────────┐             ┌──────────────────────┐
   │ UI / RPC client     │  msgpack    │ nvim --embed (wasm)  │
   │ input → / redraw ◀──┼──RPC────────┼─> editor             │
   └─────────┬───────────┘ postMessage └──────────┬───────────┘
             └────────────────────────────────────┘
```

- The engine **does not block**. nvim's `poll()` suspends asynchronously via JSPI
  and resumes when a message arrives or the libuv timeout elapses. That is what
  makes postMessage usable at all: a thread parked in a synchronous wait would
  never return to its event loop to receive a message. (A `SharedArrayBuffer` +
  `Atomics.wait` would allow synchronous blocking, but then postMessage couldn't
  be delivered — and it would force COOP/COEP on the browser. Message passing
  avoids both.)
- The **client runs no wasm**: it's the JS in `wasm/web/` (`neovim.js` +
  `neovim-ui.js`) in the browser, or the e2e test's core under Node. Only the
  engine worker instantiates a JSPI module, so only it (and thus the browser)
  needs JSPI support.

### Architecture: the browser web UI (`wasm/web/`)

The browser target keeps the same engine-in-a-worker split but replaces the wasm
builtin-TUI client with a **custom UI written in plain JavaScript**. The result is
*simpler* than the Node TUI: the page runs **no wasm, no JSPI, and no SAB**, so it
needs no cross-origin isolation.

```
   page main thread (neovim.js + neovim-ui.js)  Web Worker (engine-worker.js)
   ┌───────────────────────────────┐ postMessage ┌──────────────────────────┐
   │ keydown → nvim_input  ────────┼────────────▶│ nvim --embed (wasm)      │
   │ redraw  → char grid → <pre> ◀─┼─────────────┤ editor + ext_linegrid    │
   └───────────────────────────────┘             └──────────────────────────┘
       pure JS, no wasm, no JSPI                   poll() suspends via JSPI
```

- **Engine in a Web Worker** (`engine-worker.js`) — the browser analogue of
  `worker.js`. It `importScripts('nvim.js')`, backs fd 0/1 with a postMessage
  channel (fd 0 ← messages from the page; fd 1 → `postMessage` to the page), and
  the engine's `poll()` suspends via JSPI between messages. The same `nvim.wasm`
  serves both Node and browser (`-sENVIRONMENT=node,web,worker`).
- **Pure-JS UI on the page** — split into a headless core (`neovim.js`, the
  msgpack-RPC client over `@msgpack/msgpack`) and the default renderer
  (`neovim-ui.js`), composed by `app.js`. Together they:
  1. `nvim_ui_attach`es with `{ ext_linegrid: true }`;
  2. decodes `redraw` notifications (`grid_resize`, `grid_line`, `grid_scroll`,
     `grid_cursor_goto`, `flush`) into a 2-D character grid;
  3. renders that grid into a `<pre>` — **no fg/bg colour**, just a cursor outline.
     The command line and messages are drawn by Neovim into the bottom grid rows
     (we don't request `ext_cmdline`/`ext_messages`), so `:`, `:w`, etc. show up;
  4. maps DOM `keydown` → `nvim_input`.

  No wasm runs on the page, so it needs no JSPI; it just sends `worker.postMessage`
  and decodes RPC from the worker's `onmessage`. Only the Worker instantiates a
  JSPI module, so the *browser* must support JSPI (Chrome ≥ 137).
- **No special headers** — postMessage needs no `SharedArrayBuffer`, so the page
  does not have to be cross-origin isolated; it runs on any static host as-is.
- **Filesystem** — no host FS, so `$VIMRUNTIME` is preloaded into MEMFS at build
  time (see below). `-u NONE -i NONE` by default (no config, no shada).
- **Testing hook** — `window.nvim.input(keys)`, `.gridText()`, `.resize(c,r)` and
  `.state()` are exposed for driving/asserting from automation or the console.

`stage3.md` records the design, what shipped, and the remaining browser follow-ups
(trim the ~22 MB preloaded runtime, live resize, IDBFS for real files).

### Filesystem: MEMFS + NODEFS (not NODERAWFS)

The wasm build uses MEMFS with a NODEFS mount of the host filesystem (set up in
`pre.js`), **not** NODERAWFS. NODERAWFS routes fd I/O straight to Node fds, which
makes purely-virtual fds (the in-worker engine channel, the client's RPC fds)
impossible. With MEMFS the channel fds are first-class virtual streams backed by
the postMessage channel (`nvim_io.js`), while real files stay reachable through
the NODEFS mount. In the **browser** there is no host FS, so `$VIMRUNTIME`
is bundled into MEMFS at build time (`--preload-file runtime@/usr/share/nvim/runtime`,
shipped as `nvim.data`) and `pre.js` skips the NODEFS mounts — same channel ops.

## Known limitations

- No process spawning: `:terminal`, `:!`, and `jobstart()` are unavailable;
  the relevant libuv/`uv_spawn` calls fail with `ENOSYS`.
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
