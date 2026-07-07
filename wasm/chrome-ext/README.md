# chrome-ext/ — edit any `<textarea>` in Neovim

A Chrome (MV3) extension that temporarily replaces a focused `<textarea>` on
any page with the WebAssembly Neovim editor from this repo.

**Use it:** focus a textarea, press **Ctrl+Shift+.** — a Neovim canvas overlays
the textarea with its content loaded into the buffer. `:w` writes the buffer
back into the textarea (dispatching `input`/`change` through the native value
setter, so React-style frameworks notice). `:wq` / `ZZ` writes and closes the
overlay; `:q!` closes without writing. Focus returns to the textarea.

The overlay matches the textarea's size exactly and follows it if the page
resizes it. If the textarea is resizable (CSS `resize`), the overlay grows the
same native resize handle — dragging it resizes the underlying textarea in
lockstep, and the grid reflows live.

The editor is themed from the textarea: its computed text color and effective
background (resolved through transparent ancestors) become nvim's `Normal`
fg/bg, and the `'background'` option is set light/dark by luminance so the
rest of the colorscheme harmonizes.

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
page (content-script world)          extension
┌─────────────────────────┐   ┌──────────────────────────────────────┐
│ trigger.js  (~1KB, every │   │ background.js (MV3 service worker):  │
│ page): Ctrl+Shift+. on a ├──►│ ensures the offscreen document +     │
│ textarea -> activate     │   │ injects the overlay stack on demand  │
├─────────────────────────┤   ├──────────────────────────────────────┤
│ overlay.js + libs        │   │ offscreen.html/js (persistent):      │
│ (injected on demand):    │   │ hosts the engine Web Workers, keeps  │
│ canvas over the textarea,│◄──┤ ONE PRE-WARMED engine; bridges each  │
│ createNvim + mount_into  │Port│ session's Port <-> its worker       │
└─────────────────────────┘   └──────────────────────────────────────┘
```

Design decisions, and why:

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
* **Write-back is an autocmd, not scraping.** Session setup marks the buffer
  `buftype=acwrite` with a `BufWriteCmd` that `rpcnotify`s the full buffer to
  the overlay; `:w` and the write half of `:wq`/`:x` both land there. Engine
  exit (or a dropped port — tab navigation, crash) tears the session down.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. `wasm-unsafe-eval` CSP for extension pages; `minimum_chrome_version: 137` (JSPI on by default). |
| `src/trigger.ts` | Always-injected content script: the keybinding listener, nothing else. |
| `src/background.ts` | Service worker: offscreen-document lifecycle + on-demand injection of the overlay stack (`chrome.scripting`). |
| `src/offscreen.ts` | Engine host: warm pool, Port↔worker bridging. |
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
It drives the full flow with trusted synthesized input: trigger chord, edit,
`:w` live write-back (asserting the page saw `input` events), `:wq` teardown +
focus restore, then a second session (asserting the pre-warmed engine attaches
fast) closed with `:q!` (asserting no write-back).

## Caveats / future work

* **Keybinding is fixed** (Ctrl+Shift+., matched on `KeyboardEvent.code ==
  'Period'`). An options page could make it configurable.
* **Page capture-phase key listeners** registered above the canvas still see
  keystrokes before us (platform limit); bubble-phase page hotkeys are
  stopped at the canvas.
* **No per-user config/plugins** — the engine boots `-n` with the bundled
  runtime variant only.
* Textareas inside cross-origin iframes work (the trigger runs `all_frames`),
  but the overlay is confined to that iframe's viewport.
* `<input type="text">` and `contenteditable` are not handled (textareas only).
* Session state (registers, `:` history) does not persist across sessions —
  each session is a fresh engine. The system clipboard (`"+`, and
  `unnamedplus` by default) is wired to `navigator.clipboard` and does carry
  across.
