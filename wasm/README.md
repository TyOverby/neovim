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

The browser library ships two ways: as UMD modules (`neovim.js`, `neovim-ui.js`)
loaded via `<script>` tags (exactly as `wasm/web/index.html` does), or as ESM
entry points (`neovim.mjs`, `neovim-ui.mjs`) you `import`. Both must be served
alongside the engine assets (`engine-worker.js`, `nvim.js`/`nvim.wasm` plus a
runtime package `nvim-<variant>.data`/`.data.js` — see **Runtime bundles**).
The UMD path also needs the `@msgpack/msgpack` UMD loaded as a `<script>` (the
`globalThis.MessagePack` global); the ESM path needs **no separate msgpack
wiring** — `neovim.mjs` resolves `@msgpack/msgpack` itself (the bundled ESM build,
the `MessagePack` global if present, or an explicit `MessagePack` option).

To assemble a redistributable, npm-importable bundle of all of that into a flat,
relative-path directory, run `wasm/web/build-lib.sh` (the library analogue of the
demo-site `build-site.sh`). It emits the UMD + ESM JS, the engine worker, the
msgpack dep (both the UMD `msgpack.min.js` and the ESM build under `msgpack.esm/`),
the `nvim.*` engine assets, and a generated `package.json` whose `exports` map
points `import` at the `.mjs` and `main`/`require` at the UMD — so the bundle can
be published to npm or hosted on any static path.

```html
<pre id="screen"></pre>

<!-- msgpack global, then the headless core, then the default renderer. -->
<script src="msgpack.min.js"></script>   <!-- @msgpack/msgpack UMD: globalThis.MessagePack -->
<script src="neovim.js"></script>        <!-- globalThis.Neovim -->
<script src="neovim-ui.js"></script>     <!-- globalThis.NeovimUI -->
<script>
  // 1. Core: spawn `nvim --embed` in a Web Worker and speak msgpack-RPC to it.
  //    `args` are nvim args WITHOUT `--embed` (the worker prepends it).
  //    create() returns an awaitable promise-facade: you can `await
  //    Neovim.create(...)` for a ready instance, OR (as here) use the result
  //    synchronously and `await nvim.ready` later — both work off the same object.
  //    `baseUrl` points create() at wherever the bundle is hosted (default: the
  //    page's own directory); pass it when you serve the bundle from a subpath.
  //    Optional runtime config: { env, cwd, filesystem } (see the reference below).
  const nvim = Neovim.create({ args: ['-n'] });   // or: { args, baseUrl: '/lib/' }

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

The same API is available as ESM. The `.mjs` entry points re-export exactly the
UMD surface (`create`, `createNvim`, `browserEngineTransport`, `ByteQueue` from
the core; `Screen`, `mount_into`, `keyToNvim` from the renderer) plus a `default`
export, so you can `import` instead of using `<script>` globals:

```js
import { create } from './neovim.mjs';        // or '/lib/neovim.mjs'
import { mount_into } from './neovim-ui.mjs';

// `baseUrl` makes engine-worker.js + nvim.js/.wasm + the nvim-<variant>.data
// package all resolve under that path (with or without a trailing slash). The
// engine worker is created with `new Worker(baseUrl + 'engine-worker.js')`; it
// then `importScripts('nvim-<variant>.data.js')` and `importScripts('nvim.js')`
// relative to its own URL, and Emscripten resolves nvim.wasm relative to nvim.js
// — so the whole chain follows `baseUrl` with no extra wiring.
// (`new Worker` is same-origin only, so `baseUrl` may be a subpath of the page's
// origin but not yet a different-origin CDN.) `engineUrl` overrides `baseUrl`.
const nvim = create({ args: ['-n'], baseUrl: '/lib/' });
const ui = mount_into(nvim, document.getElementById('screen'), { cols: 80, rows: 24 });
await nvim.ready;
```

No `<script>` tag and no separate msgpack import are needed on the ESM path:
`neovim.mjs` injects `@msgpack/msgpack` into `create()`/`createNvim()` for you,
resolving it as `opts.MessagePack` (explicit override) → `globalThis.MessagePack`
(if a UMD `<script>` happened to load it) → the ESM build bundled at
`msgpack.esm/` by `build-lib.sh`. (In the raw source tree, where `msgpack.esm/`
is absent, the import still succeeds; only a `create()` with no msgpack available
anywhere errors — so pass the `MessagePack` option if you import the source
directly without building the bundle.)

