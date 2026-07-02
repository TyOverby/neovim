// wasm/web/src/neovim-ui.ts - default UI renderer for a Neovim instance.
//
// The "default UI renderer" layer (see wasm/README.md). It has two parts:
//
//   * Screen - a HEADLESS model of the ext_linegrid screen: it decodes `redraw`
//     batches into a 2-D character grid + cursor. No DOM. This is deliberately
//     separable so it can be driven and asserted without a browser (the headless
//     end-to-end test in e2e.test.js renders into the very same Screen the page
//     uses, which is what validates the decode path).
//
//   * mount_into(instance, canvas) - wires a Screen to a neovim.js instance and
//     a <canvas>: subscribes to redraw, attaches the UI, paints on flush via the
//     grid-renderer package (wasm/grid-renderer - a bitmap-glyph-cache canvas
//     renderer with path-drawn box-drawing/legacy-computing glyphs), and maps
//     keydown -> nvim_input.
//
// We attach with ext_linegrid and paint grid 1 as a colored monospace cell
// grid: the Screen decodes the highlight stream (default_colors_set,
// hl_attr_define, and the per-cell hl ids in grid_line) and the renderer
// paints fg/bg/bold/italic/underline/undercurl/strikethrough/reverse per
// cell. The command line and messages are drawn by Neovim into the bottom
// rows of that same grid (we don't request ext_cmdline/ext_messages), so
// `:w`, `:q`, etc. are visible.
//
// DEPENDENCY: mount_into needs the grid-renderer module. Like the msgpack
// dependency in neovim.ts, it is resolved at runtime - pass it via
// opts.grid_renderer, or load dist/grid-renderer.js (UMD) before this module
// so globalThis.GridRenderer is set. The headless Screen has no dependency.
//
// The legacy "render into a <pre>" DOM renderer lives on as a TESTING UTILITY
// in neovim-ui-pre-testutil.ts (plain CommonJS, not shipped in the bundles).
//
// This module is the TypeScript SOURCE OF TRUTH; the build emits a UMD
// `neovim-ui.js` (globalThis.NeovimUI / require()), an ESM `neovim-ui.mjs`, and a
// `neovim-ui.d.ts`.

// The subset of a neovim.js instance the renderer uses.
export interface UIInstance {
  request(method: string, params?: any[]): Promise<any>;
  notify(method: string, params?: any[]): void;
  input(keys: string): void;
  onNotification(method: string, fn: (params: any) => void): () => void;
}

// A highlight attribute definition (the rgb_attrs dict from hl_attr_define).
export interface HlAttrs {
  foreground?: number;
  background?: number;
  special?: number;
  reverse?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
  undercurl?: boolean;
  strikethrough?: boolean;
  [k: string]: any;
}

export interface MountOptions {
  font_family?: string;
  // Font size in CSS px (a number; the HiDPI backing-store scale is handled
  // internally via devicePixelRatio).
  font_size?: number;
  cols?: number;
  rows?: number;
  // Base colors used when Neovim says "use the default terminal color"
  // (defaults: 0xd4d4d4 on 0x000000, matching the demo page).
  default_fg?: number;
  default_bg?: number;
  // The grid-renderer module (see the header comment). Defaults to
  // globalThis.GridRenderer.
  grid_renderer?: any;
}

export interface MountHandle {
  screen: Screen;
  cols: number;
  rows: number;
  // The underlying grid-renderer instance (glyph cache, metrics, ...).
  renderer: any;
  resize(c: number, r: number): Promise<any>;
  dispose(): void;
}

// ---- Screen: headless grid model + redraw decode ------------------------
export class Screen {
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  grid: string[][];
  // Per-cell highlight id, in lockstep with `grid`. 0 = the default highlight.
  hlGrid: number[][];
  // Highlight attribute definitions, keyed by id (from hl_attr_define). Each
  // value is the rgb_attrs dict (foreground/background/special as 24-bit ints
  // when present, plus boolean style flags). id 0 is always the default.
  hlAttrs: Record<number, HlAttrs>;
  // Default colours from default_colors_set (24-bit ints, or null for "use the
  // terminal default", which we leave to the embedder's base colours).
  defaultFg: number | null;
  defaultBg: number | null;
  defaultSp: number | null;
  onFlush: (() => void) | null;

