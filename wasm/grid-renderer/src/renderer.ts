// GridRenderer - paints a character grid onto a target canvas.
//
// Rendering model:
//   * Every distinct (text, fg, bg, sp, style, width) cell is rasterized ONCE
//     (CellRasterizer) into a slot of a sprite-sheet atlas (GlyphAtlas) and
//     painted by drawImage from that sheet - no per-frame text shaping, and
//     no putImageData pixel uploads on the hot path (sheets stay GPU-cached
//     in browsers).
//   * render(grid) diffs each cell against what was painted there last time
//     (cheap field comparison - no per-cell key strings for unchanged cells)
//     and only blits cells that changed, plus the cursor's old/new positions.
//
// Cells are treated as IMMUTABLE: mutating a Cell object that was already
// rendered may make the damage diff skip it. Build new cells instead.
//
// The renderer knows nothing about Neovim (or any application): callers hand
// it fully resolved Cells (see cell.ts) and a cursor position.

import type { CanvasFactory, CanvasLike, Ctx2D } from './canvas-types';
import { Cell, cellKey, reverseCell, hex } from './cell';
import { FontSpec, Metrics, computeMetrics } from './metrics';
import { GlyphAtlas } from './glyph-atlas';
import { CellRasterizer } from './rasterizer';

// How cells are copied from the atlas to the target:
//   * 'drawImage' - drawImage from the sheet canvas. THE fast path in
//     browsers: sheets become GPU-cached textures, blits are texture copies,
//     no per-cell pixel uploads. Default when a DOM/OffscreenCanvas host is
//     detected.
//   * 'imageData' - putImageData of a per-slot pixel copy (cached on the
//     slot). Default outside the DOM: the skia-based Node canvases
//     (@napi-rs/canvas, skia-canvas) RETAIN the pixel payload of every
//     drawImage call - sheet-sourced drawImage there leaks the whole sheet
//     per blitted cell. (The bundled tests/bench use node-canvas/cairo,
//     where both strategies are safe; the conservative default protects
//     other embedders.)
// Both strategies produce identical pixels.
export type BlitStrategy = 'drawImage' | 'imageData';

export interface GridRendererOptions {
  fontFamily?: string;
  fontSizePx?: number;
  // Scratch-canvas factory. Defaults to document.createElement('canvas') /
  // OffscreenCanvas when available; REQUIRED in other hosts (e.g. Node).
  createCanvas?: CanvasFactory;
  // Override any computed metric (cellWidth, cellHeight, baseline, ...).
  metrics?: Partial<Metrics>;
  maxGlyphCacheEntries?: number;
  // Override the auto-detected blit strategy (see BlitStrategy).
  blitStrategy?: BlitStrategy;
}

export interface CursorPos { row: number; col: number }

const DEFAULT_FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';

// prevFlags bits: what non-cell state the painted cell depended on.
const FLAG_CURSOR = 1;  // painted reverse-video as the cursor block
const FLAG_CONT = 2;    // continuation cell covered by a wide glyph's bitmap

function defaultCanvasFactory(): CanvasFactory | null {
  if (typeof document !== 'undefined' && document.createElement) {
    return (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c as unknown as CanvasLike;
    };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return (w, h) => new OffscreenCanvas(w, h) as unknown as CanvasLike;
  }
  return null;
}

// Do two cells produce the same pixels? (Everything cellKey encodes.)
function sameCell(a: Cell, b: Cell): boolean {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg &&
    a.sp === b.sp && (a.width || 1) === (b.width || 1) &&
    !a.bold === !b.bold && !a.italic === !b.italic &&
    !a.underline === !b.underline && !a.undercurl === !b.undercurl &&
    !a.underdouble === !b.underdouble && !a.underdotted === !b.underdotted &&
    !a.underdashed === !b.underdashed && !a.strikethrough === !b.strikethrough;
}

