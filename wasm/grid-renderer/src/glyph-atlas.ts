// GlyphAtlas - a bounded LRU cache from cell identity (cellKey) to a slot in
// a sprite-sheet canvas, blitted with drawImage.
//
// This replaces an earlier ImageData + putImageData design. Two reasons:
//   * putImageData is a worst-case canvas API in browsers: every call uploads
//     pixels from CPU memory, bypassing the GPU-cached fast path. drawImage
//     from a canvas stays on the GPU (the sheets become cached textures), so
//     a full-screen scroll is thousands of texture copies instead of
//     thousands of pixel uploads.
//   * Recency used to be maintained by Map delete + re-insert per lookup,
//     which profiled as ~half the frame under V8. Slots here are nodes of an
//     intrusive doubly-linked LRU list: get() relinks pointers, no Map writes.
//
// Slots are fixed-size (one cell span), packed into sheet canvases of ~1024px
// a side, created lazily up to maxEntries slots; once full, the LRU slot's
// key is evicted and its pixels overwritten in place. Glyphs are cached fully
// colorized - keyed by the exact (text, fg, bg, sp, style, width) identity,
// NOT as alpha masks composited at draw time - deliberately trading cache
// size for subpixel-antialiasing fidelity (see rasterizer.ts).

import type { CanvasFactory, CanvasLike, Ctx2D, ImageDataLike } from './canvas-types';

// Target sheet side in px (rounded down to whole slots).
const SHEET_PX = 1024;

export interface AtlasSlot {
  key: string;
  // Source rect for drawImage: the sheet canvas + top-left corner.
  sheet: CanvasLike;
  sheetCtx: Ctx2D;
  x: number;
  y: number;
  // Lazily filled pixel copy for the 'imageData' blit strategy (see
  // renderer.ts); reset whenever the slot is (re)filled.
  imageData: ImageDataLike | null;
  // Intrusive LRU links (newer <-> older).
  newer: AtlasSlot | null;
  older: AtlasSlot | null;
}

export class GlyphAtlas {
  readonly slotWidth: number;
  readonly slotHeight: number;
  readonly maxEntries: number;
  // Rasterizations avoided / performed (for tests + tuning).
  hits = 0;
  misses = 0;

  private readonly createCanvas: CanvasFactory;
  private readonly map = new Map<string, AtlasSlot>();
  private readonly sheets: { canvas: CanvasLike; ctx: Ctx2D }[] = [];
  private readonly sheetCols: number;
  private readonly sheetRows: number;
  // Total slots allocated so far (also the index of the next fresh slot).
  private allocated = 0;
  private newest: AtlasSlot | null = null;
  private oldest: AtlasSlot | null = null;

  // `readBack` hints that sheet pixels will be read with getImageData (the
  // 'imageData' blit strategy) so sheets should stay CPU-side.
  private readonly readBack: boolean;

  constructor(createCanvas: CanvasFactory, slotWidth: number, slotHeight: number, maxEntries?: number, readBack?: boolean) {
    this.readBack = !!readBack;
    this.createCanvas = createCanvas;
    this.slotWidth = Math.max(1, slotWidth);
    this.slotHeight = Math.max(1, slotHeight);
    this.maxEntries = maxEntries && maxEntries > 0 ? maxEntries : 4096;
    this.sheetCols = Math.max(1, Math.floor(SHEET_PX / this.slotWidth));
    this.sheetRows = Math.max(1, Math.floor(SHEET_PX / this.slotHeight));
  }

  get size(): number { return this.map.size; }

  // The slot for `key`, refreshed as most-recently-used; undefined on miss.
  get(key: string): AtlasSlot | undefined {
    const slot = this.map.get(key);
    if (slot === undefined) { return undefined; }
    this.hits++;
    this.touch(slot);
    return slot;
  }

  // Claim a slot for `key` (evicting the LRU slot when full) and copy the
  // slot-sized `src` canvas into it. Returns the filled slot.
  insert(key: string, src: CanvasLike): AtlasSlot {
    this.misses++;
    let slot: AtlasSlot;
    if (this.allocated < this.maxEntries) {
      slot = this.allocSlot(key);
      this.linkNewest(slot);
    } else {
      // Reuse the least-recently-used slot's pixels in place.
      slot = this.oldest!;
      this.map.delete(slot.key);
      slot.key = key;
      this.touch(slot);
    }
    slot.imageData = null;
    this.map.set(key, slot);
    slot.sheetCtx.drawImage(src, 0, 0, this.slotWidth, this.slotHeight, slot.x, slot.y, this.slotWidth, this.slotHeight);
    return slot;
  }

  clear(): void {
    this.map.clear();
    this.newest = null;
    this.oldest = null;
    this.allocated = 0;
    this.hits = 0;
    this.misses = 0;
    // Sheets are kept (their pixels are garbage until slots are re-filled).
  }

  private allocSlot(key: string): AtlasSlot {
    const perSheet = this.sheetCols * this.sheetRows;
    const idx = this.allocated++;
    const sheetIdx = Math.floor(idx / perSheet);
    while (this.sheets.length <= sheetIdx) {
      const canvas = this.createCanvas(this.sheetCols * this.slotWidth, this.sheetRows * this.slotHeight);
      const ctx = this.readBack ? canvas.getContext('2d', { willReadFrequently: true }) : canvas.getContext('2d');
      if (!ctx) { throw new Error('GlyphAtlas: 2d context unavailable'); }
      this.sheets.push({ canvas, ctx });
    }
    const within = idx % perSheet;
    return {
      key,
      sheet: this.sheets[sheetIdx].canvas,
      sheetCtx: this.sheets[sheetIdx].ctx,
      x: (within % this.sheetCols) * this.slotWidth,
      y: Math.floor(within / this.sheetCols) * this.slotHeight,
      imageData: null,
      newer: null,
      older: null,
    };
  }

  // Move to the newest end of the LRU list (O(1) pointer relink).
  private touch(slot: AtlasSlot): void {
    if (this.newest === slot) { return; }
    // Unlink.
    if (slot.newer) { slot.newer.older = slot.older; }
    if (slot.older) { slot.older.newer = slot.newer; }
    if (this.oldest === slot) { this.oldest = slot.newer; }
    // Relink at the newest end.
    slot.older = this.newest;
    slot.newer = null;
    if (this.newest) { this.newest.newer = slot; }
    this.newest = slot;
    if (!this.oldest) { this.oldest = slot; }
  }

  private linkNewest(slot: AtlasSlot): void {
    slot.older = this.newest;
    slot.newer = null;
    if (this.newest) { this.newest.newer = slot; }
    this.newest = slot;
    if (!this.oldest) { this.oldest = slot; }
  }
}