You have the full power of the neovim RPC API via `nvim.request(...)`, and can
even build extensions as an embedder, allowing neovim to seamlessly communicate
with the rest of your application — by registering RPC notification handlers and
having neovim call `rpcnotify(nvim.chan, ...)` back at you.

#### Reference: the real surface today

`Neovim.create({ args, baseUrl, engineUrl, transport, MessagePack, env, cwd,
filesystem })` → a **promise-facade**. For the browser it spawns
`engine-worker.js` as a Web Worker. `args` are nvim args without `--embed`.
`baseUrl` is where the bundle is hosted (the engine URL becomes `baseUrl +
'engine-worker.js'`, trailing slash optional); `engineUrl` is an explicit override
that takes precedence over `baseUrl`; with neither, the engine URL defaults to
`'engine-worker.js'` (the page's own directory).

The return value is **awaitable**: `const nvim = await Neovim.create({...})`
yields a fully-usable, *ready* instance. The same object also carries the
instance's synchronous members forwarded onto it (`request`, `notify`, `input`,
`onNotification`, `onStatus`, `onRequest`, `dispose`, `ready`, and a live `chan`
getter), so you can keep using it synchronously without awaiting — subscribe to
`onStatus`, call `mount_into`, then `await nvim.ready` (or `nvim.ready.then(...)`)
exactly as before. (Internally the facade is a real `Promise` that fulfills with
the *distinct* instance, so awaiting it never deadlocks.)

`env`, `cwd`, `filesystem`, and `plugins` are optional **runtime config** applied
before the engine's `main()` runs (they ride the engine worker's init message →
`pre.js`). They take effect only on the default browser worker path, not when you
supply your own `transport`:

| Option | Meaning |
|---|---|
| `env: { KEY: 'val', ... }` | Environment overrides applied on top of the defaults (`HOME`, `TERM`, …). Caller values win — set arbitrary vars or override `HOME`. |
| `filesystem: { '/abs/path': contents, ... }` | Seed files into the in-memory wasm FS before boot. Missing parent dirs are created. `contents` is a string (or a `Uint8Array` for binary). Lets a browser embedder open files with no host FS. |
| `cwd: '/abs/path'` | `chdir` into this directory after the filesystem is seeded (so a cwd inside a `filesystem` dir works). Fails soft — a missing dir is logged and the default cwd is kept. |
| `plugins: 'full' \| 'core' \| 'minimal'` | Selects which **runtime bundle** the engine loads (default `'full'`). All three share one `nvim.wasm`; they differ only in the `nvim-<variant>.data` package the engine worker loads. See **Runtime bundles** below. An unknown value throws from `create()`. |

#### Runtime bundles (the `plugins` option)

`nvim.wasm` is **runtime-agnostic** — it bakes in *no* `$VIMRUNTIME`. The runtime
ships separately as one Emscripten `file_packager` data package per variant
(`nvim-<variant>.data` + a small `nvim-<variant>.data.js` loader), and the engine
worker loads the chosen one **before** `nvim.js`, unpacking it into the in-memory
FS at `/usr/share/nvim/runtime`. Because the `.wasm` is shared, switching variants
costs no recompile and no relink — only a different `(data + loader)` pair.

| `plugins` | Contents | Approx `.data` size |
|---|---|---|
| `'full'` (default) | The complete runtime — today's behavior, unchanged. | ~22 MB |
| `'core'` | Boots + edits + filetype detection + indent + a **curated** syntax-highlighting slice for common languages (`autoload/`, `colors/`, `compiler/`, `keymap/`, `ftplugin/`, `indent/`, the whole `pack/`, and ~40 hand-picked `syntax/` languages). Drops `doc/`, `tutor/`, `spell/`, treesitter `queries/`, and the bulk of `syntax/`. | ~8.7 MB |
| `'minimal'` | Strictly the boot/edit essentials: `lua/` (the `vim.*` stdlib — **mandatory**, nvim will not boot without it), `plugin/`, `scripts/`, `filetype.lua`, plus the tiny `syntax/` *framework* (`syntax.vim`/`synload.vim`/… ~16 KB) so nvim's default `syntax on` succeeds — with **no language files** so nothing is actually highlighted. No `ftplugin/`, no `indent/`, no `doc/`. | ~3.1 MB |

The variants are staged and packaged by `wasm/build-nvim.sh` (which defines the
exact file-inclusion lists). The exact subset is therefore a build artifact, not a
runtime toggle — `plugins` only selects *which already-built package* to load.