export class GridRenderer {
  readonly metrics: Metrics;
  readonly font: FontSpec;
  // The glyph atlas for single-span cells (wide glyphs get their own,
  // created lazily). Exposed for tests/tuning: hits/misses/size.
  readonly atlas: GlyphAtlas;
  readonly blitStrategy: BlitStrategy;
  cols = 0;
  rows = 0;
  // Blits performed (for tests + perf inspection).
  blitCount = 0;

  private wideAtlas: GlyphAtlas | null = null;
  private readonly createCanvas: CanvasFactory;
  private readonly maxCacheEntries: number | undefined;
  private readonly target: CanvasLike;
  private readonly ctx: Ctx2D;
  private readonly rasterizer: CellRasterizer;
  // What's currently painted, per cell (row-major): the source Cell object
  // (null = unknown, must repaint) + FLAG_* bits it was painted with.
  private prevCells: (Cell | null)[] = [];
  private prevFlags: Uint8Array = new Uint8Array(0);

  constructor(target: CanvasLike, opts?: GridRendererOptions) {
    opts = opts || {};
    this.target = target;
    const ctx = target.getContext('2d');
    if (!ctx) { throw new Error('GridRenderer: target has no 2d context'); }
    this.ctx = ctx;

    const createCanvas = opts.createCanvas || defaultCanvasFactory();
    if (!createCanvas) {
      throw new Error('GridRenderer: no canvas factory available - pass opts.createCanvas');
    }
    this.createCanvas = createCanvas;

    this.font = {
      fontFamily: opts.fontFamily || DEFAULT_FONT_FAMILY,
      fontSizePx: opts.fontSizePx || 16,
    };

    // Measure on a scratch context (the target's size may still be 0x0).
    const probe = createCanvas(1, 1).getContext('2d');
    if (!probe) { throw new Error('GridRenderer: 2d context unavailable'); }
    const computed = computeMetrics(probe, this.font);
    this.metrics = { ...computed, ...(opts.metrics || {}) };

    this.rasterizer = new CellRasterizer(createCanvas, this.font, this.metrics);
    this.maxCacheEntries = opts.maxGlyphCacheEntries;
    this.blitStrategy = opts.blitStrategy ||
      ((typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined')
        ? 'drawImage' : 'imageData');
    this.atlas = new GlyphAtlas(createCanvas, this.metrics.cellWidth, this.metrics.cellHeight,
      this.maxCacheEntries, this.blitStrategy === 'imageData');
  }

  // Size the target canvas for a cols x rows grid (in raw pixels; HiDPI is
  // the embedder's concern - scale fontSizePx by devicePixelRatio and style
  // the canvas element down with CSS).
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const w = cols * this.metrics.cellWidth;
    const h = rows * this.metrics.cellHeight;
    // Setting canvas dimensions clears it; only touch when changed.
    if (this.target.width !== w) { this.target.width = w; }
    if (this.target.height !== h) { this.target.height = h; }
    this.resetPrev();
  }

  // Size the target to an EXACT pixel box (e.g. the element's CSS box *
  // devicePixelRatio) and fit as many whole cells as possible; the leftover
  // margin is painted `bg` when given. Returns the grid size that fits.
  fit(pixelWidth: number, pixelHeight: number, bg?: number): { cols: number; rows: number } {
    this.cols = Math.max(1, Math.floor(pixelWidth / this.metrics.cellWidth));
    this.rows = Math.max(1, Math.floor(pixelHeight / this.metrics.cellHeight));
    const w = Math.max(1, Math.floor(pixelWidth));
    const h = Math.max(1, Math.floor(pixelHeight));
    if (this.target.width !== w) { this.target.width = w; }
    if (this.target.height !== h) { this.target.height = h; }
    this.resetPrev();
    if (typeof bg === 'number') {
      this.ctx.fillStyle = hex(bg);
      this.ctx.fillRect(0, 0, w, h);
    }
    return { cols: this.cols, rows: this.rows };
  }

  get pixelWidth(): number { return this.cols * this.metrics.cellWidth; }
  get pixelHeight(): number { return this.rows * this.metrics.cellHeight; }

