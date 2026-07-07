// Block Elements | U+2580...U+259F
// https://en.wikipedia.org/wiki/Block_Elements
//
// ▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏
// ▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟
//
// Port of ghostty's src/font/sprite/draw/block.zig.

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON, SHADE_LIGHT, SHADE_MEDIUM, SHADE_DARK } from '../sprite-canvas';
import {
  DrawFn, Alignment, ALIGN, Quads, fill, round, idiv,
  one_eighth, one_quarter, three_eighths, half, five_eighths, three_quarters, seven_eighths,
} from './common';

export const draw2580_259F: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '▀' UPPER HALF BLOCK
  case 0x2580: block(metrics, canvas, ALIGN.upper, 1, half); break;
  // '▁' LOWER ONE EIGHTH BLOCK
  case 0x2581: block(metrics, canvas, ALIGN.lower, 1, one_eighth); break;
  // '▂' LOWER ONE QUARTER BLOCK
  case 0x2582: block(metrics, canvas, ALIGN.lower, 1, one_quarter); break;
  // '▃' LOWER THREE EIGHTHS BLOCK
  case 0x2583: block(metrics, canvas, ALIGN.lower, 1, three_eighths); break;
  // '▄' LOWER HALF BLOCK
  case 0x2584: block(metrics, canvas, ALIGN.lower, 1, half); break;
  // '▅' LOWER FIVE EIGHTHS BLOCK
  case 0x2585: block(metrics, canvas, ALIGN.lower, 1, five_eighths); break;
  // '▆' LOWER THREE QUARTERS BLOCK
  case 0x2586: block(metrics, canvas, ALIGN.lower, 1, three_quarters); break;
  // '▇' LOWER SEVEN EIGHTHS BLOCK
  case 0x2587: block(metrics, canvas, ALIGN.lower, 1, seven_eighths); break;
  // '█' FULL BLOCK
  case 0x2588: fullBlockShade(metrics, canvas, SHADE_ON); break;
  // '▉' LEFT SEVEN EIGHTHS BLOCK
  case 0x2589: block(metrics, canvas, ALIGN.left, seven_eighths, 1); break;
  // '▊' LEFT THREE QUARTERS BLOCK
  case 0x258a: block(metrics, canvas, ALIGN.left, three_quarters, 1); break;
  // '▋' LEFT FIVE EIGHTHS BLOCK
  case 0x258b: block(metrics, canvas, ALIGN.left, five_eighths, 1); break;
  // '▌' LEFT HALF BLOCK
  case 0x258c: block(metrics, canvas, ALIGN.left, half, 1); break;
  // '▍' LEFT THREE EIGHTHS BLOCK
  case 0x258d: block(metrics, canvas, ALIGN.left, three_eighths, 1); break;
  // '▎' LEFT ONE QUARTER BLOCK
  case 0x258e: block(metrics, canvas, ALIGN.left, one_quarter, 1); break;
  // '▏' LEFT ONE EIGHTH BLOCK
  case 0x258f: block(metrics, canvas, ALIGN.left, one_eighth, 1); break;
  // '▐' RIGHT HALF BLOCK
  case 0x2590: block(metrics, canvas, ALIGN.right, half, 1); break;
  // '░'
  case 0x2591: fullBlockShade(metrics, canvas, SHADE_LIGHT); break;
  // '▒'
  case 0x2592: fullBlockShade(metrics, canvas, SHADE_MEDIUM); break;
  // '▓'
  case 0x2593: fullBlockShade(metrics, canvas, SHADE_DARK); break;
  // '▔' UPPER ONE EIGHTH BLOCK
  case 0x2594: block(metrics, canvas, ALIGN.upper, 1, one_eighth); break;
  // '▕' RIGHT ONE EIGHTH BLOCK
  case 0x2595: block(metrics, canvas, ALIGN.right, one_eighth, 1); break;
  // '▖'
  case 0x2596: quadrant(metrics, canvas, { bl: true }); break;
  // '▗'
  case 0x2597: quadrant(metrics, canvas, { br: true }); break;
  // '▘'
  case 0x2598: quadrant(metrics, canvas, { tl: true }); break;
  // '▙'
  case 0x2599: quadrant(metrics, canvas, { tl: true, bl: true, br: true }); break;
  // '▚'
  case 0x259a: quadrant(metrics, canvas, { tl: true, br: true }); break;
  // '▛'
  case 0x259b: quadrant(metrics, canvas, { tl: true, tr: true, bl: true }); break;
  // '▜'
  case 0x259c: quadrant(metrics, canvas, { tl: true, tr: true, br: true }); break;
  // '▝'
  case 0x259d: quadrant(metrics, canvas, { tr: true }); break;
  // '▞'
  case 0x259e: quadrant(metrics, canvas, { tr: true, bl: true }); break;
  // '▟'
  case 0x259f: quadrant(metrics, canvas, { tr: true, bl: true, br: true }); break;
  }
};

export function block(
  metrics: Metrics,
  canvas: SpriteCanvas,
  alignment: Alignment,
  width: number,
  height: number,
): void {
  blockShade(metrics, canvas, alignment, width, height, SHADE_ON);
}

export function blockShade(
  metrics: Metrics,
  canvas: SpriteCanvas,
  alignment: Alignment,
  width: number,
  height: number,
  shade: number,
): void {
  const w = Math.trunc(round(metrics.cellWidth * width));
  const h = Math.trunc(round(metrics.cellHeight * height));

  const x = alignment.horizontal === 'left' ? 0
    : alignment.horizontal === 'right' ? metrics.cellWidth - w
    : idiv(metrics.cellWidth - w, 2);
  const y = alignment.vertical === 'top' ? 0
    : alignment.vertical === 'bottom' ? metrics.cellHeight - h
    : idiv(metrics.cellHeight - h, 2);

  canvas.rect({ x, y, width: w, height: h }, shade);
}

export function fullBlockShade(metrics: Metrics, canvas: SpriteCanvas, shade: number): void {
  canvas.box(0, 0, metrics.cellWidth, metrics.cellHeight, shade);
}

function quadrant(metrics: Metrics, canvas: SpriteCanvas, quads: Quads): void {
  if (quads.tl) { fill(metrics, canvas, 0, half, 0, half); }
  if (quads.tr) { fill(metrics, canvas, half, 1, 0, half); }
  if (quads.bl) { fill(metrics, canvas, 0, half, half, 1); }
  if (quads.br) { fill(metrics, canvas, half, 1, half, 1); }
}
