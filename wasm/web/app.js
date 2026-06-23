// wasm/web/app.js - page wiring for the browser demo.
//
// This is the thin glue an embedder would write: it composes the two library
// layers -- the headless core (neovim.js) and the default renderer
// (neovim-ui.js) -- into the page. All the reusable logic lives in those two
// modules; this file only knows about *this* page's DOM and status line.
'use strict';

(function () {
  var COLS = 80, ROWS = 24;
  var statusEl = document.getElementById('status');
  var screenEl = document.getElementById('screen');
  function setStatus(s) { if (statusEl) { statusEl.textContent = s; } }

  setStatus('starting engine worker…');

  // 1. Core: boot `nvim --embed` in a Web Worker and speak msgpack-RPC to it.
  var nvim = Neovim.create({ args: ['-u', 'NONE', '-i', 'NONE'] });

  nvim.onStatus(function (s) {
    if (!s) { return; }
    if (s.kind === 'booting') { setStatus('engine booting (loading wasm + runtime)…'); }
    else if (s.kind === 'stdout' || s.kind === 'stderr') { console.log('[engine ' + s.kind + ']', s.text); }
    else if (s.kind === 'exit') { setStatus('engine exited'); }
    else if (s.kind === 'error') { console.error('engine error', s.error); setStatus('engine error: ' + s.error); }
  });

  // 2. Renderer: mount a default grid UI into the <pre> and forward keystrokes.
  var ui = NeovimUI.mount_into(nvim, screenEl, { cols: COLS, rows: ROWS });

  nvim.ready
    .then(function () { setStatus('attached — click the grid and type (chan ' + nvim.chan + ')'); })
    .catch(function (err) { setStatus('failed to start: ' + (err && err.message || err)); });

  // 3. Expose a tiny API for debugging / automated testing (unchanged surface).
  window.nvim = {
    input: function (keys) { return nvim.input(keys); },
    request: function (method, params) { return nvim.request(method, params); },
    resize: function (c, r) { return ui.resize(c, r); },
    gridText: function () { return ui.screen.text(); },
    cursor: ui.screen.cursor,
    state: function () { return { cols: ui.screen.cols, rows: ui.screen.rows, cursor: ui.screen.cursor }; },
  };
})();