  private resetPrev(): void {
    this.prevCells = new Array(this.cols * this.rows).fill(null);
    this.prevFlags = new Uint8Array(this.cols * this.rows);
  }

  // Forget the on-screen state: the next render() repaints every cell.
  invalidate(): void { this.prevCells.fill(null); this.prevFlags.fill(0); }

  // Fill the whole target with a background color (and invalidate).
  clear(bg: number): void {
    this.ctx.fillStyle = hex(bg);
    this.ctx.fillRect(0, 0, this.target.width, this.target.height);
    this.invalidate();
  }

  // Paint one cell immediately.
  drawCell(row: number, col: number, cell: Cell): void {
    this.blit(row, col, cell);
    this.recordPrev(row, col, cell, 0);
  }

  // Paint a full grid, blitting only cells whose rendered identity changed
  // since the last render. `grid` is rows of cells; a row shorter than
  // `cols` leaves the remainder untouched. The cursor cell is painted as a
  // reverse-video block.
  render(grid: Cell[][], cursor?: CursorPos | null): void {
    const rows = Math.min(this.rows, grid.length);
    for (let r = 0; r < rows; r++) {
      const line = grid[r];
      const cols = Math.min(this.cols, line.length);
      for (let c = 0; c < cols; c++) {
        const cell = line[c];
        const wide = cell.width === 2;

        // The cursor: reverse-video block. A cursor sitting on the
        // continuation cell of a wide glyph highlights the whole glyph.
        let isCursor = false;
        if (cursor && cursor.row === r) {
          if (cursor.col === c) { isCursor = true; }
          else if (wide && cursor.col === c + 1) { isCursor = true; }
        }

        const idx = r * this.cols + c;
        const flags = isCursor ? FLAG_CURSOR : 0;
        const prev = this.prevCells[idx];
        const changed = prev === null || this.prevFlags[idx] !== flags ||
          (prev !== cell && !sameCell(prev, cell));
        if (changed) {
          this.blit(r, c, isCursor ? reverseCell(cell) : cell);
          this.prevCells[idx] = cell;
          this.prevFlags[idx] = flags;
          if (wide && c + 1 < this.cols) {
            // The wide bitmap covers the continuation cell; record it so a
            // later narrow cell there repaints.
            this.prevCells[idx + 1] = cell;
            this.prevFlags[idx + 1] = flags | FLAG_CONT;
          }
        }
        if (wide) { c++; }
      }
    }
  }

  private blit(row: number, col: number, cell: Cell): void {
    const wide = cell.width === 2;
    let atlas = this.atlas;
    if (wide) {
      if (!this.wideAtlas) {
        this.wideAtlas = new GlyphAtlas(
          this.createCanvas, this.metrics.cellWidth * 2, this.metrics.cellHeight,
          this.maxCacheEntries, this.blitStrategy === 'imageData');
      }
      atlas = this.wideAtlas;
    }
    const key = cellKey(cell);
    let slot = atlas.get(key);
    if (!slot) { slot = atlas.insert(key, this.rasterizer.rasterize(cell)); }
    const w = atlas.slotWidth, h = atlas.slotHeight;
    const dx = col * this.metrics.cellWidth, dy = row * this.metrics.cellHeight;
    if (this.blitStrategy === 'drawImage') {
      this.ctx.drawImage(slot.sheet, slot.x, slot.y, w, h, dx, dy, w, h);
    } else {
      let img = slot.imageData;
      if (!img) { img = slot.imageData = slot.sheetCtx.getImageData(slot.x, slot.y, w, h); }
      this.ctx.putImageData(img, dx, dy);
    }
    this.blitCount++;
  }

  private recordPrev(row: number, col: number, cell: Cell, flags: number): void {
    const idx = row * this.cols + col;
    if (idx < 0 || idx >= this.prevCells.length) { return; }
    this.prevCells[idx] = cell;
    this.prevFlags[idx] = flags;
    if (cell.width === 2 && col + 1 < this.cols) {
      this.prevCells[idx + 1] = cell;
      this.prevFlags[idx + 1] = flags | FLAG_CONT;
    }
  }
}
