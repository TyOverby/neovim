// SpriteCanvas - a coverage surface for drawing sprite glyphs (box drawing,
// block elements, legacy computing, ...). Port of ghostty's
// src/font/sprite/canvas.zig onto a 2D canvas.
//
// Ghostty draws sprites into an alpha8 surface: each pixel holds a coverage
// value 0..255 which is later multiplied with the foreground color. We
// reproduce that by painting OPAQUE GRAYSCALE onto a black-initialized 2D
// canvas: painting rgb(v,v,v) with source-over compositing overwrites the
// destination exactly like ghostty's putPixel, and antialiased path edges
// blend toward the background just like z2d's rasterizer. The R channel of
// the resulting pixels IS the coverage map, read out via coverage().
//
// Coordinates are cell-local pixels. Ghostty pads its sprite canvases and
// offsets all drawing by (padding_x, padding_y) so antialiasing can bleed
// outside the cell; we render exactly cell-sized bitmaps (blitted with
// putImageData, no compositing), so padding is fixed at 0 and the clip_*
// fields - which ghostty's draw code only ever sets to the padding, i.e.
// "clip to the cell box" - are applied by coverage() (they default to 0 =
// no-op, but stay settable for fidelity with the ported code).

import type { CanvasFactory, CanvasLike, Ctx2D } from './canvas-types';

export interface Point { x: number; y: number }
export interface Line { p0: Point; p1: Point }
export interface Triangle { p0: Point; p1: Point; p2: Point }
export interface Quad { p0: Point; p1: Point; p2: Point; p3: Point }
export interface Rect { x: number; y: number; width: number; height: number }

// Coverage shades (ghostty's Shade / Color enum values).
export const SHADE_OFF = 0x00;
export const SHADE_LIGHT = 0x40;
export const SHADE_MEDIUM = 0x80;
export const SHADE_DARK = 0xc0;
export const SHADE_ON = 0xff;

export type LineCap = 'butt' | 'round' | 'square';

export interface StrokeOpts {
  width: number;
  cap?: LineCap;
}

type PathOp =
  | { op: 'move'; x: number; y: number }
  | { op: 'line'; x: number; y: number }
  | { op: 'curve'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: 'arc'; x: number; y: number; r: number; a0: number; a1: number }
  | { op: 'close' };

// Recorded path (ghostty's z2d StaticPath equivalent): build with
// moveTo/lineTo/curveTo/arc/close, then hand to fillPath / strokePath /
// innerStrokePath. Recording (rather than drawing straight to the context)
// lets innerStrokePath replay the same path twice (clip + stroke).
export class PathBuilder {
  ops: PathOp[] = [];
  moveTo(x: number, y: number): void { this.ops.push({ op: 'move', x, y }); }
  lineTo(x: number, y: number): void { this.ops.push({ op: 'line', x, y }); }
  // Cubic bezier (z2d curveTo).
  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.ops.push({ op: 'curve', c1x, c1y, c2x, c2y, x, y });
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.ops.push({ op: 'arc', x, y, r, a0, a1 });
  }
  close(): void { this.ops.push({ op: 'close' }); }
}

function shadeStyle(shade: number): string {
  const v = Math.max(0, Math.min(255, Math.round(shade))) | 0;
  return 'rgb(' + v + ',' + v + ',' + v + ')';
}

export class SpriteCanvas {
  readonly width: number;
  readonly height: number;

  // Ghostty-compat fields (see the header comment): padding is always 0.
  readonly paddingX = 0;
  readonly paddingY = 0;
  clipTop = 0;
  clipBottom = 0;
  clipLeft = 0;
  clipRight = 0;

  private readonly ctx: Ctx2D;
  private readonly surface: CanvasLike;

  constructor(createCanvas: CanvasFactory, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.surface = createCanvas(width, height);
    const ctx = this.surface.getContext('2d');
    if (!ctx) { throw new Error('SpriteCanvas: 2d context unavailable'); }
    this.ctx = ctx;
    // Black-fill so every pixel starts opaque (coverage 0) - keeps the
    // surface alpha-free, which makes invert()/flips exact.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
  }

  // Overwrite a single pixel with a coverage value.
  pixel(x: number, y: number, shade: number): void {
    this.ctx.fillStyle = shadeStyle(shade);
    this.ctx.fillRect(x, y, 1, 1);
  }

  // Fill a rect given as {x, y, width, height} (pixel-exact, no AA).
  rect(v: Rect, shade: number): void {
    this.ctx.fillStyle = shadeStyle(shade);
    this.ctx.fillRect(v.x, v.y, v.width, v.height);
  }

