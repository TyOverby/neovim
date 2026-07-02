// The renderer's cell model. Application-agnostic: anything that can express
// its screen as a grid of styled single-width/double-width glyphs (a terminal,
// Neovim's ext_linegrid, ...) can drive the renderer with these.

export interface Cell {
  // The cell's text (usually one glyph; may be a cluster with combining
  // marks). '' or ' ' render as background only. For a double-width glyph,
  // set width: 2 and leave the FOLLOWING cell's text as '' (the convention
  // both terminals and Neovim's ext_linegrid use).
  text: string;
  // 24-bit 0xRRGGBB colors, already fully resolved by the caller (reverse
  // video, palette lookups, defaults - all applied before we see the cell).
  fg: number;
  bg: number;
  // Color for underline decorations; defaults to fg.
  sp?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
  strikethrough?: boolean;
  // Number of grid columns this glyph spans (default 1).
  width?: 1 | 2;
}

// Bit-pack the style booleans (cache-key + fast comparisons).
export function styleBits(c: Cell): number {
  return (c.bold ? 1 : 0) | (c.italic ? 2 : 0) | (c.underline ? 4 : 0) |
    (c.undercurl ? 8 : 0) | (c.underdouble ? 16 : 0) | (c.underdotted ? 32 : 0) |
    (c.underdashed ? 64 : 0) | (c.strikethrough ? 128 : 0);
}

// The full identity of a cell's rendered bitmap. Two cells with the same key
// produce identical pixels, so this is the glyph-cache key.
export function cellKey(c: Cell): string {
  const sp = (typeof c.sp === 'number') ? c.sp : c.fg;
  return c.text + '|' + c.fg + '|' + c.bg + '|' + sp + '|' + styleBits(c) + '|' + (c.width || 1);
}

// The same cell with fg/bg swapped - a solid block cursor.
export function reverseCell(c: Cell): Cell {
  const r: Cell = { ...c, fg: c.bg, bg: c.fg };
  if (typeof c.sp === 'number') { r.sp = c.sp; }
  return r;
}

// 24-bit int -> '#rrggbb'.
export function hex(n: number): string {
  const s = (n & 0xffffff).toString(16);
  return '#' + '000000'.slice(s.length) + s;
}
