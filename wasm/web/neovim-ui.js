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
// We attach with ext_linegrid and render grid 1 as a coloured monospace
// character grid: the Screen decodes the highlight stream (default_colors_set,
// hl_attr_define, and the per-cell hl ids in grid_line) and render() emits
// grouped colour spans (fg/bg/bold/italic/underline/undercurl/strikethrough/
// reverse). The command line and messages are drawn by Neovim into the bottom
// rows of that same grid (we don't request ext_cmdline/ext_messages), so `:w`,
// `:q`, etc. are visible.
//
// UMD: usable as a <script> (globalThis.NeovimUI) or via require() in Node (the
// test imports just Screen; mount_into/keyboard touch the DOM only when called).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.NeovimUI = factory(); }
})(typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- Screen: headless grid model + redraw decode ------------------------
  function Screen(cols, rows) {
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.cursor = { row: 0, col: 0 };
    this.grid = Screen._makeGrid(this.cols, this.rows, ' ');
    // Per-cell highlight id, in lockstep with `grid`. 0 = the default highlight.
    this.hlGrid = Screen._makeGrid(this.cols, this.rows, 0);
    // Highlight attribute definitions, keyed by id (from hl_attr_define). Each
    // value is the rgb_attrs dict (foreground/background/special as 24-bit ints
    // when present, plus boolean style flags). id 0 is always the default.
    this.hlAttrs = { 0: {} };
    // Default colours from default_colors_set (24-bit ints, or null for "use the
    // terminal default", which we leave to the page's base colours).
    this.defaultFg = null;
    this.defaultBg = null;
    this.defaultSp = null;
    this.onFlush = null;   // called (no args) on each `flush` event
  }
  Screen._makeGrid = function (c, r, fill) {
    var g = new Array(r);
    for (var y = 0; y < r; y++) {
      g[y] = new Array(c);
      for (var x = 0; x < c; x++) { g[y][x] = fill; }
    }
    return g;
  };
  Screen.prototype._clear = function () {
    for (var y = 0; y < this.rows; y++) {
      for (var x = 0; x < this.cols; x++) { this.grid[y][x] = ' '; this.hlGrid[y][x] = 0; }
    }
  };
  // Apply one redraw notification's params (an array of [event, args...] batches).
  Screen.prototype.handleRedraw = function (batches) {
    for (var i = 0; i < batches.length; i++) {
      var batch = batches[i];
      var name = batch[0];
      for (var j = 1; j < batch.length; j++) { this._event(name, batch[j]); }
    }
  };
  // Normalise a colour from the redraw stream: a 24-bit int is kept; the -1
  // sentinel ("use the default terminal colour") and a missing value become null.
  Screen._color = function (v) {
    return (typeof v === 'number' && v >= 0) ? v : null;
  };
  Screen.prototype._event = function (name, a) {
    switch (name) {
    case 'grid_resize':                       // [grid, width, height]
      this.cols = a[1]; this.rows = a[2];
      this.grid = Screen._makeGrid(this.cols, this.rows, ' ');
      this.hlGrid = Screen._makeGrid(this.cols, this.rows, 0);
      break;
    case 'grid_clear':
      this._clear(); break;
    case 'grid_cursor_goto':                   // [grid, row, col]
      this.cursor.row = a[1]; this.cursor.col = a[2]; break;
    case 'default_colors_set':                 // [rgb_fg, rgb_bg, rgb_sp, cterm_fg, cterm_bg]
      this.defaultFg = Screen._color(a[0]);
      this.defaultBg = Screen._color(a[1]);
      this.defaultSp = Screen._color(a[2]);
      break;
    case 'hl_attr_define':                      // [id, rgb_attrs, cterm_attrs, info]
      // Store the rgb_attrs dict directly (we attach with rgb:true, so the
      // cterm_attrs are irrelevant). Missing colours fall back to the defaults
      // at render time.
      this.hlAttrs[a[0]] = a[1] || {};
      break;
    case 'grid_line': {                        // [grid, row, col_start, cells, wrap]
      var row = a[1], col = a[2], cells = a[3];
      var line = this.grid[row], hlLine = this.hlGrid[row];
      if (!line) { break; }
      // hl_id is sticky WITHIN this grid_line: a cell that omits it reuses the
      // previous cell's id. Each grid_line starts from 0 (the default).
      var hl = 0;
      for (var i = 0; i < cells.length; i++) {
        var cell = cells[i];
        var text = cell[0];
        if (cell.length >= 2) { hl = cell[1]; }
        var repeat = cell.length >= 3 ? cell[2] : 1;
        for (var k = 0; k < repeat; k++) {
          if (col < this.cols) { line[col] = text; hlLine[col] = hl; col++; }
        }
      }
      break;
    }
    case 'grid_scroll': {                       // [grid, top, bot, left, right, rows, cols]
      var top = a[1], bot = a[2], left = a[3], right = a[4], dr = a[5];
      if (dr > 0) {
        for (var y = top; y < bot - dr; y++) {
          for (var x = left; x < right; x++) {
            this.grid[y][x] = this.grid[y + dr][x];
            this.hlGrid[y][x] = this.hlGrid[y + dr][x];
          }
        }
      } else if (dr < 0) {
        for (var y2 = bot - 1; y2 >= top - dr; y2--) {
          for (var x2 = left; x2 < right; x2++) {
            this.grid[y2][x2] = this.grid[y2 + dr][x2];
            this.hlGrid[y2][x2] = this.hlGrid[y2 + dr][x2];
          }
        }
      }
      break;
    }
    case 'flush':
      if (this.onFlush) { this.onFlush(); }
      break;
    default:
      break;   // ignore mode/msg/etc. events
    }
  };
  // The whole screen as text (rows joined by '\n').
  Screen.prototype.text = function () {
    return this.grid.map(function (line) { return line.join(''); }).join('\n');
  };
  // The resolved highlight id at a cell (0 = default), for headless assertions.
  Screen.prototype.hlIdAt = function (row, col) {
    var line = this.hlGrid[row];
    return line ? (line[col] || 0) : 0;
  };
  // The resolved rgb_attrs dict at a cell (the hl_attr_define entry, or {} for
  // an unknown/default id). For headless assertions.
  Screen.prototype.attrAt = function (row, col) {
    return this.hlAttrs[this.hlIdAt(row, col)] || {};
  };

  // ---- DOM rendering ------------------------------------------------------
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  // 24-bit int -> '#rrggbb'.
  function hex(n) {
    var s = (n & 0xffffff).toString(16);
    return '#' + '000000'.slice(s.length) + s;
  }
  // Resolve an hl id to the concrete fg/bg/style we paint a span with. Returns
  // null when the cell needs no per-span styling (default id 0 with no attrs);
  // such cells inherit the container's base colours.
  function resolveStyle(screen, id) {
    if (!id) { return null; }
    var attrs = screen.hlAttrs[id];
    if (!attrs) { return null; }
    var fg = (typeof attrs.foreground === 'number') ? attrs.foreground : screen.defaultFg;
    var bg = (typeof attrs.background === 'number') ? attrs.background : screen.defaultBg;
    if (attrs.reverse) { var t = fg; fg = (bg === null ? screen.defaultBg : bg); bg = (t === null ? screen.defaultFg : t); }
    var css = '';
    if (fg !== null) { css += 'color:' + hex(fg) + ';'; }
    // Only paint a background when it differs from the default (reverse forces it).
    if (bg !== null && (bg !== screen.defaultBg || attrs.reverse)) { css += 'background-color:' + hex(bg) + ';'; }
    if (attrs.bold) { css += 'font-weight:bold;'; }
    if (attrs.italic) { css += 'font-style:italic;'; }
    var deco = '';
    if (attrs.underline || attrs.underdouble || attrs.underdotted || attrs.underdashed) { deco += ' underline'; }
    if (attrs.undercurl) { deco += ' underline wavy'; }
    if (attrs.strikethrough) { deco += ' line-through'; }
    if (deco) {
      css += 'text-decoration:' + deco.trim() + ';';
      var sp = (typeof attrs.special === 'number') ? attrs.special : screen.defaultSp;
      if ((attrs.undercurl || attrs.underdotted || attrs.underdashed) && sp !== null) {
        css += 'text-decoration-color:' + hex(sp) + ';';
      }
    }
    return css || null;
  }
  // Style for the cursor cell: a solid block (swap to the default bg/fg) so it
  // stays visible over any coloured cell. Built on top of the cell's own attrs.
  function cursorStyle(screen, id) {
    var attrs = screen.hlAttrs[id] || {};
    var fg = (typeof attrs.foreground === 'number') ? attrs.foreground : screen.defaultFg;
    var bg = (typeof attrs.background === 'number') ? attrs.background : screen.defaultBg;
    if (attrs.reverse) { var t = fg; fg = bg; bg = t; }
    // Cursor block: paint the cell's fg as the background and the cell's bg (or
    // the default bg) as the text colour, so it reads as a solid block.
    var blockBg = (fg !== null) ? fg : screen.defaultFg;
    var blockFg = (bg !== null) ? bg : screen.defaultBg;
    var css = '';
    if (blockBg !== null) { css += 'background-color:' + hex(blockBg) + ';'; }
    if (blockFg !== null) { css += 'color:' + hex(blockFg) + ';'; }
    return css;
  }
  function render(el, screen) {
    // Apply the default colours to the container so default cells need no span.
    if (screen.defaultFg !== null) { el.style.color = hex(screen.defaultFg); }
    if (screen.defaultBg !== null) { el.style.backgroundColor = hex(screen.defaultBg); }

    var out = [];
    var cur = screen.cursor;
    for (var r = 0; r < screen.rows; r++) {
      var line = screen.grid[r], hlLine = screen.hlGrid[r];
      var curCol = (r === cur.row && cur.col < screen.cols) ? cur.col : -1;
      var rowHtml = '';
      var c = 0;
      while (c < screen.cols) {
        if (c === curCol) {
          // The cursor cell is its own span (a solid block); never grouped.
          var cs = cursorStyle(screen, hlLine[c]);
          rowHtml += '<span class="cursor" style="' + cs + '">' +
                     escapeHtml(line[c] || ' ') + '</span>';
          c++;
          continue;
        }
        // Group a run of consecutive cells that share the same hl id (and don't
        // contain the cursor) into one span.
        var id = hlLine[c];
        var start = c;
        while (c < screen.cols && hlLine[c] === id && c !== curCol) { c++; }
        var text = escapeHtml(line.slice(start, c).join(''));
        var style = resolveStyle(screen, id);
        rowHtml += style ? ('<span style="' + style + '">' + text + '</span>') : text;
      }
      out.push(rowHtml);
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

  // ---- font + sizing ------------------------------------------------------
  // We keep the grid math stable by pinning a deterministic line-height: rows
  // are an exact integer number of px so floor(contentHeight / cellH) doesn't
  // wobble on sub-pixel font metrics. 1.2 is the conventional terminal ratio.
  var DEFAULT_FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
  var LINE_HEIGHT_RATIO = 1.2;

  // Apply opts.font_family / opts.font_size to `el` (only when given, so an
  // unset option leaves the page CSS alone), and pin a deterministic integer-px
  // line-height. `font_size` is a number (-> px) or a string (used as-is).
  // Returns the resolved { fontFamily, fontSize (css), lineHeight (px) } that the
  // probe must mirror so its cell metrics match the live element.
  function applyFont(el, opts) {
    if (opts.font_family) { el.style.fontFamily = opts.font_family; }
    if (opts.font_size != null) {
      el.style.fontSize = (typeof opts.font_size === 'number')
        ? (opts.font_size + 'px') : opts.font_size;
    }
    var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : null;
    var fontFamily = (cs && cs.fontFamily) || el.style.fontFamily || DEFAULT_FONT_FAMILY;
    var fontSizeCss = (cs && cs.fontSize) || el.style.fontSize || '16px';
    var fontSizePx = parseFloat(fontSizeCss) || 16;
    // Pin line-height to an exact integer px so row math is stable.
    var lineHeightPx = Math.max(1, Math.round(fontSizePx * LINE_HEIGHT_RATIO));
    el.style.lineHeight = lineHeightPx + 'px';
    return { fontFamily: fontFamily, fontSize: fontSizeCss, lineHeight: lineHeightPx };
  }

  // Measure one monospace cell (width x height in px) for the given resolved
  // font, using a hidden off-screen probe with the SAME font metrics as the live
  // element. Uses getBoundingClientRect() for sub-pixel accuracy: a long run of a
  // fixed glyph divided by its length gives a per-cell width that isn't skewed by
  // a single glyph's rounding.
  function measureCell(font) {
    var probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = font.fontFamily;
    probe.style.fontSize = font.fontSize;
    probe.style.lineHeight = font.lineHeight + 'px';
    probe.style.padding = '0';
    probe.style.margin = '0';
    probe.style.border = '0';
    var N = 50;
    probe.textContent = '0'.repeat(N);
    document.body.appendChild(probe);
    var rect = probe.getBoundingClientRect();
    var cellW = rect.width / N;
    document.body.removeChild(probe);
    // Height comes from the pinned (integer) line-height, which is what the live
    // <pre> uses per row -- the probe rect height can be the same but we trust the
    // pinned value so cellH is an exact integer.
    return { w: cellW, h: font.lineHeight };
  }

  // `el`'s content-box size in px (clientWidth/Height already exclude border and
  // scrollbar; subtract padding to get the content box).
  function contentBox(el) {
    var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(el) : null;
    var padL = cs ? (parseFloat(cs.paddingLeft) || 0) : 0;
    var padR = cs ? (parseFloat(cs.paddingRight) || 0) : 0;
    var padT = cs ? (parseFloat(cs.paddingTop) || 0) : 0;
    var padB = cs ? (parseFloat(cs.paddingBottom) || 0) : 0;
    return {
      w: Math.max(0, el.clientWidth - padL - padR),
      h: Math.max(0, el.clientHeight - padT - padB),
    };
  }

  // Derive { cols, rows } from `el`'s content box and a measured cell. Returns
  // null when the element has no usable layout yet (0x0 or an unmeasurable cell),
  // so the caller can fall back to the fixed defaults instead of a degenerate grid.
  function deriveSize(el, font) {
    var box = contentBox(el);
    var cell = measureCell(font);
    if (!(cell.w > 0) || !(cell.h > 0) || box.w <= 0 || box.h <= 0) { return null; }
    return {
      cols: Math.max(1, Math.floor(box.w / cell.w)),
      rows: Math.max(1, Math.floor(box.h / cell.h)),
    };
  }

  // ---- mount_into ---------------------------------------------------------
  // Wire `instance` to render into the DOM element `el` (a <pre>) and forward
  // its keystrokes.
  //
  // opts:
  //   * font_family - CSS font-family applied to `el` (default: leave the page
  //     CSS as-is; a monospace stack is assumed). A monospace family is required
  //     for the grid to line up.
  //   * font_size   - number (-> px) or a CSS length string, applied to `el`.
  //   * cols, rows  - EXPLICIT grid size. Passing either disables auto-sizing:
  //     the grid is fixed at the given dimensions (missing one defaults 80/24).
  //
  // With neither cols nor rows given, the grid AUTO-SIZES: it measures the font's
  // cell metrics and `el`'s content box, attaches a grid that fills the element,
  // and tracks `el`'s size with a ResizeObserver (driving nvim_ui_try_resize on
  // change, debounced via requestAnimationFrame; the engine's grid_resize redraw
  // reflows the Screen, so we never resize it by hand). If `el` has no layout yet
  // (0x0), it falls back to 80x24 so it never attaches a degenerate grid.
  //
  // Returns { screen, resize(c, r), dispose(), cols, rows } (cols/rows are the
  // derived-or-explicit dimensions it attached with).
  function mount_into(instance, el, opts) {
    opts = opts || {};
    var explicit = (opts.cols != null) || (opts.rows != null);

    // Font styling + a pinned line-height so the grid math is deterministic.
    var font = applyFont(el, opts);

    var cols, rows;
    if (explicit) {
      cols = opts.cols || 80; rows = opts.rows || 24;
    } else {
      var derived = deriveSize(el, font);
      if (derived) { cols = derived.cols; rows = derived.rows; }
      else { cols = 80; rows = 24; }   // no layout yet: never attach 0x0
    }

    var screen = new Screen(cols, rows);
    screen.onFlush = function () { render(el, screen); };
    var off = instance.onNotification('redraw', function (params) { screen.handleRedraw(params); });
    installKeyboard(el, instance);
    instance.request('nvim_ui_attach', [cols, rows, { rgb: true, ext_linegrid: true }]);

    var api = {
      screen: screen,
      cols: cols,
      rows: rows,
      resize: function (c, r) {
        api.cols = c; api.rows = r;
        return instance.request('nvim_ui_try_resize', [c, r]);
      },
      dispose: function () {
        off();
        if (observer) { observer.disconnect(); observer = null; }
        if (rafId != null) { cancelRaf(rafId); rafId = null; }
      },
    };

    // ---- auto-resize: track `el` and drive try_resize on change ----------
    // Only when auto-sizing (explicit cols/rows keep a fixed grid). On each
    // observed resize we recompute cols/rows and, if they changed, ask the engine
    // to resize -- it answers with a grid_resize redraw the Screen decode already
    // handles, so we don't touch the Screen here (avoids a double-resize race).
    // Coalesce a burst of resizes (a window drag) into one try_resize per frame.
    var observer = null, rafId = null;
    var hasRaf = (typeof requestAnimationFrame === 'function');
    function scheduleRaf(fn) { return hasRaf ? requestAnimationFrame(fn) : setTimeout(fn, 16); }
    function cancelRaf(id) { if (hasRaf) { cancelAnimationFrame(id); } else { clearTimeout(id); } }

    if (!explicit && typeof ResizeObserver === 'function') {
      var recompute = function () {
        rafId = null;
        var derived = deriveSize(el, font);
        if (!derived) { return; }                 // 0x0 (e.g. hidden): keep last grid
        if (derived.cols === api.cols && derived.rows === api.rows) { return; }
        api.cols = derived.cols; api.rows = derived.rows;
        instance.request('nvim_ui_try_resize', [derived.cols, derived.rows]);
      };
      observer = new ResizeObserver(function () {
        if (rafId != null) { return; }            // coalesce: one try_resize per frame
        rafId = scheduleRaf(recompute);
      });
      observer.observe(el);
    }

    return api;
  }

  return { Screen: Screen, mount_into: mount_into, keyToNvim: keyToNvim };
});