**Each variant must boot clean.** A staged subset has to start (under `-n`, i.e.
plugins loaded) with no startup `E###` error and no "Press ENTER" prompt — a
prompt blocks all subsequent RPC, making the variant unusable. Two traps the
trimmed variants navigate: (1) `plugin/netrwPlugin.vim` and `plugin/matchit.vim`
`packadd` packages from `pack/`, so **core ships the whole `pack/`** while
**minimal drops those two plugin scripts**; (2) nvim's default `syntax on` sources
`syntax/syntax.vim`, so even no-highlighting **minimal still ships the syntax
framework**. `build-nvim.sh` enforces this with a **headless boot gate**: it points
`$VIMRUNTIME` at each staged variant, boots `nvim -n --headless` under an isolated
empty `$HOME`, and fails the build if the captured `:messages`/stderr contain any
`E###` or a hit-enter prompt.

> **Under Node** the `plugins` option is moot: there is no data package at all.
> `nvim.js`'s Node host reads the runtime straight from the on-disk `runtime/`
> tree via the NODEFS mount (`pre.js` points `$VIMRUNTIME` at `../../runtime`),
> so Node always has the full runtime. The data packages are a browser concern.

To **ship a single variant** in a redistributable bundle, pass it to
`build-lib.sh`: `wasm/web/build-lib.sh _lib --variant minimal` copies the shared
`nvim.wasm` + the chosen `nvim-minimal.data`/`.data.js` and tells you to select it
with `create({ plugins: 'minimal' })`. `--variant all` ships all three so the
embedder can switch at runtime; the default is `full`.

(`Neovim.createNvim({ transport, MessagePack })` is the lower-level,
transport-supplied entry point used by the Node e2e test. It returns a **plain
synchronous instance** — it is *not* awaitable; `await createNvim(...).ready`.)

The returned **instance** (also reachable synchronously off the facade):

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

#### The helper layer (`neovim-utils.js`)

`neovim-utils.js` (UMD global `globalThis.NeovimUtils`; ESM `neovim-utils.mjs`;
`./utils` subpath in the `build-lib.sh` bundle) is a thin layer of **free
functions** over the instance. They are deliberately **not** instance methods —
the core surface above stays exactly as-is. Each helper takes the instance as its
first argument and is built only on the public API (`request` / `onNotification` /
`chan`), so the same code runs in the browser and under the Node e2e test.

```html
<script src="neovim-utils.js"></script>   <!-- after neovim-ui.js: globalThis.NeovimUtils -->
```
```js
import { open_file_in_editor, on_autocmd } from './neovim-utils.mjs';
```

| Helper | Description |
|---|---|
| `open_file_in_editor(instance, path)` → `Promise` | Open `path` in the current window via `nvim_cmd({ cmd: 'edit', args: [path] }, {})` (no manual `:edit` escaping). Resolves when the edit completes. |
| `read_file(instance, path)` → `Promise<string \| null>` | Read `path` from the **engine's** in-memory FS (the JS client can't touch it directly) and return the contents as one string, lines joined by `'\n'`. Resolves to **`null`** if the file does not exist / is unreadable (only a real Lua/RPC error rejects). |
| `write_file(instance, path, content)` → `Promise` | Write the string `content` to `path` in the engine FS, creating missing parent dirs (`mkdir(..., 'p')`). Splits on `'\n'` via `writefile(vim.split(content,'\n'), path)`. Resolves when the write completes. |
| `create_autocmd(instance, events, opts)` → `Promise<number>` | Thin wrapper over `nvim_create_autocmd`; `events` (string or array) and `opts` pass straight through. Resolves to the autocmd id. |
| `add_notify_handler(instance, name, fn)` → `unsubscribe()` | Sugar over `instance.onNotification(name, fn)` — subscribe `fn` (receives the params array) to RPC notifications named `name`. Returns the unsubscribe fn. |
| `on_autocmd(instance, events, opts, fn)` → `Promise<handle>` | **The combined convenience.** Creates a dedicated augroup + an autocmd whose action `rpcnotify`s this client, AND registers `fn` for that notification — the whole "notify me on `<event>`" round-trip in one call. See below. |

`on_autocmd(instance, events, opts, fn)` collapses the ~15-line autocmd +
`rpcnotify` + `onNotification` dance. `events` is a string or array (e.g.
`'BufWritePost'`); `opts` is merged into the `nvim_create_autocmd` opts
(`pattern` defaults to `'*'`; a caller `command`/`callback`/`group` is ignored —
the helper owns the action and the group). The generated autocmd runs
`call rpcnotify(<instance.chan>, '<generated-name>', expand('<afile>:p'), bufnr('%'))`.
Call it **after** the instance is ready (`instance.chan` must be set); it awaits
`instance.ready` and throws if there is still no channel.

