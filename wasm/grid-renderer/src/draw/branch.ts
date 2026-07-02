// Branch Drawing Characters | U+F5D0...U+F60D
//
// Branch drawing character set, used for drawing git-like
// graphs in the terminal. Originally implemented in Kitty.
// Ref:
// - https://github.com/kovidgoyal/kitty/pull/7681
// - https://github.com/kovidgoyal/kitty/pull/7805
// NOTE: Kitty is GPL licensed, and its code was not referenced
//       for these characters, only the loose specification of
//       the character set in the pull request descriptions.
//
//                
//                
//                
//              
//
// Port of ghostty's src/font/sprite/draw/branch.zig.

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON } from '../sprite-canvas';
import {
  DrawFn, Edge, Thickness, thicknessHeight,
  hlineMiddle, vlineMiddle, idiv, satSub, round,
} from './common';
import { arc } from './box';

// Specification of a branch drawing node, which consists of a
// circle which is either empty or filled, and lines connecting
// optionally between the circle and each of the 4 edges.
interface BranchNode {
  up?: boolean;
  right?: boolean;
  down?: boolean;
  left?: boolean;
  filled?: boolean;
}

export const drawF5D0_F60D: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // ''
  case 0x0f5d0: hlineMiddle(metrics, canvas, 'light'); break;
  // ''
  case 0x0f5d1: vlineMiddle(metrics, canvas, 'light'); break;
  // ''
  case 0x0f5d2: fadingLine(metrics, canvas, 'right', 'light'); break;
  // ''
  case 0x0f5d3: fadingLine(metrics, canvas, 'left', 'light'); break;
  // ''
  case 0x0f5d4: fadingLine(metrics, canvas, 'bottom', 'light'); break;
  // ''
  case 0x0f5d5: fadingLine(metrics, canvas, 'top', 'light'); break;
  // ''
  case 0x0f5d6: arc(metrics, canvas, 'br', 'light'); break;
  // ''
  case 0x0f5d7: arc(metrics, canvas, 'bl', 'light'); break;
  // ''
  case 0x0f5d8: arc(metrics, canvas, 'tr', 'light'); break;
  // ''
  case 0x0f5d9: arc(metrics, canvas, 'tl', 'light'); break;
  // ''
  case 0x0f5da:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tr', 'light');
    break;
  // ''
  case 0x0f5db:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5dc:
    arc(metrics, canvas, 'tr', 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5dd:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tl', 'light');
    break;
  // ''
  case 0x0f5de:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'bl', 'light');
    break;
  // ''
  case 0x0f5df:
    arc(metrics, canvas, 'tl', 'light');
    arc(metrics, canvas, 'bl', 'light');
    break;

  // ''
  case 0x0f5e0:
    arc(metrics, canvas, 'bl', 'light');
    hlineMiddle(metrics, canvas, 'light');
    break;
  // ''
  case 0x0f5e1:
    arc(metrics, canvas, 'br', 'light');
    hlineMiddle(metrics, canvas, 'light');
    break;
  // ''
  case 0x0f5e2:
    arc(metrics, canvas, 'br', 'light');
    arc(metrics, canvas, 'bl', 'light');
    break;
  // ''
  case 0x0f5e3:
    arc(metrics, canvas, 'tl', 'light');
    hlineMiddle(metrics, canvas, 'light');
    break;
  // ''
  case 0x0f5e4:
    arc(metrics, canvas, 'tr', 'light');
    hlineMiddle(metrics, canvas, 'light');
    break;
  // ''
  case 0x0f5e5:
    arc(metrics, canvas, 'tr', 'light');
    arc(metrics, canvas, 'tl', 'light');
    break;
  // ''
  case 0x0f5e6:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tl', 'light');
    arc(metrics, canvas, 'tr', 'light');
    break;
  // ''
  case 0x0f5e7:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'bl', 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5e8:
    hlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'bl', 'light');
    arc(metrics, canvas, 'tl', 'light');
    break;
  // ''
  case 0x0f5e9:
    hlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tr', 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5ea:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tl', 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5eb:
    vlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tr', 'light');
    arc(metrics, canvas, 'bl', 'light');
    break;
  // ''
  case 0x0f5ec:
    hlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tl', 'light');
    arc(metrics, canvas, 'br', 'light');
    break;
  // ''
  case 0x0f5ed:
    hlineMiddle(metrics, canvas, 'light');
    arc(metrics, canvas, 'tr', 'light');
    arc(metrics, canvas, 'bl', 'light');
    break;
  // ''
  case 0x0f5ee: branchNode(metrics, canvas, { filled: true }, 'light'); break;
  // ''
  case 0x0f5ef: branchNode(metrics, canvas, {}, 'light'); break;

  // ''
  case 0x0f5f0: branchNode(metrics, canvas, { right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5f1: branchNode(metrics, canvas, { right: true }, 'light'); break;
  // ''
  case 0x0f5f2: branchNode(metrics, canvas, { left: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5f3: branchNode(metrics, canvas, { left: true }, 'light'); break;
  // ''
  case 0x0f5f4: branchNode(metrics, canvas, { left: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5f5: branchNode(metrics, canvas, { left: true, right: true }, 'light'); break;
  // ''
  case 0x0f5f6: branchNode(metrics, canvas, { down: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5f7: branchNode(metrics, canvas, { down: true }, 'light'); break;
  // ''
  case 0x0f5f8: branchNode(metrics, canvas, { up: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5f9: branchNode(metrics, canvas, { up: true }, 'light'); break;
  // ''
  case 0x0f5fa: branchNode(metrics, canvas, { up: true, down: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5fb: branchNode(metrics, canvas, { up: true, down: true }, 'light'); break;
  // ''
  case 0x0f5fc: branchNode(metrics, canvas, { right: true, down: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5fd: branchNode(metrics, canvas, { right: true, down: true }, 'light'); break;
  // ''
  case 0x0f5fe: branchNode(metrics, canvas, { left: true, down: true, filled: true }, 'light'); break;
  // ''
  case 0x0f5ff: branchNode(metrics, canvas, { left: true, down: true }, 'light'); break;

  // ''
  case 0x0f600: branchNode(metrics, canvas, { up: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f601: branchNode(metrics, canvas, { up: true, right: true }, 'light'); break;
  // ''
  case 0x0f602: branchNode(metrics, canvas, { up: true, left: true, filled: true }, 'light'); break;
  // ''
  case 0x0f603: branchNode(metrics, canvas, { up: true, left: true }, 'light'); break;
  // ''
  case 0x0f604: branchNode(metrics, canvas, { up: true, down: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f605: branchNode(metrics, canvas, { up: true, down: true, right: true }, 'light'); break;
  // ''
  case 0x0f606: branchNode(metrics, canvas, { up: true, down: true, left: true, filled: true }, 'light'); break;
  // ''
  case 0x0f607: branchNode(metrics, canvas, { up: true, down: true, left: true }, 'light'); break;
  // ''
  case 0x0f608: branchNode(metrics, canvas, { down: true, left: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f609: branchNode(metrics, canvas, { down: true, left: true, right: true }, 'light'); break;
  // ''
  case 0x0f60a: branchNode(metrics, canvas, { up: true, left: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f60b: branchNode(metrics, canvas, { up: true, left: true, right: true }, 'light'); break;
  // ''
  case 0x0f60c: branchNode(metrics, canvas, { up: true, down: true, left: true, right: true, filled: true }, 'light'); break;
  // ''
  case 0x0f60d: branchNode(metrics, canvas, { up: true, down: true, left: true, right: true }, 'light'); break;
  }
};

function branchNode(
  metrics: Metrics,
  canvas: SpriteCanvas,
  node: BranchNode,
  thickness: Thickness,
): void {
  const thickPx = thicknessHeight(thickness, metrics.boxThickness);
  const floatWidth = metrics.cellWidth;
  const floatHeight = metrics.cellHeight;
  const floatThick = thickPx;

  // Top of horizontal strokes
  const hTop = idiv(satSub(metrics.cellHeight, thickPx), 2);
  // Bottom of horizontal strokes
  const hBottom = hTop + thickPx;
  // Left of vertical strokes
  const vLeft = idiv(satSub(metrics.cellWidth, thickPx), 2);
  // Right of vertical strokes
  const vRight = vLeft + thickPx;

  // We calculate the center of the circle this way
  // to ensure it aligns with box drawing characters
  // since the lines are sometimes off center to
  // make sure they aren't split between pixels.
  const cx = vLeft + floatThick / 2;
  const cy = hTop + floatThick / 2;
  // The radius needs to be the smallest distance from the center to an edge.
  const r = Math.min(
    Math.min(cx, cy),
    Math.min(floatWidth - cx, floatHeight - cy),
  );

  // These truncations can't go negative since r can never be greater
  // than cx or cy, so when subtracting it from them the result can
  // never be negative.
  if (node.up) {
    canvas.box(
      vLeft,
      0,
      vRight,
      Math.trunc(Math.ceil(cy - r + floatThick / 2)),
      SHADE_ON,
    );
  }
  if (node.right) {
    canvas.box(
      Math.trunc(Math.floor(cx + r - floatThick / 2)),
      hTop,
      metrics.cellWidth,
      hBottom,
      SHADE_ON,
    );
  }
  if (node.down) {
    canvas.box(
      vLeft,
      Math.trunc(Math.floor(cy + r - floatThick / 2)),
      vRight,
      metrics.cellHeight,
      SHADE_ON,
    );
  }
  if (node.left) {
    canvas.box(
      0,
      hTop,
      Math.trunc(Math.ceil(cx - r + floatThick / 2)),
      hBottom,
      SHADE_ON,
    );
  }

  if (node.filled) {
    const p = canvas.path();
    p.arc(cx, cy, r, 0, Math.PI * 2);
    p.close();
    canvas.fillPath(p, SHADE_ON);
  } else {
    const p = canvas.path();
    p.arc(cx, cy, r - floatThick / 2, 0, Math.PI * 2);
    p.close();
    canvas.strokePath(p, { width: floatThick }, SHADE_ON);
  }
}

function fadingLine(
  metrics: Metrics,
  canvas: SpriteCanvas,
  to: Edge,
  thickness: Thickness,
): void {
  const thickPx = thicknessHeight(thickness, metrics.boxThickness);
  const floatWidth = metrics.cellWidth;
  const floatHeight = metrics.cellHeight;

  // Top of horizontal strokes
  const hTop = idiv(satSub(metrics.cellHeight, thickPx), 2);
  // Bottom of horizontal strokes
  const hBottom = hTop + thickPx;
  // Left of vertical strokes
  const vLeft = idiv(satSub(metrics.cellWidth, thickPx), 2);
  // Right of vertical strokes
  const vRight = vLeft + thickPx;

  // If we're fading to the top or left, we start with 0.0
  // and increment up as we progress, otherwise we start
  // at 255.0 and increment down (negative).
  let color: number = (to === 'top' || to === 'left') ? 0.0 : 255.0;
  const inc: number = 255.0 / (
    to === 'top' ? floatHeight
    : to === 'bottom' ? -floatHeight
    : to === 'left' ? floatWidth
    : -floatWidth);

  switch (to) {
  case 'top':
  case 'bottom':
    for (let y = 0; y < metrics.cellHeight; y++) {
      for (let x = vLeft; x < vRight; x++) {
        canvas.pixel(x, y, Math.trunc(round(color)));
      }
      color += inc;
    }
    break;
  case 'left':
  case 'right':
    for (let x = 0; x < metrics.cellWidth; x++) {
      for (let y = hTop; y < hBottom; y++) {
        canvas.pixel(x, y, Math.trunc(round(color)));
      }
      color += inc;
    }
    break;
  }
}
