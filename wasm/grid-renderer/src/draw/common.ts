// Shared helpers for the sprite draw functions. Port of ghostty's
// src/font/sprite/draw/common.zig.
//
// Porting conventions used across the draw/ modules (KEEP THESE):
//   * Zig integer division  a / b     ->  idiv(a, b)   (truncating)
//   * Zig saturating sub    a -| b    ->  satSub(a, b) (floors at 0)
//   * Zig @round (half away from 0)   ->  round(x)
//   * Zig @intFromFloat (truncate)    ->  Math.trunc(x)
//   * ghostty Shade/Color enum        ->  SHADE_* constants (sprite-canvas)
//   * canvas.padding_x / padding_y    ->  0 (we render exactly cell-sized)

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON } from '../sprite-canvas';

// A draw function for one codepoint (possibly one of a range). `width` and
// `height` are the pixel dimensions of the canvas being drawn into (usually
// one cell; two cells wide for wide sprites).
export type DrawFn = (
  cp: number,
  canvas: SpriteCanvas,
  width: number,
  height: number,
  metrics: Metrics,
) => void;

// Zig-semantics helpers ----------------------------------------------------

// Truncating integer division (Zig `/` on integers).
export function idiv(a: number, b: number): number { return Math.trunc(a / b); }
// Saturating subtraction on unsigned values (Zig `-|`).
export function satSub(a: number, b: number): number { return Math.max(0, a - b); }
// Round half away from zero (Zig @round; JS Math.round rounds half toward +inf).
export function round(x: number): number { return Math.sign(x) * Math.round(Math.abs(x)); }

// Utility names for common fractions.
export const one_eighth = 0.125;
export const one_quarter = 0.25;
export const one_third = 1.0 / 3.0;
export const three_eighths = 0.375;
export const half = 0.5;
export const five_eighths = 0.625;
export const two_thirds = 2.0 / 3.0;
export const three_quarters = 0.75;
export const seven_eighths = 0.875;

// The thickness of a line.
export type Thickness = 'super_light' | 'light' | 'heavy';

// Real height in px of a line of the given thickness, from the base
// thickness (metrics.boxThickness).
export function thicknessHeight(t: Thickness, base: number): number {
  switch (t) {
  case 'super_light': return Math.max(idiv(base, 2), 1);
  case 'light': return base;
  case 'heavy': return base * 2;
  }
}

// Features that may be present or not in each quadrant.
export interface Quads { tl?: boolean; tr?: boolean; bl?: boolean; br?: boolean }

export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export type Edge = 'top' | 'left' | 'bottom' | 'right';

// Alignment of a figure within a cell.
export interface Alignment {
  horizontal: 'left' | 'right' | 'center';
  vertical: 'top' | 'bottom' | 'middle';
}
export const ALIGN: Record<string, Alignment> = {
  upper: { horizontal: 'center', vertical: 'top' },
  lower: { horizontal: 'center', vertical: 'bottom' },
  left: { horizontal: 'left', vertical: 'middle' },
  right: { horizontal: 'right', vertical: 'middle' },
  upper_left: { horizontal: 'left', vertical: 'top' },
  upper_right: { horizontal: 'right', vertical: 'top' },
  lower_left: { horizontal: 'left', vertical: 'bottom' },
  lower_right: { horizontal: 'right', vertical: 'bottom' },
  center: { horizontal: 'center', vertical: 'middle' },
};

// A fraction across the cell, horizontally or vertically. Ghostty models
// this as an enum with many semantic names; we use the numeric fraction
// directly plus the same min/max rounding rules.
export type Fraction = number;

export const eighths: Fraction[] = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
export const quarters: Fraction[] = [0, 0.25, 0.5, 0.75, 1];
export const thirds: Fraction[] = [0, 1.0 / 3.0, 2.0 / 3.0, 1];
export const halves: Fraction[] = [0, 0.5, 1];

// Position of the fraction across `size` when used as the MIN (left/top)
// coordinate of a block. Complementary rounding vs. fracMax so adjacent
// blocks butt together without gaps or overlap (see ghostty for the details).
export function fracMin(frac: Fraction, size: number): number {
  return Math.trunc(size - round((1.0 - frac) * size));
}
// Position when used as the MAX (right/bottom) coordinate of a block.
export function fracMax(frac: Fraction, size: number): number {
  return Math.trunc(round(frac * size));
}
// The unrounded position, for path drawing.
export function fracFloat(frac: Fraction, size: number): number {
  return frac * size;
}

// Fill a section of the cell given horizontal/vertical fraction pairs.
export function fill(
  metrics: Metrics,
  canvas: SpriteCanvas,
  x0: Fraction,
  x1: Fraction,
  y0: Fraction,
  y1: Fraction,
): void {
  canvas.box(
    fracMin(x0, metrics.cellWidth),
    fracMin(y0, metrics.cellHeight),
    fracMax(x1, metrics.cellWidth),
    fracMax(y1, metrics.cellHeight),
    SHADE_ON,
  );
}

// Centered vertical line of the provided thickness.
export function vlineMiddle(metrics: Metrics, canvas: SpriteCanvas, thickness: Thickness): void {
  const thickPx = thicknessHeight(thickness, metrics.boxThickness);
  vline(canvas, 0, metrics.cellHeight, idiv(satSub(metrics.cellWidth, thickPx), 2), thickPx);
}

// Centered horizontal line of the provided thickness.
export function hlineMiddle(metrics: Metrics, canvas: SpriteCanvas, thickness: Thickness): void {
  const thickPx = thicknessHeight(thickness, metrics.boxThickness);
  hline(canvas, 0, metrics.cellWidth, idiv(satSub(metrics.cellHeight, thickPx), 2), thickPx);
}

// Vertical line with the left edge at `x`, between `y1` and `y2`.
export function vline(canvas: SpriteCanvas, y1: number, y2: number, x: number, thicknessPx: number): void {
  canvas.box(x, y1, x + thicknessPx, y2, SHADE_ON);
}

// Horizontal line with the top edge at `y`, between `x1` and `x2`.
export function hline(canvas: SpriteCanvas, x1: number, x2: number, y: number, thicknessPx: number): void {
  canvas.box(x1, y, x2, y + thicknessPx, SHADE_ON);
}