`fn` is invoked as `fn(payload)` where the **payload** is:

```js
{
  file:   '<string>',  // absolute path the event fired for (expand('<afile>:p'); '' if N/A)
  buffer: <number>,    // current buffer number (bufnr('%'))
  event:  <events>,    // the `events` argument, as passed in
  params: [file, buffer],  // the raw rpcnotify params array
}
```

It resolves to a **handle** `{ id, group, name, unsubscribe() }`: `id` is the
autocmd id, `group` the augroup id, `name` the generated notification name, and
`unsubscribe()` removes the notification handler **and** deletes the augroup (so
the engine stops firing the rpcnotify); it returns a Promise and is idempotent.

### Planned API

The snippet below is the longer-term vision for the embedding API. Parts of it
run today — each feature is annotated with its current status. ESM `import`,
`baseUrl`, the `build-lib.sh` bundle, an **awaitable `create()`**, the
**`env` / `cwd` / `filesystem`** runtime config, **`plugins`** (runtime-bundle
selection), and **`neovim-utils.js`** (the `open_file_in_editor` /
`read_file` / `write_file` / `create_autocmd` / `add_notify_handler` /
`on_autocmd` **free functions** — see "Available today") now ship. Still planned:
the `clipboard` option and the renderer's `font_family` / `font_size`. Note the
helpers ship as free functions `helper(instance, ...)`, **not** as instance
methods (`instance.helper(...)`) — the snippet below uses the planned-method
shape, but the real calls are the free-function form. Same-origin-only is the one remaining ESM gap: `import` works,
but `new Worker()` (and thus `baseUrl`) can't point at a different-origin CDN yet
— `https://tyoverby.com/neovim.js` from a different origin needs a Blob-bootstrap
shim that isn't built.

