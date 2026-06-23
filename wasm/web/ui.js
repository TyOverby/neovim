// wasm/web/ui.js - Browser UI client for Neovim (main thread, pure JS).
//
// The "custom UI in JavaScript" half of the browser port. It runs on the page's
// main thread and speaks msgpack-RPC to the engine wasm in engine-worker.js over
// plain postMessage. There is NO wasm, NO JSPI, and NO SharedArrayBuffer on this
// side, so the page does not need to be cross-origin isolated -- it works on any
// static host.
//
//   page (this file)                         Worker (engine-worker.js)
//   ┌───────────────────────────┐  postMessage ┌────────────────────────┐
//   │ keydown -> nvim_input  ────┼────────────▶│ nvim --embed (wasm)    │
//   │ <pre> grid  ◀── redraw ────┼─────────────┤ editor + linegrid UI   │
//   └───────────────────────────┘             └────────────────────────┘
//
// We attach with ext_linegrid and render the single global grid (grid 1) as a
// plain monospace character grid into a <pre>, with no fg/bg colouring (only a
// cursor outline). The command line and messages are drawn by Neovim into the
// bottom rows of that same grid (we don't request ext_cmdline/ext_messages), so
// `:w`, `:q`, etc. are visible.
'use strict';

(function () {
  var COLS = 80, ROWS = 24;

  var statusEl = document.getElementById('status');
  var preEl = document.getElementById('screen');
  function setStatus(s) { if (statusEl) { statusEl.textContent = s; } }

  // ---- grid model ---------------------------------------------------------
  var cols = COLS, rows = ROWS;
  var grid = makeGrid(cols, rows);
  var cursor = { row: 0, col: 0 };

  function makeGrid(c, r) {
    var g = new Array(r);
    for (var y = 0; y < r; y++) {
      g[y] = new Array(c);
      for (var x = 0; x < c; x++) { g[y][x] = ' '; }
    }
    return g;
  }
  function clearGrid() {
    for (var y = 0; y < rows; y++) { for (var x = 0; x < cols; x++) { grid[y][x] = ' '; } }
  }

  // ---- redraw event handlers ---------------------------------------------
  var handlers = {
    grid_resize: function (a) { cols = a[1]; rows = a[2]; grid = makeGrid(cols, rows); },
    grid_clear: function () { clearGrid(); },
    grid_cursor_goto: function (a) { cursor.row = a[1]; cursor.col = a[2]; },
    grid_line: function (a) {
      // [grid, row, col_start, cells, wrap]; cells: [[text, hl_id?, repeat?], ...]
      var row = a[1], col = a[2], cells = a[3];
      var line = grid[row];
      if (!line) { return; }
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var text = cell[0];
        var repeat = cell.length >= 3 ? cell[2] : 1;
        for (var k = 0; k < repeat; k++) {
          if (col < cols) { line[col++] = text; }
        }
      }
    },
    grid_scroll: function (a) {
      // [grid, top, bot, left, right, rows, cols]
      var top = a[1], bot = a[2], left = a[3], right = a[4], dr = a[5];
      if (dr > 0) {
        for (var y = top; y < bot - dr; y++) {
          for (var x = left; x < right; x++) { grid[y][x] = grid[y + dr][x]; }
        }
      } else if (dr < 0) {
        for (var y2 = bot - 1; y2 >= top - dr; y2--) {
          for (var x2 = left; x2 < right; x2++) { grid[y2][x2] = grid[y2 + dr][x2]; }
        }
      }
    },
    flush: function () { render(); },
  };

  function handleRedraw(batches) {
    for (var i = 0; i < batches.length; i++) {
      var batch = batches[i];
      var fn = handlers[batch[0]];
      if (!fn) { continue; }              // ignore hl/mode/msg/etc. events
      for (var j = 1; j < batch.length; j++) { fn(batch[j]); }
    }
  }

  // ---- renderer -----------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function render() {
    var out = [];
    for (var r = 0; r < rows; r++) {
      var line = grid[r];
      if (r === cursor.row && cursor.col < cols) {
        var before = escapeHtml(line.slice(0, cursor.col).join(''));
        var at = escapeHtml(line[cursor.col] || ' ');
        var after = escapeHtml(line.slice(cursor.col + 1).join(''));
        out.push(before + '<span class="cursor">' + (at || ' ') + '</span>' + after);
      } else {
        out.push(escapeHtml(line.join('')));
      }
    }
    preEl.innerHTML = out.join('\n');
  }

  // ---- RPC transport (postMessage) ---------------------------------------
  var worker = new Worker('engine-worker.js');
  var nextMsgId = 1;
  var pending = {};   // msgid -> {resolve, reject}

  function send(value) {
    // Standalone copy so we can transfer the buffer (zero-copy structured clone).
    var ab = MessagePack.encode(value).slice().buffer;
    worker.postMessage(ab, [ab]);
  }
  function request(method, params) {
    var id = nextMsgId++;
    var p = new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
    send([0, id, method, params]);
    return p;
  }
  function notify(method, params) { send([2, method, params]); }

  function onMessage(msg) {
    if (!Array.isArray(msg)) { return; }
    var type = msg[0];
    if (type === 1) {                       // response: [1, msgid, error, result]
      var h = pending[msg[1]];
      if (h) { delete pending[msg[1]]; if (msg[2]) { h.reject(msg[2]); } else { h.resolve(msg[3]); } }
    } else if (type === 2) {                // notification: [2, method, params]
      if (msg[1] === 'redraw') { handleRedraw(msg[2]); }
    } else if (type === 0) {                // request from engine -> reply nil
      send([1, msg[1], null, null]);
    }
  }

  // A tiny async-iterable byte queue: worker.onmessage pushes RPC chunks in,
  // @msgpack/msgpack's decodeMultiStream pulls whole values out (handling msgpack
  // messages split across postMessage boundaries).
  function ByteQueue() { this._items = []; this._waiters = []; this._done = false; }
  ByteQueue.prototype.push = function (u8) {
    if (this._waiters.length) { this._waiters.shift()({ value: u8, done: false }); }
    else { this._items.push(u8); }
  };
  ByteQueue.prototype.close = function () {
    this._done = true;
    while (this._waiters.length) { this._waiters.shift()({ value: undefined, done: true }); }
  };
  ByteQueue.prototype[Symbol.asyncIterator] = function () {
    var self = this;
    return {
      next: function () {
        if (self._items.length) { return Promise.resolve({ value: self._items.shift(), done: false }); }
        if (self._done) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise(function (res) { self._waiters.push(res); });
      },
    };
  };
  var inbox = new ByteQueue();

  worker.onmessage = function (e) {
    var d = e.data;
    if (d instanceof ArrayBuffer) { inbox.push(new Uint8Array(d)); return; }
    if (d && d.kind === 'booting') { setStatus('engine booting (loading wasm + runtime)…'); }
    else if (d && (d.kind === 'stdout' || d.kind === 'stderr')) { console.log('[engine ' + d.kind + ']', d.text); }
    else if (d && d.kind === 'exit') { setStatus('engine exited'); inbox.close(); }
  };
  worker.onerror = function (e) {
    console.error('worker error', e);
    setStatus('worker error: ' + (e.message || (e.filename + ':' + e.lineno)));
  };

  async function receiveLoop() {
    try {
      for await (var msg of MessagePack.decodeMultiStream(inbox)) { onMessage(msg); }
    } catch (err) {
      console.error('receive loop error', err);
    }
    setStatus('engine exited');
  }

  // ---- keyboard -----------------------------------------------------------
  var SPECIAL = {
    'Enter': 'CR', 'Backspace': 'BS', 'Tab': 'Tab', 'Escape': 'Esc',
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Delete': 'Del', 'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp',
    'PageDown': 'PageDown', 'Insert': 'Insert',
  };
  function keyToNvim(e) {
    var k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' ||
        k === 'CapsLock' || k === 'Dead' || k === 'Unidentified') { return null; }
    var c = e.ctrlKey, alt = e.altKey || e.metaKey;
    if (k === ' ') {
      if (!c && !alt) { return ' '; }
      return '<' + (c ? 'C-' : '') + (alt ? 'A-' : '') + 'Space>';
    }
    var base = null, special = false;
    if (Object.prototype.hasOwnProperty.call(SPECIAL, k)) { base = SPECIAL[k]; special = true; }
    else if (/^F([1-9]|1[0-2])$/.test(k)) { base = k; special = true; }
    else if (k.length === 1) { base = k; }
    else { return null; }

    var mods = '';
    if (c) { mods += 'C-'; }
    if (alt) { mods += 'A-'; }
    if (e.shiftKey && special) { mods += 'S-'; }

    if (!mods && !special) { return base === '<' ? '<lt>' : base; }
    var inner = base === '<' ? 'lt' : base;
    return '<' + mods + inner + '>';
  }

  function installKeyboard() {
    preEl.setAttribute('tabindex', '0');
    preEl.addEventListener('keydown', function (e) {
      var keys = keyToNvim(e);
      if (keys === null) { return; }
      e.preventDefault();
      notify('nvim_input', [keys]);
    });
    preEl.addEventListener('mousedown', function () { preEl.focus(); });
    preEl.focus();
  }

  // ---- boot ---------------------------------------------------------------
  function boot() {
    setStatus('starting engine worker…');
    receiveLoop();
    installKeyboard();
    worker.postMessage({ args: ['-u', 'NONE', '-i', 'NONE'] });   // init the engine
    request('nvim_ui_attach', [COLS, ROWS, { rgb: true, ext_linegrid: true }])
      .then(function () { setStatus('attached — click the grid and type'); })
      .catch(function (err) { setStatus('ui_attach failed: ' + JSON.stringify(err)); });
  }

  // Expose a tiny API for debugging / automated testing.
  window.nvim = {
    input: function (keys) { return notify('nvim_input', [keys]); },
    request: request,
    resize: function (c, r) { return request('nvim_ui_try_resize', [c, r]); },
    gridText: function () { return grid.map(function (line) { return line.join(''); }).join('\n'); },
    cursor: cursor,
    state: function () { return { cols: cols, rows: rows, cursor: cursor }; },
  };

  boot();
})();
