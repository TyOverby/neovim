// CellRasterizer - renders one cell (glyph + colors + decorations) into a
// scratch canvas. The GridRenderer copies the result into its GlyphAtlas and
// blits cells from there with drawImage.
//
// Two rasterization paths:
//   * Sprite glyphs (box drawing, block elements, braille, legacy computing,
//     powerline, ...; see draw/registry.ts): drawn as PATHS via the ported
//     ghostty draw functions into a coverage map, then colorized per-pixel as
//     bg + coverage * (fg - bg). Pixel-perfect cell-filling geometry -
//     independent of the font - so adjacent cells connect seamlessly.
//   * Everything else: the font renders the glyph (fillText) in the exact
//     fg-on-bg color pair, preserving whatever subpixel/antialiasing choices
//     the host's text rasterizer makes for those colors.
//
// Decorations (underline variants, strikethrough) are baked into the bitmap
// on top of either path.

import type { CanvasFactory, CanvasLike, Ctx2D, ImageDataLike } from './canvas-types';
import type { Cell } from './cell';
import { hex } from './cell';
import { FontSpec, Metrics, cssFont } from './metrics';
import { SpriteCanvas } from './sprite-canvas';
import { findDraw } from './draw/registry';

export class CellRasterizer {
  private readonly createCanvas: CanvasFactory;
  private readonly font: FontSpec;
  private readonly metrics: Metrics;
  // Scratch surfaces per cell-span (1 and 2 columns), reused across cells.
  private scratch: (Ctx2D | null)[] = [null, null];

  constructor(createCanvas: CanvasFactory, font: FontSpec, metrics: Metrics) {
    this.createCanvas = createCanvas;
    this.font = font;
    this.metrics = metrics;
  }

  // Render `cell` to a (width * cellWidth) x cellHeight scratch canvas. The
  // return value is valid only until the next rasterize() call (the scratch
  // is reused) - copy it out (e.g. GlyphAtlas.insert) before rasterizing again.
  rasterize(cell: Cell): CanvasLike {
    const m = this.metrics;
    const span = cell.width === 2 ? 2 : 1;
    const w = m.cellWidth * span;
    const h = m.cellHeight;

    const cp = firstCodepoint(cell.text);
    const draw = cp !== null ? findDraw(cp) : null;

    const ctx = this.scratchCtx(span, w, h);

    // Background.
    ctx.fillStyle = hex(cell.bg);
    ctx.fillRect(0, 0, w, h);

    if (draw && isSingleGlyph(cell.text, cp!)) {
      // Sprite path: coverage -> colorize onto the bg.
      const sprite = new SpriteCanvas(this.createCanvas, w, h);
      draw(cp!, sprite, w, h, m);
      const cov = sprite.coverage();
      const img = ctx.getImageData(0, 0, w, h);
      colorizeOver(img, cov, cell.fg);
      ctx.putImageData(img, 0, 0);
    } else if (cell.text && cell.text !== ' ') {
      ctx.font = cssFont(this.font, cell.bold, cell.italic);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = hex(cell.fg);
      // Single-width glyphs sit at the cell origin (the font's own advance
      // and bearings position them); double-width glyphs are centered in
      // their two-cell span in case the font's advance differs from ours.
      let x = 0;
      if (span === 2) {
        const tw = ctx.measureText(cell.text).width;
        x = Math.max(0, (w - tw) / 2);
      }
      ctx.fillText(cell.text, x, m.baseline);
    }

    this.decorate(ctx, cell, w);
    return ctx.canvas;
  }