```js
// SHIPS TODAY as a local/same-origin import (e.g. './neovim.mjs' or '/lib/neovim.mjs').
// PLANNED: cross-ORIGIN import-from-URL like the absolute URL below still needs a
// Blob-bootstrap shim for the worker (new Worker is same-origin only).
import neovim from 'https://tyoverby.com/neovim.js';

// utilities for hooking up a neovim instance to a dom element (SHIPS TODAY at
// neovim-ui.mjs; cross-origin URL still PLANNED as above)
import { mount_into } from 'https://tyoverby.com/neovim-ui.js';

// SHIPS TODAY at neovim-utils.mjs: the helpers are FREE FUNCTIONS that take the
// instance as the first arg (helper(instance, ...)), NOT instance methods.
// (cross-origin URL still PLANNED as above.)
import { open_file_in_editor, on_autocmd, read_file }
  from 'https://tyoverby.com/neovim-utils.js';

// SHIPS TODAY: `await neovim.create(...)` resolves to a ready instance (create()
// returns an awaitable promise-facade). The synchronous pattern still works too:
// `const nvim = neovim.create({...}); await nvim.ready;`
const instance = await neovim.create({
  // SHIPS TODAY: selects which packaged runtime bundle the engine loads --
  // 'full' (default) | 'core' | 'minimal', all sharing one nvim.wasm. NOT about
  // toggling `-u NONE`. See "Runtime bundles" above.
  plugins: 'full',
  // SHIPS TODAY: chdir into this dir after the filesystem is seeded.
  cwd: "/bar",
  // SHIPS TODAY: seed files into the in-memory wasm FS before boot (parent dirs
  // are created; values are string or Uint8Array contents).
  filesystem: { "/bar/foo.txt": "content of /bar/foo.txt" },
  // SHIPS TODAY: environment overrides applied on top of the defaults.
  env: { "HOME": "/bar" },
  // PLANNED: not implemented.
  clipboard: "browser"
});

// SHIPS TODAY: a free function (instance is the first arg).
await open_file_in_editor(instance, "/bar/foo.txt");

// SHIPS TODAY: the whole "notify me on save" round-trip in one call. on_autocmd
// creates the augroup + autocmd whose action rpcnotify()s back at us AND
// registers the handler; `payload.file` is expand('<afile>:p'). It replaces the
// ~15-line create_autocmd + add_notify_handler dance shown previously. The
// lower-level free functions (create_autocmd(instance, events, opts),
// add_notify_handler(instance, name, fn)) are also available if you want to wire
// the two halves yourself.
const handle = await on_autocmd(instance, ["BufWritePost"], { pattern: ["*"] },
  async ({ file }) => {
    // read_file(instance, path) reads the engine FS (null if missing).
    let contents = await read_file(instance, file);
    alert(file + " has been saved: " + contents);
  });
// handle.unsubscribe();  // stop notifications + delete the augroup

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
| `build-nvim.sh` | Configure + build nvim to wasm; install the Node engine host (`worker.js`); stage + `file_packager` the three runtime variants (`nvim-{full,core,minimal}.data` + loaders). |
| `shim.h` | Force-included into every emcc compile (`EMCC_CFLAGS`); small libc gap fills (pthread thread-name stubs). |
| `uv_stubs.c` | libuv / libc functions the Emscripten builds omit (sys-info, `uv_exepath`, `sched_*`, `pthread_*_np`). Linked into nvim only for wasm. |
| `extern-pre.js` | Emscripten `--extern-pre-js` (runs before everything): under Node, points `locateFile` at nvim.js's dir so a data package resolves from any cwd. |
| `pre.js` | Emscripten `--pre-js`: argv, the postMessage-channel global, `$VIMRUNTIME`, and the environment. Node path mounts the host FS via NODEFS and points `$VIMRUNTIME` at the on-disk `runtime/` tree (no data package needed); browser path uses the runtime unpacked into MEMFS by the variant's `file_packager` loader. |
| `nvim_io.js` | Emscripten `--js-library`: async (JSPI) `__syscall_poll` and the postMessage-backed channel stream ops for the engine's fd 0/1. |
| `worker.js` | Node engine host: runs `nvim --embed` wasm in a worker_thread, fd 0/1 carried over the worker's postMessage channel (the Node analogue of `web/engine-worker.js`; used by the e2e test). |
| `web/` | Browser target, split into the layers the goals call for: `neovim.js` (headless msgpack-RPC core — a transport-agnostic instance), `neovim-ui.js` (default renderer: a headless `Screen` grid-decode + DOM `mount_into`), `app.js` (page glue that composes them), `index.html`, `engine-worker.js` (Web Worker engine host; loads the `plugins` variant's data package before `nvim.js`), `serve.js` (plain static dev server), `build-site.sh` (assemble the static bundle, all three variants), `build-lib.sh` (redistributable bundle; `--variant` selects which runtime to ship), `e2e.test.js` (headless end-to-end test over a Node worker engine). Uses `@msgpack/msgpack` (npm). |
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
  `ENVIRONMENT=node,web,worker`, `--extern-pre-js`, `--pre-js`, `--js-library`.
  The runtime is deliberately **not** `--preload-file`'d here — `nvim.wasm` is
  runtime-agnostic and the runtime is packaged out-of-band per variant by
  `build-nvim.sh` (see **Runtime bundles**).
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
- **Filesystem** — no host FS, so `$VIMRUNTIME` is unpacked into MEMFS by the
  selected runtime variant's `file_packager` data package, loaded before `nvim.js`
  (see **Runtime bundles** / the `plugins` option). `-u NONE -i NONE` by default
  (no config, no shada).
- **Testing hook** — `window.nvim.input(keys)`, `.gridText()`, `.resize(c,r)` and
  `.state()` are exposed for driving/asserting from automation or the console.

`stage3.md` records the design, what shipped, and the remaining browser follow-ups
(live resize, IDBFS for real files). The runtime size is now addressed by the
`plugins` variants (full / core / minimal — see **Runtime bundles**).

### Filesystem: MEMFS + NODEFS (not NODERAWFS)

The wasm build uses MEMFS with a NODEFS mount of the host filesystem (set up in
`pre.js`), **not** NODERAWFS. NODERAWFS routes fd I/O straight to Node fds, which
makes purely-virtual fds (the in-worker engine channel, the client's RPC fds)
impossible. With MEMFS the channel fds are first-class virtual streams backed by
the postMessage channel (`nvim_io.js`), while real files stay reachable through
the NODEFS mount. Under **Node** the runtime itself comes from that NODEFS mount:
`nvim.wasm` no longer bakes the runtime in, so `pre.js` points `$VIMRUNTIME` at the
on-disk `runtime/` tree (`../../runtime`, reachable via the `/home` mount). In the
**browser** there is no host FS, so the runtime is unpacked into MEMFS at
`/usr/share/nvim/runtime` by the selected variant's `file_packager` package
(`nvim-<variant>.data` + loader, loaded before `nvim.js`); `pre.js` skips the
NODEFS mounts — same channel ops. The data package's loader registers a
run-dependency, so the engine's `main()` waits for the unpack.

## Known limitations

- No process spawning: `:terminal`, `:!`, and `jobstart()` are unavailable;
  the relevant libuv/`uv_spawn` calls fail with `ENOSYS`.
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