  constructor(cols?: number, rows?: number) {
    this.cols = cols || 80;
    this.rows = rows || 24;
    this.cursor = { row: 0, col: 0 };
    this.grid = Screen._makeGrid(this.cols, this.rows, ' ');
    this.hlGrid = Screen._makeGrid(this.cols, this.rows, 0);
    this.hlAttrs = { 0: {} };
    this.defaultFg = null;
    this.defaultBg = null;
    this.defaultSp = null;
    this.onFlush = null;   // called (no args) on each `flush` event
  }

  static _makeGrid<T>(c: number, r: number, fill: T): T[][] {
    const g: T[][] = new Array(r);
    for (let y = 0; y < r; y++) {
      g[y] = new Array(c);
      for (let x = 0; x < c; x++) { g[y][x] = fill; }
    }
    return g;
  }

  // Normalise a colour from the redraw stream: a 24-bit int is kept; the -1
  // sentinel ("use the default terminal colour") and a missing value become null.
  static _color(v: any): number | null {
    return (typeof v === 'number' && v >= 0) ? v : null;
  }

  _clear(): void {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) { this.grid[y][x] = ' '; this.hlGrid[y][x] = 0; }
    }
  }

  // Apply one redraw notification's params (an array of [event, args...] batches).
  handleRedraw(batches: any[]): void {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const name = batch[0];
      for (let j = 1; j < batch.length; j++) { this._event(name, batch[j]); }
    }
  }

  _event(name: string, a: any): void {
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
      const row = a[1]; let col = a[2]; const cells = a[3];
      const line = this.grid[row], hlLine = this.hlGrid[row];
      if (!line) { break; }
      // hl_id is sticky WITHIN this grid_line: a cell that omits it reuses the
      // previous cell's id. Each grid_line starts from 0 (the default).
      let hl = 0;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const text = cell[0];
        if (cell.length >= 2) { hl = cell[1]; }
        const repeat = cell.length >= 3 ? cell[2] : 1;
        for (let k = 0; k < repeat; k++) {
          if (col < this.cols) { line[col] = text; hlLine[col] = hl; col++; }
        }
      }
      break;
    }
    case 'grid_scroll': {                       // [grid, top, bot, left, right, rows, cols]
      const top = a[1], bot = a[2], left = a[3], right = a[4], dr = a[5];
      if (dr > 0) {
        for (let y = top; y < bot - dr; y++) {
          for (let x = left; x < right; x++) {
            this.grid[y][x] = this.grid[y + dr][x];
            this.hlGrid[y][x] = this.hlGrid[y + dr][x];
          }
        }
      } else if (dr < 0) {
        for (let y2 = bot - 1; y2 >= top - dr; y2--) {
          for (let x2 = left; x2 < right; x2++) {
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
  }

  // The whole screen as text (rows joined by '\n').
  text(): string {
    return this.grid.map(function (line) { return line.join(''); }).join('\n');
  }

  // The resolved highlight id at a cell (0 = default), for headless assertions.
  hlIdAt(row: number, col: number): number {
    const line = this.hlGrid[row];
    return line ? (line[col] || 0) : 0;
  }

  // The resolved rgb_attrs dict at a cell (the hl_attr_define entry, or {} for
  // an unknown/default id). For headless assertions.
  attrAt(row: number, col: number): HlAttrs {
    return this.hlAttrs[this.hlIdAt(row, col)] || {};
  }
}

// ---- Screen -> renderer cells --------------------------------------------
// Resolve one row of the Screen into grid-renderer Cells: apply the hl attrs
// over the default colors, apply reverse video, and mark wide glyphs (a wide
// char is followed by a '' continuation cell in ext_linegrid).
export function screenToCells(screen: Screen, defFg: number, defBg: number): any[][] {
  const out: any[][] = new Array(screen.rows);
  const baseFg = (screen.defaultFg !== null) ? screen.defaultFg : defFg;
  const baseBg = (screen.defaultBg !== null) ? screen.defaultBg : defBg;
  const baseSp = (screen.defaultSp !== null) ? screen.defaultSp : null;
  for (let r = 0; r < screen.rows; r++) {
    const line = screen.grid[r], hlLine = screen.hlGrid[r];
    const row: any[] = new Array(screen.cols);
    for (let c = 0; c < screen.cols; c++) {
      const attrs = screen.hlAttrs[hlLine[c]] || {};
      let fg = (typeof attrs.foreground === 'number') ? attrs.foreground : baseFg;
      let bg = (typeof attrs.background === 'number') ? attrs.background : baseBg;
      if (attrs.reverse) { const t = fg; fg = bg; bg = t; }
      const cell: any = { text: line[c] || '', fg: fg, bg: bg };
      const sp = (typeof attrs.special === 'number') ? attrs.special : baseSp;
      if (sp !== null) { cell.sp = sp; }
      if (attrs.bold) { cell.bold = true; }
      if (attrs.italic) { cell.italic = true; }
      if (attrs.underline) { cell.underline = true; }
      if (attrs.undercurl) { cell.undercurl = true; }
      if (attrs.underdouble) { cell.underdouble = true; }
      if (attrs.underdotted) { cell.underdotted = true; }
      if (attrs.underdashed) { cell.underdashed = true; }
      if (attrs.strikethrough) { cell.strikethrough = true; }
      // Wide glyph: ext_linegrid puts '' in the following cell.
      if (cell.text && c + 1 < screen.cols && line[c + 1] === '') { cell.width = 2; }
      row[c] = cell;
    }
    out[r] = row;
  }
  return out;
}

// ---- keyboard -----------------------------------------------------------
const SPECIAL: Record<string, string> = {
  'Enter': 'CR', 'Backspace': 'BS', 'Tab': 'Tab', 'Escape': 'Esc',
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'Delete': 'Del', 'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp',
  'PageDown': 'PageDown', 'Insert': 'Insert',
};
export function keyToNvim(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' ||
      k === 'CapsLock' || k === 'Dead' || k === 'Unidentified') { return null; }
  const c = e.ctrlKey, alt = e.altKey || e.metaKey;
  if (k === ' ') {
    if (!c && !alt) { return ' '; }
    return '<' + (c ? 'C-' : '') + (alt ? 'A-' : '') + 'Space>';
  }
  let base: string | null = null, special = false;
  if (Object.prototype.hasOwnProperty.call(SPECIAL, k)) { base = SPECIAL[k]; special = true; }
  else if (/^F([1-9]|1[0-2])$/.test(k)) { base = k; special = true; }
  else if (k.length === 1) { base = k; }
  else { return null; }

  let mods = '';
  if (c) { mods += 'C-'; }
  if (alt) { mods += 'A-'; }
  if (e.shiftKey && special) { mods += 'S-'; }

  if (!mods && !special) { return base === '<' ? '<lt>' : base; }
  const inner = base === '<' ? 'lt' : base;
  return '<' + mods + inner + '>';
}

function installKeyboard(el: HTMLElement, instance: UIInstance): void {
  el.setAttribute('tabindex', '0');
  el.addEventListener('keydown', function (e) {
    const keys = keyToNvim(e as KeyboardEvent);
    if (keys === null) { return; }
    e.preventDefault();
    instance.input(keys);
  });
  el.addEventListener('mousedown', function () { el.focus(); });
  el.focus();
}

// ---- mount_into ---------------------------------------------------------
// Wire `instance` to paint into `canvas` (a <canvas>) and forward its
// keystrokes.
//
// opts:
//   * font_family   - CSS font-family for the cell font (monospace expected).
//   * font_size     - number, CSS px (default 16).
//   * cols, rows    - EXPLICIT grid size. Passing either disables auto-sizing:
//     the grid is fixed at the given dimensions (missing one defaults 80/24)
//     and the canvas backing store is sized to exactly fit it.
//   * default_fg/bg - base colors for "default terminal color" cells.
//   * grid_renderer - the grid-renderer module (default: globalThis.GridRenderer).
//
// With neither cols nor rows given, the grid AUTO-SIZES: the canvas backing
// store tracks the element's CSS box (x devicePixelRatio for crisp HiDPI
// output), the grid is as many whole cells as fit, and a ResizeObserver
// drives nvim_ui_try_resize on change (debounced via requestAnimationFrame;
// the engine's grid_resize redraw reflows the Screen, so we never resize it
// by hand). If the canvas has no layout yet (0x0), it falls back to 80x24.
//
// Returns { screen, renderer, resize(c, r), dispose(), cols, rows }.
export function mount_into(instance: UIInstance, canvas: HTMLCanvasElement, opts?: MountOptions): MountHandle {
  opts = opts || {};
  const GR = opts.grid_renderer ||
    (typeof globalThis !== 'undefined' && (globalThis as any).GridRenderer);
  if (!GR || !GR.GridRenderer) {
    throw new Error('mount_into: grid-renderer not available - load grid-renderer.js ' +
      'before neovim-ui.js or pass opts.grid_renderer');
  }

  const explicit = (opts.cols != null) || (opts.rows != null);
  const defFg = (opts.default_fg != null) ? opts.default_fg : 0xd4d4d4;
  const defBg = (opts.default_bg != null) ? opts.default_bg : 0x000000;
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
  const fontSizeCss = (typeof opts.font_size === 'number') ? opts.font_size : 16;

  // The renderer works in DEVICE pixels: the font is scaled by dpr and the
  // canvas backing store matches; the element is scaled back down via CSS.
  const renderer = new GR.GridRenderer(canvas, {
    fontFamily: opts.font_family,
    fontSizePx: Math.round(fontSizeCss * dpr),
  });

  // The canvas element's CSS box in device px, or null when it has no layout.
  function deviceBox(): { w: number; h: number } | null {
    if (typeof canvas.getBoundingClientRect !== 'function') { return null; }
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) { return null; }
    return { w: Math.round(rect.width * dpr), h: Math.round(rect.height * dpr) };
  }

  let cols: number, rows: number;
  if (explicit) {
    cols = opts.cols || 80; rows = opts.rows || 24;
    renderer.resize(cols, rows);
    // Style the element to its backing store's CSS size so it's crisp.
    if (canvas.style) {
      canvas.style.width = (renderer.pixelWidth / dpr) + 'px';
      canvas.style.height = (renderer.pixelHeight / dpr) + 'px';
    }
  } else {
    const box = deviceBox();
    if (box) {
      const fitted = renderer.fit(box.w, box.h, defBg);
      cols = fitted.cols; rows = fitted.rows;
    } else {
      cols = 80; rows = 24;              // no layout yet: never attach 0x0
      renderer.resize(cols, rows);
    }
  }

  const screen = new Screen(cols, rows);
  screen.onFlush = function () {
    renderer.render(screenToCells(screen, defFg, defBg), screen.cursor);
  };
  const off = instance.onNotification('redraw', function (params) { screen.handleRedraw(params); });
  installKeyboard(canvas, instance);
  instance.request('nvim_ui_attach', [cols, rows, { rgb: true, ext_linegrid: true }]);

  const api: MountHandle = {
    screen: screen,
    cols: cols,
    rows: rows,
    renderer: renderer,
    resize: function (c, r) {
      api.cols = c; api.rows = r;
      if (renderer.cols !== c || renderer.rows !== r) { renderer.resize(c, r); }
      return instance.request('nvim_ui_try_resize', [c, r]);
    },
    dispose: function () {
      off();
      if (observer) { observer.disconnect(); observer = null; }
      if (rafId != null) { cancelRaf(rafId); rafId = null; }
    },
  };

  // ---- auto-resize: track the canvas box and drive try_resize on change --
  // Only when auto-sizing (explicit cols/rows keep a fixed grid). On each
  // observed resize we refit the backing store and, if the cell grid changed,
  // ask the engine to resize -- it answers with a grid_resize redraw the
  // Screen decode already handles. Coalesce bursts into one try_resize/frame.
  let observer: ResizeObserver | null = null, rafId: number | null = null;
  const hasRaf = (typeof requestAnimationFrame === 'function');
  function scheduleRaf(fn: () => void): number { return hasRaf ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as any); }
  function cancelRaf(id: number): void { if (hasRaf) { cancelAnimationFrame(id); } else { clearTimeout(id); } }

  if (!explicit && typeof ResizeObserver === 'function') {
    const recompute = function () {
      rafId = null;
      const box = deviceBox();
      if (!box) { return; }                 // 0x0 (e.g. hidden): keep last grid
      const fitted = renderer.fit(box.w, box.h, defBg);
      // The refit cleared the canvas; repaint the current screen contents at
      // whatever size we have while the engine reflows.
      if (screen.onFlush) { screen.onFlush(); }
      if (fitted.cols === api.cols && fitted.rows === api.rows) { return; }
      api.cols = fitted.cols; api.rows = fitted.rows;
      instance.request('nvim_ui_try_resize', [fitted.cols, fitted.rows]);
    };
    observer = new ResizeObserver(function () {
      if (rafId != null) { return; }        // coalesce: one try_resize per frame
      rafId = scheduleRaf(recompute);
    });
    observer.observe(canvas);
  }

  return api;
}