  private scratchCtx(span: 1 | 2, w: number, h: number): Ctx2D {
    let ctx = this.scratch[span - 1];
    if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) {
      const c = this.createCanvas(w, h);
      // The sprite path reads pixels back (colorize); hint the browser to
      // keep this scratch surface CPU-side.
      ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) { throw new Error('CellRasterizer: 2d context unavailable'); }
      this.scratch[span - 1] = ctx;
    }
    return ctx;
  }

  // Underline variants + strikethrough, in the special color (sp, default fg).
  private decorate(ctx: Ctx2D, cell: Cell, w: number): void {
    const m = this.metrics;
    const spColor = hex(typeof cell.sp === 'number' ? cell.sp : cell.fg);
    const thick = m.underlineThickness;
    const pos = m.underlinePosition;

    if (cell.underline) {
      ctx.fillStyle = spColor;
      ctx.fillRect(0, pos, w, thick);
    }
    if (cell.underdouble) {
      ctx.fillStyle = spColor;
      // Two lines: at the underline position and one gap below, the second
      // clamped inside the cell.
      const y2 = Math.min(m.cellHeight - thick, pos + 2 * thick);
      ctx.fillRect(0, Math.max(0, y2 - 4 * thick + 2 * thick), w, thick);
      ctx.fillRect(0, y2, w, thick);
    }
    if (cell.underdotted) {
      ctx.fillStyle = spColor;
      // Dot-gap-dot at the underline position; period 2*thick so it tiles.
      for (let x = 0; x < w; x += 2 * thick) {
        ctx.fillRect(x, pos, Math.min(thick, w - x), thick);
      }
    }
    if (cell.underdashed) {
      ctx.fillStyle = spColor;
      // Dash 1/3 gap 1/6 dash 1/3 gap 1/6 per cell, tileable.
      const dash = Math.max(2 * thick, Math.floor(w / 3));
      for (let x = 0; x < w; x += dash + Math.max(thick, Math.floor(dash / 2))) {
        ctx.fillRect(x, pos, Math.min(dash, w - x), thick);
      }
    }
    if (cell.undercurl) {
      // One full sine-ish period per cell so adjacent cells tile seamlessly:
      // midline -> peak -> midline -> trough -> midline via quadratics.
      ctx.strokeStyle = spColor;
      ctx.lineWidth = thick;
      ctx.lineCap = 'butt';
      const amp = Math.max(1, thick);
      // Center the wave on the underline stem, clamped inside the cell.
      const yMid = Math.min(m.cellHeight - amp - Math.ceil(thick / 2), pos + Math.floor(thick / 2));
      ctx.beginPath();
      ctx.moveTo(0, yMid);
      ctx.quadraticCurveTo(w * 0.25, yMid - 2 * amp, w * 0.5, yMid);
      ctx.quadraticCurveTo(w * 0.75, yMid + 2 * amp, w, yMid);
      ctx.stroke();
    }
    if (cell.strikethrough) {
      ctx.fillStyle = spColor;
      ctx.fillRect(0, m.strikethroughPosition, w, m.strikethroughThickness);
    }
  }
}

// The first codepoint of the cell text, or null for empty text.
function firstCodepoint(text: string): number | null {
  if (!text) { return null; }
  const cp = text.codePointAt(0);
  return cp === undefined ? null : cp;
}

// Sprite drawing applies only when the cell is exactly one codepoint (no
// combining marks riding on a box-drawing char).
function isSingleGlyph(text: string, cp: number): boolean {
  return text.length === (cp > 0xffff ? 2 : 1);
}

// img = img + coverage * (fg - img), i.e. fg painted over the existing
// pixels with per-pixel coverage as alpha. Exactly ghostty's model of an
// alpha8 sprite atlas colorized by the foreground.
function colorizeOver(img: ImageDataLike, cov: Uint8ClampedArray, fg: number): void {
  const fr = (fg >> 16) & 0xff, fgG = (fg >> 8) & 0xff, fb = fg & 0xff;
  const d = img.data;
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i];
    if (a === 0) { continue; }
    const o = i * 4;
    if (a === 255) {
      d[o] = fr; d[o + 1] = fgG; d[o + 2] = fb; d[o + 3] = 255;
      continue;
    }
    const inv = 255 - a;
    d[o] = (d[o] * inv + fr * a + 127) / 255;
    d[o + 1] = (d[o + 1] * inv + fgG * a + 127) / 255;
    d[o + 2] = (d[o + 2] * inv + fb * a + 127) / 255;
    d[o + 3] = 255;
  }
}
