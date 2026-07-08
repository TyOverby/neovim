# chrome-ext/ — edit any `<textarea>` in Neovim

A Chrome (MV3) extension that temporarily replaces a focused `<textarea>` on
any page with the WebAssembly Neovim editor from this repo.

**Use it:** focus a textarea, press **Ctrl+Shift+.** (a Chrome extension
shortcut — rebind it at chrome://extensions/shortcuts; clicking the toolbar
icon works too) — a Neovim canvas overlays
the textarea with its content loaded into the buffer. `:w` writes the buffer
back into the textarea (dispatching `input`/`change` through the native value
setter, so React-style frameworks notice). `:wq` / `ZZ` writes and closes the
overlay; plain `:q` closes and DISCARDS unwritten changes (no "no write since
last change" nag — the real content lives in the textarea). Focus returns to
the textarea.

The overlay matches the textarea's size exactly and follows it if the page
resizes it. If the textarea is resizable (CSS `resize`), the overlay grows the
same native resize handle — dragging it resizes the underlying textarea in
lockstep, and the grid reflows live.

Configuration persists: the engine's `~/.config/nvim` is stored by the
extension (IndexedDB in the extension origin), seeded into every future
session, and captured on every write -- `:e $MYVIMRC`, edit, `:w`, and the
next session (including after a browser restart) inherits it. Deleting
`init.vim` (`:call delete($MYVIMRC)`) restores the stock configuration --
the defaults above (display-line navigation, minimal chrome) all live in the
seeded default `init.vim`, so they are user-overridable.

The editor is themed from the textarea: its computed text color and effective
background (resolved through transparent ancestors) become nvim's `Normal`
fg/bg, and the `'background'` option is set light/dark by luminance so the
rest of the colorscheme harmonizes. The textarea's padding, border (incl.
radius), and font (family + size) are replicated too, the statusline, command
line, and end-of-buffer tildes are hidden (`laststatus=0`, `cmdheight=0`,
`fillchars+=eob:\ ` — the cmdline pops up over the last row while typing a
`:` command), and the UI attaches only after the theme is applied (no flash
of nvim's default dark colorscheme), so the overlay reads as "the textarea,
but nvim".

```sh
wasm/build-deps.sh && wasm/build-nvim.sh     # the engine (once)
wasm/chrome-ext/build-ext.sh                 # assembles _ext/
# chrome://extensions -> Developer mode -> Load unpacked -> wasm/chrome-ext/_ext
```

`NVIM_EXT_VARIANT=full|core|minimal` (default `core`) picks the runtime bundle
baked into the extension.

## Architecture

Everything heavy is the existing library stack, unmodified: `neovim.js`
(msgpack-RPC core), `neovim-ui.js` + `grid-renderer.js` (canvas UI), and
`engine-worker.js` hosting `nvim --embed` (wasm, JSPI) in a Web Worker. The
extension contributes plumbing:

```
user gesture                         extension
┌─────────────────────────┐   ┌──────────────────────────────────────┐
│ Ctrl+Shift+. (a chrome.  │   │ background.js (MV3 service worker):  │
│ commands shortcut) or    ├──►│ ensures the offscreen document,      │
│ the toolbar action --    │   │ probes frames for the focused        │
│ grants activeTab         │   │ textarea, injects the overlay stack  │
├─────────────────────────┤   ├──────────────────────────────────────┤
│ overlay.js + libs        │   │ offscreen.html/js (persistent):      │
│ (injected on demand):    │   │ hosts the engine Web Workers, keeps  │
│ canvas over the textarea,│◄──┤ ONE PRE-WARMED engine; bridges each  │
│ createNvim + mount_into  │Port│ session's Port <-> its worker       │
└─────────────────────────┘   └──────────────────────────────────────┘
```

Design decisions, and why:

* **activeTab, not host permissions.** The extension declares no host
  permissions and injects no content scripts: it cannot read or touch any
  page until the user invokes it, and then only THAT tab. Both activation
  gestures (the `chrome.commands` shortcut and the toolbar action) grant
  `activeTab`, which is all `chrome.scripting.executeScript` needs. The
  trade-offs: textareas inside cross-origin iframes are out of reach
  (activeTab covers frames the extension can see, not foreign origins), and
  the shortcut is browser-global rather than an in-page listener.
* **The engine workers live in an offscreen document.** MV3 service workers
  are ephemeral (killed after ~30s idle) and cannot spawn `Worker`s; a
  `chrome.offscreen` document is the extension's one persistent context that
  can. `background.js` creates it on install/startup and it stays up.
* **RPC bytes ride a `chrome.runtime` Port, base64-encoded.** Extension
  message passing is JSON-only (an ArrayBuffer silently serializes to `{}`),
  and content scripts can't share memory or transfer ports across the
  extension boundary. The port is adapted into the library's `Transport`
  interface (`overlay.ts`), so `createNvim`/`mount_into` run unchanged in the
  content-script world.
* **"Long-lived" is a warm pool, not one immortal process.** `:q`/`:wq`
  *exits* an `--embed` nvim — quit IS the session-end signal, and fighting
  that (command remaps, quit interception) is fragile. Instead the offscreen
  host always keeps one engine booted ahead of time: a session claims it and a
  replacement starts booting immediately. The trigger always hits a hot engine
  (measured ~100ms to a ready buffer, vs ~2s for a cold boot), which is what
  the long-lived-worker requirement is for — and one-engine-per-session also
  gives concurrent sessions (several textareas, several tabs) for free, where
  a genuinely shared engine would hit msgpack msgid collisions and nvim's
  one-UI-per-channel limit.
* **Config persistence is FS-level interception.** The engine worker wrapper
  (`ext-engine-worker.ts`) installs a `Module.preRun` hook that wraps the
  Emscripten `FS` ops (open/close/unlink/rename; needs `FS` in the engine's
  `EXPORTED_RUNTIME_METHODS`): every write or delete under `~/.config/nvim`
  -- `:w`, `writefile()`, `delete()` -- is reported to the offscreen host,
  which persists it in IndexedDB (offscreen documents can't use
  `chrome.storage`) and seeds the stored tree into each new engine via the
  init message's `filesystem` (materialized in MEMFS before `main()`). A
  config change discards the pre-warmed engine so the next session inherits
  it; boot-time seed echoes are deduplicated by content.
* **Write-back is an autocmd, not scraping.** Session setup marks the buffer
  `buftype=acwrite` with a `BufWriteCmd` that `rpcnotify`s the full buffer to
  the overlay; `:w` and the write half of `:wq`/`:x` both land there. Engine
  exit (or a dropped port — tab navigation, crash) tears the session down.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. `wasm-unsafe-eval` CSP for extension pages; `minimum_chrome_version: 137` (JSPI on by default). |
| `src/background.ts` | Service worker: offscreen-document lifecycle, the activation path (frame probe + on-demand injection via `chrome.scripting`), command/action listeners. |
| `src/trigger.ts` | In-page keybinding trigger, NOT in the production manifest: the e2e patches it in as a content script because synthesized key events cannot fire browser-level command shortcuts. |
| `src/offscreen.ts` | Engine host: warm pool, Port↔worker bridging, the persistent config store (IndexedDB) + default `init.vim`. |
| `src/ext-engine-worker.ts` | Engine worker entry: config-persistence FS hooks around the stock `engine-worker.js`. |
| `src/overlay.ts` | The session: overlay DOM, Port `Transport`, buffer load, `BufWriteCmd` write-back, teardown. |
| `src/ext-common.ts` | base64 helpers + the Port protocol constants (`globalThis.NvimExt`). |
| `src/chrome-api.d.ts` | Minimal ambient chrome.* typings (no `@types/chrome` dependency). |
| `build-ext.sh` | Compiles the TS (two `tsc` passes, like `wasm/web`) and assembles the unpacked extension into `_ext/`. |
| `e2e/` | Separate Go module: headless-Chrome e2e (chromedp) driving the real extension end to end. |

## Tests

```sh
wasm/chrome-ext/build-ext.sh
cd wasm/chrome-ext/e2e && go test -v      # skips without Chrome or _ext/
```

The e2e loads the unpacked extension via the CDP `Extensions.loadUnpacked`
command with `--enable-unsafe-extension-debugging` — branded Google Chrome
≥ 137 removed the `--load-extension` flag (still passed, for Chromium builds).
It runs against a manifest-PATCHED copy of `_ext/` (adding `trigger.js` as a
content script + host permissions): synthesized key events reach the renderer
but not the browser's accelerator layer, so the production activation (the
`chrome.commands` shortcut) cannot fire headlessly; the patched trigger sends
the same message and exercises the same service-worker `activate()` path.
It drives the full flow with trusted synthesized input: trigger chord, edit,
`:w` live write-back (asserting the page saw `input` events), `:wq` teardown +
focus restore, then a second session (asserting the pre-warmed engine attaches
fast) closed with `:q!` (asserting no write-back).

## Caveats / future work

* **Page capture-phase key listeners** registered above the canvas still see
  keystrokes before us (platform limit); bubble-phase page hotkeys are
  stopped at the canvas.
* **Config persists, but there's no network or shell** — `~/.config/nvim` is
  durable (hand-written config, small colorschemes/plugins pasted as files
  under it load fine), but plugin managers that shell out or fetch can't run.
* Textareas inside cross-origin iframes are not reachable (the price of the
  activeTab-only permission model); same-origin iframes work, with the
  overlay confined to that iframe's viewport.
* `<input type="text">` and `contenteditable` are not handled (textareas only).
* Session state (registers, `:` history) does not persist across sessions —
  each session is a fresh engine. The system clipboard (`"+`, and
  `unnamedplus` by default) is wired to `navigator.clipboard` and does carry
  across.
