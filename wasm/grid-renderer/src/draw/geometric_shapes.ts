// Geometric Shapes | U+25A0...U+25FF
// https://en.wikipedia.org/wiki/Geometric_Shapes_(Unicode_block)
//
// ■ □ ▢ ▣ ▤ ▥ ▦ ▧ ▨ ▩ ▪ ▫ ▬ ▭ ▮ ▯
// ▰ ▱ ▲ △ ▴ ▵ ▶ ▷ ▸ ▹ ► ▻ ▼ ▽ ▾ ▿
// ◀ ◁ ◂ ◃ ◄ ◅ ◆ ◇ ◈ ◉ ◊ ○ ◌ ◍ ◎ ●
// ◐ ◑ ◒ ◓ ◔ ◕ ◖ ◗ ◘ ◙ ◚ ◛ ◜ ◝ ◞ ◟
// ◠ ◡ ◢ ◣ ◤ ◥ ◦ ◧ ◨ ◩ ◪ ◫ ◬ ◭ ◮ ◯
// ◰ ◱ ◲ ◳ ◴ ◵ ◶ ◷ ◸ ◹ ◺ ◻ ◼ ◽︎◾︎◿
//
// Only a subset of this block is viable for sprite drawing; filling
// out this file to have full coverage of this block is not the goal.
//
// Port of ghostty's src/font/sprite/draw/geometric_shapes.zig.

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON } from '../sprite-canvas';
import { DrawFn, Corner, thicknessHeight } from './common';

// ◢ ◣ ◤ ◥
export const draw25E2_25E5: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // ◢
  case 0x25e2: cornerTriangleShade(metrics, canvas, 'br', SHADE_ON); break;
  // ◣
  case 0x25e3: cornerTriangleShade(metrics, canvas, 'bl', SHADE_ON); break;
  // ◤
  case 0x25e4: cornerTriangleShade(metrics, canvas, 'tl', SHADE_ON); break;
  // ◥
  case 0x25e5: cornerTriangleShade(metrics, canvas, 'tr', SHADE_ON); break;
  }
};

// ◸ ◹ ◺
export const draw25F8_25FA: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // ◸
  case 0x25f8: cornerTriangleOutline(metrics, canvas, 'tl'); break;
  // ◹
  case 0x25f9: cornerTriangleOutline(metrics, canvas, 'tr'); break;
  // ◺
  case 0x25fa: cornerTriangleOutline(metrics, canvas, 'bl'); break;
  }
};

// ◿
export const draw25FF: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  cornerTriangleOutline(metrics, canvas, 'br');
};

// The three vertices of a triangle covering the given corner of the cell.
function cornerTrianglePoints(
  float_width: number,
  float_height: number,
  corner: Corner,
): [number, number, number, number, number, number] {
  switch (corner) {
  case 'tl': return [
    0,
    0,
    0,
    float_height,
    float_width,
    0,
  ];
  case 'tr': return [
    0,
    0,
    float_width,
    float_height,
    float_width,
    0,
  ];
  case 'bl': return [
    0,
    0,
    0,
    float_height,
    float_width,
    float_height,
  ];
  case 'br': return [
    0,
    float_height,
    float_width,
    float_height,
    float_width,
    0,
  ];
  }
}

export function cornerTriangleShade(
  metrics: Metrics,
  canvas: SpriteCanvas,
  corner: Corner,
  shade: number,
): void {
  const float_width = metrics.cellWidth;
  const float_height = metrics.cellHeight;

  const [x0, y0, x1, y1, x2, y2] =
    cornerTrianglePoints(float_width, float_height, corner);

  const path = canvas.path();
  path.moveTo(x0, y0);
  path.lineTo(x1, y1);
  path.lineTo(x2, y2);
  path.close();

  canvas.fillPath(path, shade);
}

export function cornerTriangleOutline(
  metrics: Metrics,
  canvas: SpriteCanvas,
  corner: Corner,
): void {
  const float_thick = thicknessHeight('light', metrics.boxThickness);
  const float_width = metrics.cellWidth;
  const float_height = metrics.cellHeight;

  const [x0, y0, x1, y1, x2, y2] =
    cornerTrianglePoints(float_width, float_height, corner);

  const path = canvas.path();
  path.moveTo(x0, y0);
  path.lineTo(x1, y1);
  path.lineTo(x2, y2);
  path.close();

  canvas.innerStrokePath(path, {
    cap: 'butt',
    width: float_thick,
  }, SHADE_ON);
}