  // Fill the rect spanned by two corner points (either order).
  box(x0: number, y0: number, x1: number, y1: number, shade: number): void {
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    this.rect({ x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }, shade);
  }

  quad(q: Quad, shade: number): void {
    const p = new PathBuilder();
    p.moveTo(q.p0.x, q.p0.y);
    p.lineTo(q.p1.x, q.p1.y);
    p.lineTo(q.p2.x, q.p2.y);
    p.lineTo(q.p3.x, q.p3.y);
    p.close();
    this.fillPath(p, shade);
  }

  triangle(t: Triangle, shade: number): void {
    const p = new PathBuilder();
    p.moveTo(t.p0.x, t.p0.y);
    p.lineTo(t.p1.x, t.p1.y);
    p.lineTo(t.p2.x, t.p2.y);
    p.close();
    this.fillPath(p, shade);
  }

  line(l: Line, thickness: number, shade: number): void {
    const p = new PathBuilder();
    p.moveTo(l.p0.x, l.p0.y);
    p.lineTo(l.p1.x, l.p1.y);
    this.strokePath(p, { width: thickness, cap: 'butt' }, shade);
  }

  // Ghostty's canvas.staticPath(len) - the length is a Zig comptime detail.
  path(): PathBuilder { return new PathBuilder(); }

  private replay(p: PathBuilder): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const op of p.ops) {
      switch (op.op) {
      case 'move': ctx.moveTo(op.x, op.y); break;
      case 'line': ctx.lineTo(op.x, op.y); break;
      case 'curve': ctx.bezierCurveTo(op.c1x, op.c1y, op.c2x, op.c2y, op.x, op.y); break;
      case 'arc': ctx.arc(op.x, op.y, op.r, op.a0, op.a1); break;
      case 'close': ctx.closePath(); break;
      }
    }
  }

  fillPath(p: PathBuilder, shade: number): void {
    this.replay(p);
    this.ctx.fillStyle = shadeStyle(shade);
    this.ctx.fill();
  }

  strokePath(p: PathBuilder, opts: StrokeOpts, shade: number): void {
    this.replay(p);
    this.ctx.strokeStyle = shadeStyle(shade);
    this.ctx.lineWidth = opts.width;
    this.ctx.lineCap = opts.cap || 'butt';
    this.ctx.stroke();
  }

  // Stroke only the part of the stroke that falls INSIDE the (closed) path:
  // clip to the path, then stroke at double width. Equivalent to ghostty's
  // fill-mask x double-stroke composite.
  innerStrokePath(p: PathBuilder, opts: StrokeOpts, shade: number): void {
    const ctx = this.ctx;
    ctx.save();
    this.replay(p);
    ctx.clip();
    this.replay(p);
    ctx.strokeStyle = shadeStyle(shade);
    ctx.lineWidth = opts.width * 2;
    ctx.lineCap = opts.cap || 'butt';
    ctx.stroke();
    ctx.restore();
  }

  // Invert coverage across the whole surface (used by "inverse" glyphs).
  invert(): void {
    const img = this.ctx.getImageData(0, 0, this.width, this.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
      d[i + 3] = 255;
    }
    this.ctx.putImageData(img, 0, 0);
  }

  flipHorizontal(): void { this.flip(true); }
  flipVertical(): void { this.flip(false); }

  private flip(horizontal: boolean): void {
    const img = this.ctx.getImageData(0, 0, this.width, this.height);
    const src = img.data.slice();
    const d = img.data;
    const w = this.width, h = this.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = horizontal ? (w - 1 - x) : x;
        const sy = horizontal ? y : (h - 1 - y);
        const si = (sy * w + sx) * 4, di = (y * w + x) * 4;
        d[di] = src[si]; d[di + 1] = src[si + 1]; d[di + 2] = src[si + 2]; d[di + 3] = 255;
      }
    }
    this.ctx.putImageData(img, 0, 0);
  }

  // The coverage map (0..255 per pixel, row-major), with the clip_* margins
  // applied (coverage forced to 0 outside the clip box).
  coverage(): Uint8ClampedArray {
    const img = this.ctx.getImageData(0, 0, this.width, this.height);
    const d = img.data;
    const out = new Uint8ClampedArray(this.width * this.height);
    for (let i = 0; i < out.length; i++) { out[i] = d[i * 4]; }
    if (this.clipTop || this.clipBottom || this.clipLeft || this.clipRight) {
      const x0 = this.clipLeft, x1 = this.width - this.clipRight;
      const y0 = this.clipTop, y1 = this.height - this.clipBottom;
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          if (x < x0 || x >= x1 || y < y0 || y >= y1) { out[y * this.width + x] = 0; }
        }
      }
    }
    return out;
  }
}
