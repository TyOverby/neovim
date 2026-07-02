// GridRenderer - paints a character grid onto a target canvas.
//
// Rendering model:
//   * Every distinct (text, fg, bg, sp, style, width) cell is rasterized ONCE
//     (CellRasterizer) into an ImageData bitmap and kept in a bounded LRU
//     (GlyphCache). Cells are painted by blitting that bitmap with
//     putImageData - no per-frame text shaping, no compositing.
//   * render(grid) diffs against the previously rendered keys and only blits
//     cells that changed (plus the cursor's old/new positions).
//
// The renderer knows nothing about Neovim (or any application): callers hand
// it fully resolved Cells (see cell.ts) and a cursor position.

import type { CanvasFactory, CanvasLike, Ctx2D } from './canvas-types';
import { Cell, cellKey, reverseCell, hex } from './cell';
import { FontSpec, Metrics, computeMetrics } from './metrics';
import { GlyphCache } from './glyph-cache';
import { CellRasterizer } from './rasterizer';

export interface GridRendererOptions {
  fontFamily?: string;
  fontSizePx?: number;
  // Scratch-canvas factory. Defaults to document.createElement('canvas') /
  // OffscreenCanvas when available; REQUIRED in other hosts (e.g. Node).
  createCanvas?: CanvasFactory;
  // Override any computed metric (cellWidth, cellHeight, baseline, ...).
  metrics?: Partial<Metrics>;
  maxGlyphCacheEntries?: number;
}

export interface CursorPos { row: number; col: number }

const DEFAULT_FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';

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

export class GridRenderer {
  readonly metrics: Metrics;
  readonly font: FontSpec;
  readonly cache: GlyphCache;
  cols = 0;
  rows = 0;
  // putImageData blits performed (for tests + perf inspection).
  blitCount = 0;

  private readonly target: CanvasLike;
  private readonly ctx: Ctx2D;
  private readonly rasterizer: CellRasterizer;
  // cellKey (+ cursor marker) of what's currently on screen, row-major;
  // null = unknown (must repaint).
  private prevKeys: (string | null)[] = [];

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
    this.cache = new GlyphCache(opts.maxGlyphCacheEntries);
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
    this.prevKeys = new Array(cols * rows).fill(null);
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
    this.prevKeys = new Array(this.cols * this.rows).fill(null);
    if (typeof bg === 'number') {
      this.ctx.fillStyle = hex(bg);
      this.ctx.fillRect(0, 0, w, h);
    }
    return { cols: this.cols, rows: this.rows };
  }

  get pixelWidth(): number { return this.cols * this.metrics.cellWidth; }
  get pixelHeight(): number { return this.rows * this.metrics.cellHeight; }

  // Forget the on-screen state: the next render() repaints every cell.
  invalidate(): void { this.prevKeys.fill(null); }

  // Fill the whole target with a background color (and invalidate).
  clear(bg: number): void {
    this.ctx.fillStyle = hex(bg);
    this.ctx.fillRect(0, 0, this.target.width, this.target.height);
    this.invalidate();
  }

  // Paint one cell immediately (no damage tracking bookkeeping beyond
  // recording the key).
  drawCell(row: number, col: number, cell: Cell): void {
    this.blit(row, col, cell, cellKey(cell));
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
        let cell = line[c];
        const wide = cell.width === 2;

        // The cursor: reverse-video block. A cursor sitting on the
        // continuation cell of a wide glyph highlights the whole glyph.
        let isCursor = false;
        if (cursor && cursor.row === r) {
          if (cursor.col === c) { isCursor = true; }
          else if (wide && cursor.col === c + 1) { isCursor = true; }
        }
        if (isCursor) { cell = reverseCell(cell); }

        const key = cellKey(cell) + (isCursor ? '|CUR' : '');
        const idx = r * this.cols + c;
        if (this.prevKeys[idx] !== key) {
          this.blit(r, c, cell, key);
          this.prevKeys[idx] = key;
        }
        if (wide) {
          // The wide bitmap covers the continuation cell; record it so a
          // later narrow cell there repaints.
          if (c + 1 < this.cols) { this.prevKeys[idx + 1] = key + '|cont'; }
          c++;
        }
      }
    }
  }

  private blit(row: number, col: number, cell: Cell, key: string): void {
    let img = this.cache.get(cellKey(cell));
    if (!img) {
      img = this.rasterizer.rasterize(cell);
      this.cache.set(cellKey(cell), img);
    }
    this.ctx.putImageData(img, col * this.metrics.cellWidth, row * this.metrics.cellHeight);
    this.blitCount++;
    const idx = row * this.cols + col;
    if (idx >= 0 && idx < this.prevKeys.length) { this.prevKeys[idx] = key; }
  }
}
