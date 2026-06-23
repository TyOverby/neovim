// wasm/web/neovim-ui.js - default UI renderer for a Neovim instance.
//
// The "default UI renderer" layer (see wasm/README.md). It has two parts:
//
//   * Screen - a HEADLESS model of the ext_linegrid screen: it decodes `redraw`
//     batches into a 2-D character grid + cursor. No DOM. This is deliberately
//     separable so it can be driven and asserted without a browser (the headless
//     end-to-end test in e2e.test.js renders into the very same Screen the page
//     uses, which is what validates the decode path).
//
//   * mount_into(instance, el) - wires a Screen to a neovim.js instance and a
//     DOM <pre>: subscribes to redraw, attaches the UI, renders on flush, and
//     maps keydown -> nvim_input.
//
// We attach with ext_linegrid and render grid 1 as a plain monospace character
// grid with no fg/bg colouring (only a cursor outline). The command line and
// messages are drawn by Neovim into the bottom rows of that same grid (we don't
// request ext_cmdline/ext_messages), so `:w`, `:q`, etc. are visible.
//
// UMD: usable as a <script> (globalThis.NeovimUI) or via require() in Node (the
// test imports just Screen; mount_into/keyboard touch the DOM only when called).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.NeovimUI = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Screen: headless grid model + redraw decode ------------------------
  function Screen(cols, rows) {
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.cursor = { row: 0, col: 0 };
    this.grid = Screen._makeGrid(this.cols, this.rows);
    this.onFlush = null;   // called (no args) on each `flush` event
  }
  Screen._makeGrid = function (c, r) {
    var g = new Array(r);
    for (var y = 0; y < r; y++) {
      g[y] = new Array(c);
      for (var x = 0; x < c; x++) { g[y][x] = ' '; }
    }
    return g;
  };
  Screen.prototype._clear = function () {
    for (var y = 0; y < this.rows; y++) { for (var x = 0; x < this.cols; x++) { this.grid[y][x] = ' '; } }
  };
  // Apply one redraw notification's params (an array of [event, args...] batches).
  Screen.prototype.handleRedraw = function (batches) {
    for (var i = 0; i < batches.length; i++) {
      var batch = batches[i];
      var name = batch[0];
      for (var j = 1; j < batch.length; j++) { this._event(name, batch[j]); }
    }
  };
  Screen.prototype._event = function (name, a) {
    switch (name) {
    case 'grid_resize':                       // [grid, width, height]
      this.cols = a[1]; this.rows = a[2]; this.grid = Screen._makeGrid(this.cols, this.rows); break;
    case 'grid_clear':
      this._clear(); break;
    case 'grid_cursor_goto':                   // [grid, row, col]
      this.cursor.row = a[1]; this.cursor.col = a[2]; break;
    case 'grid_line': {                        // [grid, row, col_start, cells, wrap]
      var row = a[1], col = a[2], cells = a[3];
      var line = this.grid[row];
      if (!line) { break; }
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var text = cell[0];
        var repeat = cell.length >= 3 ? cell[2] : 1;
        for (var k = 0; k < repeat; k++) {
          if (col < this.cols) { line[col++] = text; }
        }
      }
      break;
    }
    case 'grid_scroll': {                       // [grid, top, bot, left, right, rows, cols]
      var top = a[1], bot = a[2], left = a[3], right = a[4], dr = a[5];
      if (dr > 0) {
        for (var y = top; y < bot - dr; y++) {
          for (var x = left; x < right; x++) { this.grid[y][x] = this.grid[y + dr][x]; }
        }
      } else if (dr < 0) {
        for (var y2 = bot - 1; y2 >= top - dr; y2--) {
          for (var x2 = left; x2 < right; x2++) { this.grid[y2][x2] = this.grid[y2 + dr][x2]; }
        }
      }
      break;
    }
    case 'flush':
      if (this.onFlush) { this.onFlush(); }
      break;
    default:
      break;   // ignore hl/mode/msg/etc. events
    }
  };
  // The whole screen as text (rows joined by '\n').
  Screen.prototype.text = function () {
    return this.grid.map(function (line) { return line.join(''); }).join('\n');
  };

  // ---- DOM rendering ------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function render(el, screen) {
    var out = [];
    var cur = screen.cursor;
    for (var r = 0; r < screen.rows; r++) {
      var line = screen.grid[r];
      if (r === cur.row && cur.col < screen.cols) {
        var before = escapeHtml(line.slice(0, cur.col).join(''));
        var at = escapeHtml(line[cur.col] || ' ');
        var after = escapeHtml(line.slice(cur.col + 1).join(''));
        out.push(before + '<span class="cursor">' + (at || ' ') + '</span>' + after);
      } else {
        out.push(escapeHtml(line.join('')));
      }
    }
    el.innerHTML = out.join('\n');
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

  function installKeyboard(el, instance) {
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', function (e) {
      var keys = keyToNvim(e);
      if (keys === null) { return; }
      e.preventDefault();
      instance.input(keys);
    });
    el.addEventListener('mousedown', function () { el.focus(); });
    el.focus();
  }

  // ---- mount_into ---------------------------------------------------------
  // Wire `instance` to render into the DOM element `el` (a <pre>) and forward
  // its keystrokes. opts: { cols, rows }. Returns { screen, resize, dispose }.
  function mount_into(instance, el, opts) {
    opts = opts || {};
    var cols = opts.cols || 80, rows = opts.rows || 24;
    var screen = new Screen(cols, rows);
    screen.onFlush = function () { render(el, screen); };
    var off = instance.onNotification('redraw', function (params) { screen.handleRedraw(params); });
    installKeyboard(el, instance);
    instance.request('nvim_ui_attach', [cols, rows, { rgb: true, ext_linegrid: true }]);
    return {
      screen: screen,
      resize: function (c, r) { return instance.request('nvim_ui_try_resize', [c, r]); },
      dispose: function () { off(); },
    };
  }

  return { Screen: Screen, mount_into: mount_into, keyToNvim: keyToNvim };
});
