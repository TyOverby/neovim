// Cell metrics: the pixel geometry every glyph is rasterized against.
//
// Field semantics follow ghostty's font.Metrics (the sprite draw code ported
// from ghostty reads them the same way): positions are measured in pixels
// from the TOP of the cell, thicknesses in pixels.

import type { Ctx2D } from './canvas-types';

export interface Metrics {
  cellWidth: number;
  cellHeight: number;
  // Distance from the top of the cell to the alphabetic baseline.
  baseline: number;
  // Base thickness for box-drawing / sprite strokes ("light" lines).
  boxThickness: number;
  // Top edge of the underline, from the top of the cell.
  underlinePosition: number;
  underlineThickness: number;
  // Top edge of the strikethrough, from the top of the cell.
  strikethroughPosition: number;
  strikethroughThickness: number;
  // Top edge of the overline (0 = top of cell).
  overlinePosition: number;
  overlineThickness: number;
  cursorThickness: number;
}

export interface FontSpec {
  fontFamily: string;
  // Font size in px. All metrics derive from this + real font measurements.
  fontSizePx: number;
}

// Build the canvas `font` string for a cell style.
export function cssFont(spec: FontSpec, bold?: boolean, italic?: boolean): string {
  return (italic ? 'italic ' : '') + (bold ? 'bold ' : '') +
    spec.fontSizePx + 'px ' + spec.fontFamily;
}

// Measure a font on a scratch context and derive full cell metrics.
//
// The cell box is the font's advance width x (ascent + descent), the
// convention terminals use. Fonts with missing fontBoundingBox metrics fall
// back to the usual 1.2 line-height ratio. Every value is integer px so the
// grid never accumulates subpixel error.
export function computeMetrics(ctx: Ctx2D, spec: FontSpec): Metrics {
  ctx.font = cssFont(spec);
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('M');
  const size = spec.fontSizePx;

  const ascent = (typeof m.fontBoundingBoxAscent === 'number' && m.fontBoundingBoxAscent > 0)
    ? m.fontBoundingBoxAscent : size * 0.8;
  const descent = (typeof m.fontBoundingBoxDescent === 'number' && m.fontBoundingBoxDescent > 0)
    ? m.fontBoundingBoxDescent : size * 0.2;

  const cellWidth = Math.max(1, Math.round(m.width));
  const cellHeight = Math.max(1, Math.round(ascent + descent));
  const baseline = Math.round(ascent);

  // ~1/12 of the font size reads like a terminal "light" stroke; never 0.
  const thick = Math.max(1, Math.round(size / 12));

  return {
    cellWidth,
    cellHeight,
    baseline,
    boxThickness: thick,
    underlinePosition: Math.min(cellHeight - thick, baseline + Math.max(1, Math.round(descent * 0.3))),
    underlineThickness: thick,
    strikethroughPosition: Math.round(baseline - size * 0.25),
    strikethroughThickness: thick,
    overlinePosition: 0,
    overlineThickness: thick,
    cursorThickness: thick,
  };
}
