// wasm/web/src/app.ts - page wiring for the browser demo.
//
// This is the thin glue an embedder would write: it composes the two library
// layers -- the headless core (neovim.js) and the default canvas renderer
// (neovim-ui.js + grid-renderer.js) -- into the page. All the reusable logic
// lives in those modules; this file only knows about *this* page's DOM and
// status line.
//
// Loaded as a classic <script> after neovim.js / neovim-ui.js set their globals,
// so it reads `Neovim` / `NeovimUI` off the global scope (declared below).

// The library globals set by the UMD <script> bundles loaded before us, plus
// the page's window hooks. Kept loose: this file is page glue, not library API.
declare const Neovim: any;
declare const NeovimUI: any;

(function () {
  const win = window as any;
  const toastsEl = document.getElementById('toasts');
  const screenEl = document.getElementById('screen') as HTMLCanvasElement;

  // Status updates surface as toast notifications: a message slides into the
  // bottom-right corner and fades out on its own. Consecutive duplicates are
  // skipped (refreshStatus may recompute the same line), and errors get a
  // distinct style + a longer dwell. CSS for .toast lives in index.html.
  let lastToast = '';
  function setStatus(s: string, opts?: { error?: boolean }) {
    if (!s) { return; }
    // Mirror the latest status onto <body data-status> — toasts are transient
    // (they remove themselves), so this is the persistent, machine-readable
    // signal automated tests can poll for boot state.
    document.body.setAttribute('data-status', s);
    if (!toastsEl || s === lastToast) { return; }
    lastToast = s;
    const el = document.createElement('div');
    el.className = 'toast' + (opts && opts.error ? ' error' : '');
    el.textContent = s;
    toastsEl.appendChild(el);
    // Force a reflow, then add .show so the CSS transition runs (fade/slide in).
    // A forced reflow (reading offsetWidth) is used rather than requestAnimationFrame
    // because rAF is throttled to never in a backgrounded tab, which would leave the
    // toast stuck at opacity:0.
    void el.offsetWidth;
    el.classList.add('show');
    const dwell = opts && opts.error ? 8000 : 4000;
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 250);   // after the fade-out transition
    }, dwell);
  }

  setStatus('starting engine worker…');

  // 1. Core: boot `nvim --embed` in a Web Worker and speak msgpack-RPC to it.
  //    -n: no swap files. clipboard: 'browser' wires the +/* registers (and,
  //    via unnamedplus, plain y/p/d) to the system clipboard through
  //    navigator.clipboard. Pasting may prompt for clipboard-read permission
  //    the first time; needs a secure context (HTTPS or localhost).
  const nvim = Neovim.create({ args: [ '-n' ], clipboard: 'browser' });

  nvim.onStatus(function (s: any) {
    if (!s) { return; }
    if (s.kind === 'booting') { setStatus('engine booting (loading wasm + runtime)…'); }
    else if (s.kind === 'stdout' || s.kind === 'stderr') {
      console.log('[engine ' + s.kind + ']', s.text);
    }
    else if (s.kind === 'exit') { setStatus('engine exited'); }
    else if (s.kind === 'error') { console.error('engine error', s.error); setStatus('engine error: ' + s.error, { error: true }); }
  });

  // 2. Renderer: mount the canvas grid UI into the <canvas> and forward
  //    keystrokes. No fixed cols/rows -> mount_into auto-sizes the grid to
  //    fill #screen (backing store = CSS box x devicePixelRatio) and tracks
  //    its size (resize the window to reflow). Cells are painted through
  //    grid-renderer.js: a bitmap glyph cache + path-drawn box-drawing /
  //    legacy-computing glyphs (see wasm/grid-renderer).
  const ui = NeovimUI.mount_into(nvim, screenEl, {
    font_family: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace',
    font_size: 16,
  });

  nvim.ready
    .then(function () {
      setStatus('attached — click the grid and type (chan ' + nvim.chan + ')');
    })
    .catch(function (err: any) { setStatus('failed to start: ' + (err && err.message || err), { error: true }); });

  // 3. Expose a tiny API for debugging / automated testing (unchanged surface).
  win.nvim = {
    input: function (keys: string) { return nvim.input(keys); },
    request: function (method: string, params: any[]) { return nvim.request(method, params); },
    resize: function (c: number, r: number) { return ui.resize(c, r); },
    gridText: function () { return ui.screen.text(); },
    cursor: ui.screen.cursor,
    state: function () { return { cols: ui.screen.cols, rows: ui.screen.rows, cursor: ui.screen.cursor }; },
  };
})();
