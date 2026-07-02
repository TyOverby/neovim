// A bounded LRU cache from cell identity (cellKey) to the rendered bitmap
// (ImageData, ready for putImageData).
//
// Bitmaps are cached fully colorized - keyed by (text, fg, bg, sp, style,
// width) - NOT as alpha masks composited at draw time. Rebuilding fg-on-bg
// via alpha compositing does not reproduce the subpixel-antialiased pixels
// the font rasterizer produces for that exact color pair, so we deliberately
// trade cache size for fidelity and blit with putImageData (no compositing).

import type { ImageDataLike } from './canvas-types';

export class GlyphCache {
  private map = new Map<string, ImageDataLike>();
  readonly maxEntries: number;
  // Rasterizations avoided / performed (for tests + tuning).
  hits = 0;
  misses = 0;

  constructor(maxEntries?: number) {
    this.maxEntries = maxEntries && maxEntries > 0 ? maxEntries : 8192;
  }

  get(key: string): ImageDataLike | undefined {
    const v = this.map.get(key);
    if (v === undefined) { return undefined; }
    // Refresh recency (Map preserves insertion order; oldest is first).
    this.map.delete(key);
    this.map.set(key, v);
    this.hits++;
    return v;
  }

  set(key: string, value: ImageDataLike): void {
    this.misses++;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) { this.map.delete(oldest.value); }
    }
    this.map.set(key, value);
  }

  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); this.hits = 0; this.misses = 0; }
}
