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
<canvas id="screen"></canvas>

<!-- msgpack global, the canvas grid renderer, the headless core, then the
     default renderer (grid-renderer.js must precede neovim-ui.js). -->
<script src="msgpack.min.js"></script>   <!-- @msgpack/msgpack UMD: globalThis.MessagePack -->
<script src="grid-renderer.js"></script> <!-- globalThis.GridRenderer -->
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

  // 2. Renderer: mount the default grid UI into a <canvas> and forward
  //    keystrokes. Painting goes through grid-renderer.js (a bitmap glyph
  //    cache + putImageData blits, with box-drawing/braille/legacy-computing
  //    glyphs drawn as PATHS so they connect seamlessly): it decodes the
  //    ext_linegrid highlight stream into per-cell colors (fg/bg/bold/italic/
  //    underline variants/strikethrough/reverse) with a solid cursor block.
  //    Opts: { font_family, font_size, cols, rows, default_fg, default_bg,
  //    grid_renderer } (all optional). Omit cols/rows to AUTO-SIZE the grid to
  //    the element and track its resizes (see below); pass cols/rows for a
  //    FIXED grid.
  const ui = NeovimUI.mount_into(nvim, document.getElementById('screen'), {
    font_family: 'ui-monospace, monospace',
    font_size: 16,
    // cols: 80, rows: 24,  // optional: a fixed grid (omit to auto-size)
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
| `'core'` | Boots + edits + filetype detection + indent + a **curated** syntax-highlighting slice for common languages (`autoload/`, `colors/`, `compiler/`, `keymap/`, `ftplugin/`, `indent/`, the whole `pack/`, treesitter `queries/`, and ~40 hand-picked `syntax/` languages). Drops `doc/`, `tutor/`, `spell/`, and the bulk of `syntax/`. | ~9.1 MB |
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

### Tree-sitter grammars

The **bundled** grammars (`c`, `lua`, `markdown`, `markdown_inline`, `query`,
`vim`, `vimdoc` — the same set native nvim ships as `parser/*.so`) are
**statically linked into `nvim.wasm`** and registered by name (wasm has no
default dlopen), so treesitter highlighting works out of the box: opening a
`.lua`/markdown/help file starts the highlighter exactly like a native build.
The `full` and `core` runtime bundles carry the matching highlight
`queries/`.

**Third-party grammars load dynamically.** The engine is linked as an
emscripten **main module** (`-sMAIN_MODULE=2`, everything compiled `-fPIC`),
so grammar **`.wasm` side modules — the artifact `tree-sitter build --wasm`
publishes and many grammar repos attach to releases — are dlopen'd at
runtime** through nvim's normal parser loader. Three ways in:

1. **Explicit path** — `vim.treesitter.language.add('zig', { path = '/path/zig.wasm' })`.
2. **`runtimepath` discovery** — drop `parser/zig.wasm` in any runtimepath dir
   (e.g. `~/.local/share/nvim/site/parser/`), then `language.add('zig')`.
   Under the **standalone server** those are the *IO host's* real
   directories: the engine reads the grammar off the server/remote disk
   through the proxied file IO and stages it into MEMFS for dlopen — no
   server-side support needed.
3. **Fetched at runtime (browser library)** — give `create()` a grammar
   source and the engine will `fetch()` a missing grammar on first use:

   ```js
   const nvim = Neovim.create({
     parsers: {
       baseUrl: 'https://cdn.example.com/ts',      // <baseUrl>/<lang>.wasm
       urls: { zig: 'https://example.com/zig.wasm' }, // per-lang override
     },
   });
   // later: :lua vim.treesitter.language.add('zig') -- fetches, dlopens, done
   ```

   The hook only fires after the runtimepath search fails; without a
   `parsers` config, behavior is unchanged ("No parser for language …").

Highlighting also needs the grammar's **queries** (`queries/<lang>/*.scm`) on
the runtimepath, same as native nvim — ship them next to the parser (a
`filesystem:` seed, a site dir on the server, or your plugin manager).

Caveats: grammars with **C++ scanners** cannot load (the engine exports no
libc++); a side module's unresolved libc import surfaces at **first parse**
(not at dlopen) as `TypeError: resolved is not a function` — the engine
exports the allocator + `mem*`/`str*` + ctype/wctype families that scanners
commonly use (see `EXPORTED_FUNCTIONS` in `src/nvim/CMakeLists.txt`; extend
the list if a grammar reports a missing symbol). Grammar `.wasm` files built
by very old emscripten releases may hit dylink-ABI drift.

The returned **instance** (also reachable synchronously off the facade):

| Member | Description |
|---|---|
| `request(method, params)` | Send an RPC request. Returns a `Promise` of the result. |
| `notify(method, params)` | Send an RPC notification (no response). |
| `input(keys)` | Convenience for `notify('nvim_input', [keys])`. |
| `onNotification(method, fn)` | Subscribe to a notification (e.g. `'redraw'`); `fn` gets the params array. Returns an unsubscribe fn. |
| `onStatus(fn)` | Subscribe to out-of-band transport status (`{ kind, ... }`). Returns an unsubscribe fn. |
| `onRequest(fn)` | Set a handler `fn(method, params)` for requests the engine makes of the client (without one, the client replies nil). `fn` may return a value **or a `Promise`** — the reply is sent once it resolves; a throw/rejection becomes an RPC error (so the engine's `rpcrequest` fails rather than hanging). This async seam is what the clipboard rides on (see **Clipboard** below). |
| `chan` | This client's RPC channel id. `null` until ready. |
| `ready` | A `Promise` that resolves to the instance once `nvim_get_api_info` round-trips (and `chan` is set). |
| `dispose()` | Tear down the transport / engine and reject in-flight requests. |

`NeovimUI.mount_into(instance, canvas, { font_family, font_size, cols, rows,
default_fg, default_bg, grid_renderer })` → `{ screen, renderer, resize(c, r),
dispose(), cols, rows }`. Wires the instance to a **`<canvas>`**, attaches the
UI (`nvim_ui_attach` with `ext_linegrid`), paints on flush through the
**grid-renderer** package (`wasm/grid-renderer` — a bitmap glyph cache blitted
with `putImageData`, plus box-drawing / block-element / braille / powerline /
legacy-computing glyphs drawn as **paths** so they fill cells exactly and
connect seamlessly; see `wasm/grid-renderer/README.md`), and forwards
keystrokes. `screen` is a `NeovimUI.Screen` (the headless grid model);
`renderer` is the underlying `GridRenderer`; `resize(c, r)` issues
`nvim_ui_try_resize`; `dispose()` unsubscribes from `redraw` **and**
disconnects the auto-resize observer; `cols`/`rows` are the dimensions it
attached with. `NeovimUI.Screen`, `NeovimUI.keyToNvim`, and
`NeovimUI.screenToCells` (the Screen → renderer-cell resolution) are also
exported for headless use.

Like msgpack for the core, the renderer dependency resolves at runtime: load
`grid-renderer.js` (UMD → `globalThis.GridRenderer`) before `neovim-ui.js`, or
pass the module as `opts.grid_renderer`. (The legacy `<pre>` DOM renderer
survives as a testing utility — `wasm/web/src/neovim-ui-pre-testutil.ts`, plain
CommonJS in `web/dist/`, not shipped in the bundles.) The full renderer design
— glyph atlas, the ghostty sprite port, snapshot testing, the paint scheduler —
is documented in `docs/history/stage6.md`.

All opts are optional:

| Opt | Meaning |
|---|---|
| `font_family` | CSS `font-family` for the cell font. **Must be monospace** for the grid to line up. |
| `font_size` | A number, CSS px (default 16). The canvas backing store renders at `font_size × devicePixelRatio` so HiDPI output is crisp. |
| `cols`, `rows` | **Explicit, fixed** grid size. Passing *either* disables auto-sizing (a missing one defaults to 80/24); the canvas is sized to exactly fit the grid. |
| `default_fg`, `default_bg` | Base colors for "default terminal color" cells (defaults `0xd4d4d4` / `0x000000`). |
| `grid_renderer` | The grid-renderer module (default: `globalThis.GridRenderer`). |

**Auto-size + resize tracking.** With *neither* `cols` nor `rows` given,
`mount_into` sizes the canvas backing store to the element's CSS box (×
`devicePixelRatio`), fits as many whole cells as fit, and installs a
`ResizeObserver` on the canvas. On resize it refits the backing store,
repaints, and — if the cell grid changed — issues `nvim_ui_try_resize`
(coalesced to one call per animation frame so a drag doesn't spam the engine);
the engine's `grid_resize` redraw reflows the `Screen`, so the grid follows
the element. If the canvas has no layout yet (0×0), it falls back to 80×24
rather than attaching a degenerate grid. `dispose()` disconnects the observer.
Passing explicit `cols`/`rows` keeps a fixed grid with no observer.

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

#### Clipboard (`create({ clipboard })`)

By default the wasm engine has **no clipboard tool** (no `xclip`/`pbcopy`/… in
the browser), so the `+`/`*` registers don't reach the system clipboard. The
`clipboard` option wires them to one — it is the first place the **engine calls
back into the page** (every other call is page → engine):

* when nvim yanks/copies to `+`/`*`, the engine `rpcrequest`s the client
  `clipboard_set(lines, regtype)`;
* when nvim pastes from `+`/`*`, it `rpcrequest`s `clipboard_get()` and expects
  `[lines, regtype]` back.

Both ride the async `onRequest` seam above, so the client's reply may be a
`Promise` (e.g. `navigator.clipboard.readText()`); the engine's `poll()` suspends
via JSPI while it waits, so blocking `rpcrequest` is fine.

Enabling the clipboard also sets **`clipboard=unnamedplus`**, so plain `y`/`p`/`d`
use the system clipboard directly (not just the explicit `"+`/`"*` registers) —
i.e. bare `p` pastes what you copied, which is what most users expect. Pass
`setRegister: false` to `enableClipboard` (below) if you want to wire only the
`+`/`*` registers and leave the unnamed register alone.

```js
// Built-in: back the +/* registers with the browser's system clipboard.
const nvim = await Neovim.create({ args: ['-n'], clipboard: 'browser' });

// Or supply your own provider (the escape hatch; also how it's tested headlessly):
const nvim2 = await Neovim.create({
  args: ['-n'],
  clipboard: {
    async get()            { return [['hello'], 'v']; },  // or just return 'hello'
    async set(lines, type) { /* persist lines somewhere */ },
  },
});
```

| `clipboard` value | Meaning |
|---|---|
| `'browser'` | Use a built-in provider backed by `navigator.clipboard`. It is **guarded**: if `navigator.clipboard` is absent (Node, or an insecure/non-HTTPS context) it does not throw at install — `set` warns and is a no-op, `get` rejects, so the failure surfaces as a clear console warning / RPC error, not a crash. |
| `<provider>` | A custom object `{ get(): Promise<string \| [lines, regtype]>, set(lines, regtype): Promise<void> \| void }`. `get` may return a plain string (wrapped as `[string.split('\n'), 'v']`) or a `[lines, regtype]` pair; `set` receives the yanked `lines` array and `regtype`. This is the embedder hook **and** what makes the seam testable without `navigator`. |

`create({ clipboard })` **composes** with — never clobbers — a user `onRequest`:
the install routes `clipboard_get`/`clipboard_set` to the provider first and
**delegates every other method** to whatever you pass to `nvim.onRequest(fn)`
(in either call order). Internally it sets `g:clipboard` in the engine with Lua
function entries that `rpcrequest(<chan>, 'clipboard_get'/'clipboard_set', …)`
back at the client (nvim's clipboard provider accepts funcref `copy`/`paste`
entries), and force-reloads the provider so it re-reads `g:clipboard`.

For embedders driving the lower-level `createNvim()` directly, the install is
also exported as `Neovim.enableClipboard(instance, provider[, delegateOnRequest[,
setRegister]])` (ESM: `enableClipboard`) — call it **after** `instance.ready` (it
needs `instance.chan`); it returns a Promise that resolves once `g:clipboard` is
set. `setRegister` defaults to `true` (sets `clipboard=unnamedplus`); pass `false`
to wire only the `+`/`*` registers.

> **`navigator.clipboard` caveats (browser).** Reading the clipboard
> (`readText()`, used by paste) may require a **user gesture** and the
> `clipboard-read` permission, and can be **denied** in the background — in which
> case paste from `+`/`*` yields an error to nvim. Writing (`writeText()`, used by
> copy) is generally allowed after a gesture. Both need a **secure context**
> (HTTPS or `localhost`). The headless e2e test uses the custom in-memory provider
> (Node has no `navigator`); the `'browser'` path must be smoke-tested in a real
> browser.

### The one remaining gap: cross-origin loading

Everything described under **Available today** is the whole embedding API — the
"longer-term vision" has landed. ESM `import`, `baseUrl`, the `build-lib.sh`
bundle, the awaitable `create()`, the `env` / `cwd` / `filesystem` / `plugins`
runtime config, the `neovim-utils.js` helpers, the `clipboard` option, and the
renderer's `font_family` / `font_size` + auto-resize all ship.

The **single** thing that doesn't work yet is **cross-origin** loading. `import`
from another origin is fine, but `new Worker()` (which `create()` uses, and which
`baseUrl` configures) is **same-origin only** — so `baseUrl` may be a subpath of
the page's own origin but not a different-origin CDN:

```js
// Works today: same-origin import + baseUrl.
import { create } from '/lib/neovim.mjs';
const nvim = create({ args: ['-n'], baseUrl: '/lib/' });

// Not yet: a different-origin CDN. `new Worker('https://cdn.example/…')` is
// blocked by the same-origin policy; supporting it needs a Blob-bootstrap shim
// for the worker that isn't built.
import { create } from 'https://cdn.example/neovim.mjs';   // import is fine…
// …but create({ baseUrl: 'https://cdn.example/' }) can't spawn the worker (yet).
```

The end goal — the full neovim RPC API, with embedders building extensions so
neovim communicates with the rest of the app — is reachable today; only hosting
the bundle on a third-party origin awaits the worker shim.

## As a chrome extension

Have you ever been on a webpage and wished that a textarea on the page was
neovim instead?  Now you don't have to!  With a single keybinding, you can
replace a textarea with a full vim, copying the current contents of the
textarea into a vim buffer, and write back into the textarea with `:w`.

The vim instance that the page uses is actually a long-lived extension-owned
web-worker, so startup time is minimized, and the users `vimrc` can be
configured and follow them around between sites.

## As a standalone application

> **Status: ✅ shipped (stage 4).** The standalone app is the same in-browser
> engine as the library, but the engine worker also opens a WebSocket to a small
> server that performs all real IO. Visit the page the server hosts and you get a
> full editor whose **filesystem, `:!`, `jobstart()`, `:terminal`, and LSP run on
> the server**, jailed to a configured root. See `docs/history/stage4.md` for the full design.

The most ambitious part of the project, the standalone `neovim.js` application
is a full replacement for running neovim on a remote server. With a standard
neovim setup, typing responsiveness is tied to the latency of your connection to
the machine running neovim, so if you're renting a computer half way around the
world, the experience is borderline unusable. With the standalone `neovim.js`
application you start the server on that machine and visit the page it hosts —
the entire vim engine runs **locally in your browser**, so text editing and
plugin execution are lightning fast, while filesystem access, shells, commands,
PTYs, and LSP servers are transparently proxied to the server so they run for
real on the system you care about. (Only per-IO round-trips travel the wire, and
IO is far less latency-sensitive than per-keystroke redraw.)

### Quickstart

The server is **`tvim`** — a single dependency-free Go binary (see `wasm/tvim/`).
Build the wasm engine, assemble the browser bundle, and build `tvim` with the
bundle embedded, then point it at the project you want to edit:

```sh
wasm/build-deps.sh && wasm/build-nvim.sh        # the wasm engine (once)
cd wasm/tvim
../web/build-site.sh server/site                # assemble the bundle into the embed dir
./precompress.sh server/site                    # gzip the big assets in place (optional)
go build -tags embed_assets -o tvim ./cmd/tvim  # self-contained binary (bundle baked in)
cd /path/to/project && tvim --port 8001         # the editor lands in tvim's cwd
```

`precompress.sh` gzips the large assets (`nvim.wasm`, the `nvim-*.data`
packages, the JS) in place and drops the raw originals, so the binary embeds the
**compressed** bytes and serves them with `Content-Encoding: gzip` — no
per-request compression, the binary shrinks ~47 MB → ~20 MB, and the wasm/`.data`
downloads to ~26 % of raw. It is optional: skip it and the binary embeds the raw
bundle and serves it uncompressed, exactly as before. The `AssetServer` is generic
— it prefers a `<name>.gz` sibling for gzip-capable clients, gunzips on the fly for
the rare client that can't, and serves raw (with Range support) when there is no
`.gz`. (CI runs `precompress.sh` automatically before the embed build.)

(For dev, skip the embed and serve the bundle off disk: `go build -o tvim
./cmd/tvim` then `./tvim --assets-dir <build-site output>`. The dev
`--assets-dir` path is raw build-site.sh output, so it serves uncompressed
with Range — `precompress.sh` only touches the embed copy.)

**Editing a remote host** (the three-tier mode): run `tvim` on a machine you can
reach in a browser (e.g. your laptop) and point it at the box that holds the files
over SSH — it serves the page locally and proxies all IO to
`ssh -T user@host tvim --serve-stdio` (assumes `tvim` is on the remote's `PATH`):

```sh
./tvim --remote user@host   # + --assets-dir or embedded bundle
```

Then open **`http://localhost:8001/`** in a JSPI-capable browser (Chrome ≥ 137).
The IO host's filesystem is **mounted at the editor's root** — the editor sees
the box's real paths — and you land in the server's working dir (`tvim`'s cwd
locally; the ssh login dir, i.e. the remote home, with `--remote`):

- **Files** — `:e`, `:w`, `:Explore`, globbing, `:cd` — all hit the server's real
  disk at real paths. The only exceptions are the MEMFS **overlays** shadowed on
  top: the packaged nvim runtime (`/usr/share/nvim`), `/dev` + `/proc`, and (per
  `--rc`) a local `$HOME` or seeded config.
- **Commands / jobs** — `:!make`, `:r !ls`, `system(...)`, `jobstart(...)` run as
  real child processes on the server, in the editor's cwd.
- **`:terminal`** — a real PTY on the server (via `creack/pty`); resize propagates.
- **LSP** — a language server configured as a stdio job is spawned on the server
  and "just works" (so does `vim.system` / `vim.lsp`).
- **Config** — `$USER` always reflects the host user (reported in the hello). For
  config, `--rc` picks the source:
  - **`remote`** (default with `--remote`): `$HOME` → the host's home, so
    `~/.config/nvim` *and its plugins/shada* load live through the proxy.
  - **`local`**: `$HOME` is still the host's home, but `$HOME/.config/nvim` is
    **shadowed** to the **app-server's own** `~/.config/nvim` (seeded into the
    browser, served from memory) — so you edit with *your laptop's* config while
    `~`, shada, and data still live on the host. Config dir only (no plugins).
  - **`builtin`** (default without `--remote`): nvim's defaults ($HOME stays the
    browser-local `/root`, shadowed from the server).

`--port` defaults to `8001`. The server binds `127.0.0.1` only. Visiting the
page IS the standalone app (`/proxy-config.js` is always generated).

> **You must rebuild the engine?** No. The standalone app is the *same* `nvim.wasm`
> as the library — the proxy is opt-in JS glue (`create({ proxy })`) plus the
> `tvim` server. Build the engine once; only `tvim` itself is a Go build.

> **History.** Stage 4 prototyped this server in Node (`wasm/server/*.js`); stage 5
> reimplemented it as the `tvim` Go binary (`wasm/tvim/`) — a small static binary
> with no runtime deps and easy cross-compilation — verified to behave identically
> by the conformance suite + a headless-Chrome e2e (`wasm/tvim/e2e/`). The Node
> prototype has been removed; `wasm/docs/history/stage5.md` has the design.

### How "visit the server" wires up (the opt-in)

The proxy is **additive and opt-in**: nothing connects to a server unless a
`proxy` config is present. Two layers provide it:

- **For the demo page:** when `index.html` is served by `tvim`, the server serves
  a generated `/proxy-config.js` that sets
  `window.__NVIM_PROXY = { url, nvimSocket, rc }`. The `url` is derived from
  the request's `Host` header (`ws://<same-host>/proxy`), so it works whether you
  reach the page via `localhost`, `127.0.0.1`, or a forwarded port. `app.js` reads
  that global and passes it as `create({ ..., proxy })`; the engine boots in the
  server's working dir (reported in the hello) so you land in the server's files.
  **When the page is served by the plain static dev server (`serve.js`),
  `/proxy-config.js` is a no-op, the global stays undefined, and `app.js` behaves
  exactly as the no-proxy demo** — so the static demo and the embeddable widget
  are completely unaffected.
- **For embedders:** pass the proxy config to `create()` directly:

  ```js
  const nvim = create({
    args: ['-n'],
    proxy: {
      url: 'ws://my-server:8001/proxy', // the server's /proxy WebSocket
    },
  });
  ```

  The engine worker opens the WebSocket, runs the proxy client, and mounts the
  server's filesystem at the engine's root: every non-shadowed absolute path (and
  all spawn/PTY) routes to the server, while the shadow overlays (the packaged
  runtime, `/dev`, `/proc`, and the `--rc`-dependent home/config subtrees) stay
  in the browser's MEMFS. With **no `proxy`**, the library is byte-for-byte the
  self-contained MEMFS build it has always been.

### Reconnect + durable `:terminal`

> **Status: ✅ shipped (stage 5).** Design in `docs/history/stage5.md` §6; verified by
> `wasm/web/reconnect.test.js` and `wasm/tvim/e2e/e2e_durable_term_test.go`.

The **browser engine is the only durable state.** On any transport drop, the
`ReconnectingProxy` (`wasm/proxy-reconnect.js`, wired by `web/engine-worker.js`)
**fails in-flight ops fast** — a suspended syscall returns `-EIO` rather than
hanging — then **re-dials with backoff** so the next op succeeds. There is no
transparent replay: idempotent IO (reads/writes) retries, one-shot spawns re-run.
The engine never restarts; your buffers, undo, and plugin state live in the
browser and are untouched by a blip.

The one deliberate exception is **`:terminal`**, which is long-lived stateful
session (a running shell, an `ssh`/`top` inside it, scrollback, cwd) that can't
just be "re-triggered." A per-user **session-host daemon** (`tvim --session-host`,
**auto-spawned** detached by the io-proxy — you don't run it by hand) owns the PTY
children *outside any single connection*, keyed by a stable per-tab session id.
On disconnect it **keeps the shells running** and buffers their output; on
reattach it **replays** the buffer so the terminal catches up. PTYs are reaped
only on an idle TTL or explicit kill — never on a mere disconnect. Because the
daemon lives on the IO host, terminals survive an **app-server restart** and a
**hard SSH death** while the tab is alive.

The *cold* case (the tab/engine itself gone — reload, reboot) is covered by
**`:mksession` rehydration**: the daemon **matches a restore-spawn to a
still-running PTY by (resolved cwd, argv)** and reattaches, replaying its output
ring so libvterm repaints — so `:terminal` → `:mksession` → reload → `:source`
brings the terminal back on its live shell. No persisted pid, no C/engine change,
no wasm recompile. (Limit: only as durable as the daemon's idle TTL and ring cap.)

### Security model — read before exposing it

The server is a **remote-code-execution surface by design**: `:!rm -rf`,
`:terminal`, and any `jobstart()` run real commands on the host with the server
process's privileges. The defaults reflect that:

- **Binds `127.0.0.1` only** (loopback). Exposing it to a network (e.g. via an SSH
  port-forward, the intended remote-edit path, or an explicit bind change) is an
  opt-in you take deliberately.
- **No auth token** — it is the single-user "edit my own box" tool, *not* a
  multi-tenant sandbox. Anyone who can reach the port can run commands as you. A
  shared-token handshake is a straightforward later addition; the loopback default
  is the load-bearing protection.
- **The whole filesystem of the server user is exposed** — the server's
  filesystem is mounted at the editor's root, with no jail: the editor (and
  anything it spawns) can read and write whatever the `tvim` process can, exactly
  like an ssh session as that user. The loopback bind is the boundary.

### Known gaps

- **Sockets are fully proxied — outbound *and* inbound** (the sixth + seventh
  seams): `socket.c` (`sockconnect('tcp'|'pipe', …)`, `serverstart(…)`), raw
  `vim.uv.tcp` / `vim.uv.new_pipe` connect AND `bind`/`listen`/`accept`, plus DNS,
  run on the server via wasm-only `--wrap`s of `uv_tcp_connect` / `uv_getaddrinfo`
  / `uv_pipe_connect` / `uv_pipe_connect2` / `uv_tcp_bind` / `uv_pipe_bind` /
  `uv_listen` / `uv_accept` / `uv_tcp_getsockname` (+ a narrow `uv_close` hook for
  listener teardown) — all over the same virtual-fd data path + a `net`/`dns`
  handler family. Caveats: IPv6 is carried but the proxy routes by host:port so
  the literal address is advisory; nvim's default startup `serverstart` (its
  `$NVIM` pipe) routes to the proxy and fails cleanly on the server's FS, as it did
  before. See `docs/history/stage4.md` → "TCP sockets".
- **`:terminal` input is byte-streamed** to the server PTY; multi-byte UTF-8 typed
  across separate input events is forwarded as-is and reassembled by the PTY, so
  pathological partial-codepoint splits rely on the terminal's own buffering.
- **Browser-only proxy.** The proxy WebSocket path is exercised in the browser
  demo and the Node e2e suites; the `serve.js` static demo intentionally has no
  proxy.

### The three-tier remote — `tvim` (stage 5)

> **Status: ✅ shipped.** Full design and phase plan in `docs/history/stage5.md`. The binary,
> the SSH-stdio remote, the reconnect contract, durable terminals, and `--rc` all
> ship today; what's left is the full `--site` routing table, auth/TLS for
> non-loopback binds, and the protocol `cancel` frame. Verified by the Go
> conformance suite (`wasm/tvim/conformance/`) + headless-Chrome e2e
> (`wasm/tvim/e2e/`). The `tvim --remote user@host` Quickstart above is this.

Stage 4 proxies IO to a server on **the same machine** that serves the page.
Stage 5 (`tvim`, "tunneling vim") separates those roles, because the machine holding
your files may not be internet-exposed and may have no TLS certs — so it can't
safely host the page itself. An **intermediary** (in practice your laptop on
`127.0.0.1`, or a host behind your nginx/Kerberos proxy) terminates HTTP/TLS,
serves the page, and forwards all IO to the remote over SSH:

```
   browser (wasm engine + proxy client)
        │  http + websocket
        ▼
   tvim  (app/web server, FS routing + jail)
        │  ssh stdio   (or in-process when local — no remote hop)
        ▼
   tvim --serve-stdio   (io-proxy on the remote: your files)
```

The headline pieces (see `docs/history/stage5.md`):

- **One Go binary, three modes** — app/web server, `--serve-stdio` remote
  io-proxy, and the local case (io-proxy in-process). Go because the goal is a
  *small static binary with no runtime dependency and easy cross-compilation* —
  exactly Node's weak spots. The same stage-4 frame protocol rides every
  transport (WebSocket / SSH stdio / in-process), gaining a `version` field and a
  `cancel` frame.
- **`tvim` / `tvim --remote user@host`** — SSH stdio is the remote transport
  (ssh handles encryption + auth; the remote io-proxy binds no ports). `--rc`
  (`remote`|`local`|`builtin`) picks where the in-browser nvim's config / `$HOME`
  comes from (see the Quickstart's three-tier section); the full `--site` runtime
  routing table is the remaining piece.
- **Reconnect contract** — *the browser engine is the only durable state; on any
  disconnect, in-flight ops fail fast (`-EIO`, never hang), live handles tear
  down, then the transport reconnects so the next op succeeds.* No transparent
  replay. (Spike confirmed the engine-side `-EIO` rejection arm already exists.)
- **Auth** — `127.0.0.1` by default (covers nginx-on-loopback); binding wider
  requires a token + TLS.
- **Testing** — Go unit tests on the io-proxy library, a language-neutral
  protocol conformance suite (originally validated against the stage-4 Node
  reference, since removed; now the Go server's in-process contract test), and
  `chromedp`-driven headless-browser e2e including fault injection.

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
> engine path. `docs/history/stage2.md` records it for history.

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
| **Browser: engine in a Web Worker + pure-JS grid UI** | ✅ (stage 3 — see `docs/history/stage3.md`, `wasm/web/`) |
| Headless end-to-end test (engine in a Node worker) | ✅ (`wasm/web/e2e.test.js`) |
| `:terminal`, `:!cmd`, jobs (process spawning) | ❌ stubbed in the standalone *library* (no spawn in wasm) · ✅ under the **standalone server** (proxied to the host — stage 4) |
| **Standalone app: real FS / processes / PTY / LSP proxied to a server** | ✅ (the `tvim` Go server — `wasm/tvim/`; see `docs/history/stage5.md`) |
| **Three-tier remote (`tvim --remote user@host` over SSH stdio)** | ✅ (stage 5 — `wasm/tvim/`; see `docs/history/stage5.md`) |
| **Reconnect (fail-fast `-EIO` + auto re-dial) + durable `:terminal`** | ✅ (the session-host daemon + `:mksession` rehydrate — `wasm/proxy-reconnect.js`, `wasm/tvim/server/sessionhost.go`) |

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
`ext_linegrid` grid into a `<pre>` (since replaced by the canvas grid renderer)
with a small msgpack-RPC client on the main
thread — **no wasm and no JSPI on the page**, only in the Worker. Click the grid
and type. See `docs/history/stage3.md` for the design and `wasm/web/` for the code.

### Deploy to a static host (GitHub Pages)

The site is fully static — no backend. Because the transport is postMessage (not
`SharedArrayBuffer`), the page needs **no COOP/COEP headers and no cross-origin
isolation**, so it works on any static host, including GitHub Pages, with nothing
special to configure.

```sh
wasm/web/build-site.sh _site   # gather the flat, relative-path bundle into _site/
```

`.github/workflows/deploy-wasm-pages.yml` does this automatically on every push to
`wasm-build`. The expensive wasm compile + site assembly is factored into a shared
composite action (`.github/actions/build-wasm`) and runs **once** in a `build` job;
its assembled site then fans out to two downstream jobs: `deploy` (uploads it to
Pages) and `build-tvim` (cross-compiles the `tvim` Go server — see "As a standalone
application" — for linux/darwin amd64+arm64 with that bundle baked in via
`-tags embed_assets`, and uploads each binary as a `tvim-<os>-<arch>` artifact).
Enable Pages once under **Settings → Pages → Source: GitHub Actions**. (Windows is
not built: the server uses Unix-only syscalls.)

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
| `build-nvim.sh` | Configure + build nvim to wasm; install the Node engine host (`worker.js`); stage + `file_packager` the three runtime variants (`nvim-{full,core,minimal}.data` + loaders). Generates the help-tag database (`doc/tags`, via `node nvim.js … :helptags`) for the `full` variant — the native build does this at install time, but the wasm build packages `runtime/` directly and `runtime/doc/tags` is gitignored, so without this a fresh checkout would ship docs with no tags and `:help <topic>` would fail (E149). |
| `shim.h` | Force-included into every emcc compile (`EMCC_CFLAGS`); small libc gap fills (pthread thread-name stubs). |
| `uv_stubs.c` | libuv / libc functions the Emscripten builds omit (sys-info, `uv_exepath`, `sched_*`, `pthread_*_np`). Linked into nvim only for wasm. |
| `extern-pre.js` | Emscripten `--extern-pre-js` (runs before everything): under Node, points `locateFile` at nvim.js's dir so a data package resolves from any cwd. |
| `pre.js` | Emscripten `--pre-js`: argv, the postMessage-channel global, `$VIMRUNTIME`, and the environment. Node path mounts the host FS via NODEFS and points `$VIMRUNTIME` at the on-disk `runtime/` tree (no data package needed); browser path uses the runtime unpacked into MEMFS by the variant's `file_packager` loader. |
| `nvim_io.js` | Emscripten `--js-library`: async (JSPI) `__syscall_poll` and the postMessage-backed channel stream ops for the engine's fd 0/1. |
| `nvim_fs_proxy.js` | Emscripten `--js-library` (stage 4, opt-in): the async filesystem-syscall overrides scoped to the proxy mount prefix (`open`/`read`/`write`/`stat`/`getdents`/`close` → server). No proxy ⇒ every path falls through to MEMFS synchronously. |
| `nvim_proc_proxy.js` | Emscripten `--js-library` (stage 4, opt-in): the `proc_spawn` / `pty_proc_spawn` proxy backend — virtual pollable fds for child stdio, the `--wrap=uv_spawn` path for `vim.system`, and the PTY resize control. Active only when a proxy is configured. |
| `nvim_sock_proxy.js` | Emscripten `--js-library` (stage 4, opt-in): the full socket + DNS proxy backend — outbound connect (a virtual bidirectional pollable fd backing each `uv_tcp_t`/`uv_pipe_t`; the `--wrap=uv_tcp_connect`/`uv_pipe_connect` paths) AND inbound listen/accept (the listener table + `sock.listen`/`accept`/`incoming` routing; the `--wrap=uv_listen`/`uv_accept` paths), plus `sock.connect{host,port}|{path}`/`write`/`close`/`getaddrinfo` and the server pushes. Pairs with the socket wraps in `uv_stubs.c`. Active only when a proxy is configured. |
| `proxy-client.js` | Stage 4 proxy **client** + frame codec, shared by the engine worker (browser/Node) and the server. Defines the framed protocol (`hello`/`req`/`res`/`push` + binary trailer) and `createProxyClient(transport)`. The worker `importScripts` it next to `nvim.js` when `create({ proxy })` is used. |
| `proxy-reconnect.js` | Stage 5 **ReconnectingProxy** (opt-in): a stable facade at `self.__nvimProxy` that delegates `request` to the live client (fast-rejecting during an outage so suspended syscalls return `-EIO`, never hang), `close()`s the dead client on drop, preserves the push router across reconnects, and re-dials with backoff. Wired by `web/engine-worker.js`. |
| `tvim/` | Stage 5 **`tvim` Go server** — the native, dependency-free reimplementation of the stage-4 Node IO-proxy server (since removed). `server/` (HTTP + `/proxy` WS + the FS/proc/PTY/socket handler families; the server's filesystem is exposed whole, mounted at the editor's root), `cmd/tvim` (the binary; `--port`/`--assets-dir`/`--remote`/`--rc`, `-tags embed_assets` to bake in the bundle), `proxy/` (the wire codec), `conformance/` (in-process protocol contract suite), `e2e/` (headless-Chrome integration test — a separate module). See `tvim/README.md` and `docs/history/stage5.md`. |
| `worker.js` | Node engine host: runs `nvim --embed` wasm in a worker_thread, fd 0/1 carried over the worker's postMessage channel (the Node analogue of `web/engine-worker.js`; used by the e2e test). |
| `web/` | Browser target, split into the layers the goals call for: `neovim.js` (headless msgpack-RPC core — a transport-agnostic instance), `neovim-ui.js` (default renderer: a headless `Screen` grid-decode + canvas `mount_into` painting through `grid-renderer.js`; the legacy `<pre>` renderer lives on as the `neovim-ui-pre-testutil.js` test utility), `app.js` (page glue that composes them), `index.html`, `engine-worker.js` (Web Worker engine host; loads the `plugins` variant's data package before `nvim.js`, and wires the ReconnectingProxy when a `proxy` is configured), `serve.js` (plain static dev server), `build-site.sh` (assemble the static bundle, all three variants), `build-lib.sh` (redistributable bundle; `--variant` selects which runtime to ship), `e2e.test.js` (headless engine test over a Node worker), and `reconnect.test.js` (the ReconnectingProxy facade against a mock server). `app.js` opts into `create({ proxy })` when `window.__NVIM_PROXY` is present (set by tvim's generated `/proxy-config.js`); absent, it's the no-proxy demo. Uses `@msgpack/msgpack` + `ws` (npm). |
| `docs/history/stage1.md` / `docs/history/stage2.md` / `docs/history/stage3.md` | History: stage 1 (cross-compile), stage 2 (interactive TUI — since removed), stage 3 (browser grid UI). |

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
   │ redraw → grid → <canvas>    ◀─┼─────────────┤ editor + ext_linegrid    │
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
  3. paints that grid onto a `<canvas>` **in colour** through the grid-renderer
     package — it decodes the highlight stream (`default_colors_set`,
     `hl_attr_define`, per-cell hl ids) into per-cell colors
     (fg/bg/bold/italic/underline variants/strikethrough/reverse), rasterizes
     each distinct cell once into a cached bitmap, blits with `putImageData`,
     and draws box-drawing/braille/legacy-computing glyphs as paths.
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

`docs/history/stage3.md` records the design, what shipped, and the remaining browser follow-ups
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

- No process spawning **in the standalone library** (no proxy): `:terminal`,
  `:!`, and `jobstart()` are unavailable; the relevant libuv/`uv_spawn` calls fail
  with `ENOSYS`. **Under the standalone server** (stage 4 — see "As a standalone
  application") these are proxied to the host and work for real.
- Sockets are fully proxied under the standalone server — outbound (raw
  `vim.uv.tcp`/`new_pipe` connect, `sockconnect('tcp'|'pipe', …)`, DNS) AND inbound
  (`serverstart(…)`, luv `bind`/`listen`/`accept`) — via wasm-only `--wrap`s of the
  libuv connect/bind/listen/accept/getsockname calls. See the stage-4 **Known
  gaps** for the remaining caveats (IPv6 shape, the default startup serverstart).
- File watching (`uv_fs_event_*`) reports `ENOSYS` (degrades gracefully).
- System info (`uv_cpu_info`, memory, load average) returns benign constants.
