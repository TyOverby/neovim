// Box Drawing | U+2500...U+257F
// https://en.wikipedia.org/wiki/Box_Drawing
//
// ─━│┃┄┅┆┇┈┉┊┋┌┍┎┏
// ┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟
// ┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯
// ┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿
// ╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏
// ═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟
// ╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯
// ╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿
//
// Port of ghostty's src/font/sprite/draw/box.zig.

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON } from '../sprite-canvas';
import {
  DrawFn, Corner, Thickness, thicknessHeight,
  hline, vline, hlineMiddle, vlineMiddle, idiv, satSub,
} from './common';

// Specification of a traditional intersection-style line/box-drawing char,
// which can have a different style of line from each edge to the center.
export type LineStyle = 'none' | 'light' | 'heavy' | 'double';
export interface Lines {
  up?: LineStyle;
  right?: LineStyle;
  down?: LineStyle;
  left?: LineStyle;
}

export const draw2500_257F: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '─'
  case 0x2500: linesChar(metrics, canvas, { left: 'light', right: 'light' }); break;
  // '━'
  case 0x2501: linesChar(metrics, canvas, { left: 'heavy', right: 'heavy' }); break;
  // '│'
  case 0x2502: linesChar(metrics, canvas, { up: 'light', down: 'light' }); break;
  // '┃'
  case 0x2503: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy' }); break;
  // '┄'
  case 0x2504: dashHorizontal(metrics, canvas, 3,
    thicknessHeight('light', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┅'
  case 0x2505: dashHorizontal(metrics, canvas, 3,
    thicknessHeight('heavy', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┆'
  case 0x2506: dashVertical(metrics, canvas, 3,
    thicknessHeight('light', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┇'
  case 0x2507: dashVertical(metrics, canvas, 3,
    thicknessHeight('heavy', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┈'
  case 0x2508: dashHorizontal(metrics, canvas, 4,
    thicknessHeight('light', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┉'
  case 0x2509: dashHorizontal(metrics, canvas, 4,
    thicknessHeight('heavy', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┊'
  case 0x250a: dashVertical(metrics, canvas, 4,
    thicknessHeight('light', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┋'
  case 0x250b: dashVertical(metrics, canvas, 4,
    thicknessHeight('heavy', metrics.boxThickness),
    Math.max(4, thicknessHeight('light', metrics.boxThickness))); break;
  // '┌'
  case 0x250c: linesChar(metrics, canvas, { down: 'light', right: 'light' }); break;
  // '┍'
  case 0x250d: linesChar(metrics, canvas, { down: 'light', right: 'heavy' }); break;
  // '┎'
  case 0x250e: linesChar(metrics, canvas, { down: 'heavy', right: 'light' }); break;
  // '┏'
  case 0x250f: linesChar(metrics, canvas, { down: 'heavy', right: 'heavy' }); break;
  // '┐'
  case 0x2510: linesChar(metrics, canvas, { down: 'light', left: 'light' }); break;
  // '┑'
  case 0x2511: linesChar(metrics, canvas, { down: 'light', left: 'heavy' }); break;
  // '┒'
  case 0x2512: linesChar(metrics, canvas, { down: 'heavy', left: 'light' }); break;
  // '┓'
  case 0x2513: linesChar(metrics, canvas, { down: 'heavy', left: 'heavy' }); break;
  // '└'
  case 0x2514: linesChar(metrics, canvas, { up: 'light', right: 'light' }); break;
  // '┕'
  case 0x2515: linesChar(metrics, canvas, { up: 'light', right: 'heavy' }); break;
  // '┖'
  case 0x2516: linesChar(metrics, canvas, { up: 'heavy', right: 'light' }); break;
  // '┗'
  case 0x2517: linesChar(metrics, canvas, { up: 'heavy', right: 'heavy' }); break;
  // '┘'
  case 0x2518: linesChar(metrics, canvas, { up: 'light', left: 'light' }); break;
  // '┙'
  case 0x2519: linesChar(metrics, canvas, { up: 'light', left: 'heavy' }); break;
  // '┚'
  case 0x251a: linesChar(metrics, canvas, { up: 'heavy', left: 'light' }); break;
  // '┛'
  case 0x251b: linesChar(metrics, canvas, { up: 'heavy', left: 'heavy' }); break;
  // '├'
  case 0x251c: linesChar(metrics, canvas, { up: 'light', down: 'light', right: 'light' }); break;
  // '┝'
  case 0x251d: linesChar(metrics, canvas, { up: 'light', down: 'light', right: 'heavy' }); break;
  // '┞'
  case 0x251e: linesChar(metrics, canvas, { up: 'heavy', right: 'light', down: 'light' }); break;
  // '┟'
  case 0x251f: linesChar(metrics, canvas, { down: 'heavy', right: 'light', up: 'light' }); break;
  // '┠'
  case 0x2520: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', right: 'light' }); break;
  // '┡'
  case 0x2521: linesChar(metrics, canvas, { down: 'light', right: 'heavy', up: 'heavy' }); break;
  // '┢'
  case 0x2522: linesChar(metrics, canvas, { up: 'light', right: 'heavy', down: 'heavy' }); break;
  // '┣'
  case 0x2523: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', right: 'heavy' }); break;
  // '┤'
  case 0x2524: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'light' }); break;
  // '┥'
  case 0x2525: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'heavy' }); break;
  // '┦'
  case 0x2526: linesChar(metrics, canvas, { up: 'heavy', left: 'light', down: 'light' }); break;
  // '┧'
  case 0x2527: linesChar(metrics, canvas, { down: 'heavy', left: 'light', up: 'light' }); break;
  // '┨'
  case 0x2528: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', left: 'light' }); break;
  // '┩'
  case 0x2529: linesChar(metrics, canvas, { down: 'light', left: 'heavy', up: 'heavy' }); break;
  // '┪'
  case 0x252a: linesChar(metrics, canvas, { up: 'light', left: 'heavy', down: 'heavy' }); break;
  // '┫'
  case 0x252b: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', left: 'heavy' }); break;
  // '┬'
  case 0x252c: linesChar(metrics, canvas, { down: 'light', left: 'light', right: 'light' }); break;
  // '┭'
  case 0x252d: linesChar(metrics, canvas, { left: 'heavy', right: 'light', down: 'light' }); break;
  // '┮'
  case 0x252e: linesChar(metrics, canvas, { right: 'heavy', left: 'light', down: 'light' }); break;
  // '┯'
  case 0x252f: linesChar(metrics, canvas, { down: 'light', left: 'heavy', right: 'heavy' }); break;
  // '┰'
  case 0x2530: linesChar(metrics, canvas, { down: 'heavy', left: 'light', right: 'light' }); break;
  // '┱'
  case 0x2531: linesChar(metrics, canvas, { right: 'light', left: 'heavy', down: 'heavy' }); break;
  // '┲'
  case 0x2532: linesChar(metrics, canvas, { left: 'light', right: 'heavy', down: 'heavy' }); break;
  // '┳'
  case 0x2533: linesChar(metrics, canvas, { down: 'heavy', left: 'heavy', right: 'heavy' }); break;
  // '┴'
  case 0x2534: linesChar(metrics, canvas, { up: 'light', left: 'light', right: 'light' }); break;
  // '┵'
  case 0x2535: linesChar(metrics, canvas, { left: 'heavy', right: 'light', up: 'light' }); break;
  // '┶'
  case 0x2536: linesChar(metrics, canvas, { right: 'heavy', left: 'light', up: 'light' }); break;
  // '┷'
  case 0x2537: linesChar(metrics, canvas, { up: 'light', left: 'heavy', right: 'heavy' }); break;
  // '┸'
  case 0x2538: linesChar(metrics, canvas, { up: 'heavy', left: 'light', right: 'light' }); break;
  // '┹'
  case 0x2539: linesChar(metrics, canvas, { right: 'light', left: 'heavy', up: 'heavy' }); break;
  // '┺'
  case 0x253a: linesChar(metrics, canvas, { left: 'light', right: 'heavy', up: 'heavy' }); break;
  // '┻'
  case 0x253b: linesChar(metrics, canvas, { up: 'heavy', left: 'heavy', right: 'heavy' }); break;
  // '┼'
  case 0x253c: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'light', right: 'light' }); break;
  // '┽'
  case 0x253d: linesChar(metrics, canvas, { left: 'heavy', right: 'light', up: 'light', down: 'light' }); break;
  // '┾'
  case 0x253e: linesChar(metrics, canvas, { right: 'heavy', left: 'light', up: 'light', down: 'light' }); break;
  // '┿'
  case 0x253f: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'heavy', right: 'heavy' }); break;
  // '╀'
  case 0x2540: linesChar(metrics, canvas, { up: 'heavy', down: 'light', left: 'light', right: 'light' }); break;
  // '╁'
  case 0x2541: linesChar(metrics, canvas, { down: 'heavy', up: 'light', left: 'light', right: 'light' }); break;
  // '╂'
  case 0x2542: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', left: 'light', right: 'light' }); break;
  // '╃'
  case 0x2543: linesChar(metrics, canvas, { left: 'heavy', up: 'heavy', right: 'light', down: 'light' }); break;
  // '╄'
  case 0x2544: linesChar(metrics, canvas, { right: 'heavy', up: 'heavy', left: 'light', down: 'light' }); break;
  // '╅'
  case 0x2545: linesChar(metrics, canvas, { left: 'heavy', down: 'heavy', right: 'light', up: 'light' }); break;
  // '╆'
  case 0x2546: linesChar(metrics, canvas, { right: 'heavy', down: 'heavy', left: 'light', up: 'light' }); break;
  // '╇'
  case 0x2547: linesChar(metrics, canvas, { down: 'light', up: 'heavy', left: 'heavy', right: 'heavy' }); break;
  // '╈'
  case 0x2548: linesChar(metrics, canvas, { up: 'light', down: 'heavy', left: 'heavy', right: 'heavy' }); break;
  // '╉'
  case 0x2549: linesChar(metrics, canvas, { right: 'light', left: 'heavy', up: 'heavy', down: 'heavy' }); break;
  // '╊'
  case 0x254a: linesChar(metrics, canvas, { left: 'light', right: 'heavy', up: 'heavy', down: 'heavy' }); break;
  // '╋'
  case 0x254b: linesChar(metrics, canvas, { up: 'heavy', down: 'heavy', left: 'heavy', right: 'heavy' }); break;
  // '╌'
  case 0x254c: dashHorizontal(metrics, canvas, 2,
    thicknessHeight('light', metrics.boxThickness),
    thicknessHeight('light', metrics.boxThickness)); break;
  // '╍'
  case 0x254d: dashHorizontal(metrics, canvas, 2,
    thicknessHeight('heavy', metrics.boxThickness),
    thicknessHeight('heavy', metrics.boxThickness)); break;
  // '╎'
  case 0x254e: dashVertical(metrics, canvas, 2,
    thicknessHeight('light', metrics.boxThickness),
    thicknessHeight('heavy', metrics.boxThickness)); break;
  // '╏'
  case 0x254f: dashVertical(metrics, canvas, 2,
    thicknessHeight('heavy', metrics.boxThickness),
    thicknessHeight('heavy', metrics.boxThickness)); break;
  // '═'
  case 0x2550: linesChar(metrics, canvas, { left: 'double', right: 'double' }); break;
  // '║'
  case 0x2551: linesChar(metrics, canvas, { up: 'double', down: 'double' }); break;
  // '╒'
  case 0x2552: linesChar(metrics, canvas, { down: 'light', right: 'double' }); break;
  // '╓'
  case 0x2553: linesChar(metrics, canvas, { down: 'double', right: 'light' }); break;
  // '╔'
  case 0x2554: linesChar(metrics, canvas, { down: 'double', right: 'double' }); break;
  // '╕'
  case 0x2555: linesChar(metrics, canvas, { down: 'light', left: 'double' }); break;
  // '╖'
  case 0x2556: linesChar(metrics, canvas, { down: 'double', left: 'light' }); break;
  // '╗'
  case 0x2557: linesChar(metrics, canvas, { down: 'double', left: 'double' }); break;
  // '╘'
  case 0x2558: linesChar(metrics, canvas, { up: 'light', right: 'double' }); break;
  // '╙'
  case 0x2559: linesChar(metrics, canvas, { up: 'double', right: 'light' }); break;
  // '╚'
  case 0x255a: linesChar(metrics, canvas, { up: 'double', right: 'double' }); break;
  // '╛'
  case 0x255b: linesChar(metrics, canvas, { up: 'light', left: 'double' }); break;
  // '╜'
  case 0x255c: linesChar(metrics, canvas, { up: 'double', left: 'light' }); break;
  // '╝'
  case 0x255d: linesChar(metrics, canvas, { up: 'double', left: 'double' }); break;
  // '╞'
  case 0x255e: linesChar(metrics, canvas, { up: 'light', down: 'light', right: 'double' }); break;
  // '╟'
  case 0x255f: linesChar(metrics, canvas, { up: 'double', down: 'double', right: 'light' }); break;
  // '╠'
  case 0x2560: linesChar(metrics, canvas, { up: 'double', down: 'double', right: 'double' }); break;
  // '╡'
  case 0x2561: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'double' }); break;
  // '╢'
  case 0x2562: linesChar(metrics, canvas, { up: 'double', down: 'double', left: 'light' }); break;
  // '╣'
  case 0x2563: linesChar(metrics, canvas, { up: 'double', down: 'double', left: 'double' }); break;
  // '╤'
  case 0x2564: linesChar(metrics, canvas, { down: 'light', left: 'double', right: 'double' }); break;
  // '╥'
  case 0x2565: linesChar(metrics, canvas, { down: 'double', left: 'light', right: 'light' }); break;
  // '╦'
  case 0x2566: linesChar(metrics, canvas, { down: 'double', left: 'double', right: 'double' }); break;
  // '╧'
  case 0x2567: linesChar(metrics, canvas, { up: 'light', left: 'double', right: 'double' }); break;
  // '╨'
  case 0x2568: linesChar(metrics, canvas, { up: 'double', left: 'light', right: 'light' }); break;
  // '╩'
  case 0x2569: linesChar(metrics, canvas, { up: 'double', left: 'double', right: 'double' }); break;
  // '╪'
  case 0x256a: linesChar(metrics, canvas, { up: 'light', down: 'light', left: 'double', right: 'double' }); break;
  // '╫'
  case 0x256b: linesChar(metrics, canvas, { up: 'double', down: 'double', left: 'light', right: 'light' }); break;
  // '╬'
  case 0x256c: linesChar(metrics, canvas, { up: 'double', down: 'double', left: 'double', right: 'double' }); break;
  // '╭'
  case 0x256d: arc(metrics, canvas, 'br', 'light'); break;
  // '╮'
  case 0x256e: arc(metrics, canvas, 'bl', 'light'); break;
  // '╯'
  case 0x256f: arc(metrics, canvas, 'tl', 'light'); break;
  // '╰'
  case 0x2570: arc(metrics, canvas, 'tr', 'light'); break;
  // '╱'
  case 0x2571: lightDiagonalUpperRightToLowerLeft(metrics, canvas); break;
  // '╲'
  case 0x2572: lightDiagonalUpperLeftToLowerRight(metrics, canvas); break;
  // '╳'
  case 0x2573: lightDiagonalCross(metrics, canvas); break;
  // '╴'
  case 0x2574: linesChar(metrics, canvas, { left: 'light' }); break;
  // '╵'
  case 0x2575: linesChar(metrics, canvas, { up: 'light' }); break;
  // '╶'
  case 0x2576: linesChar(metrics, canvas, { right: 'light' }); break;
  // '╷'
  case 0x2577: linesChar(metrics, canvas, { down: 'light' }); break;
  // '╸'
  case 0x2578: linesChar(metrics, canvas, { left: 'heavy' }); break;
  // '╹'
  case 0x2579: linesChar(metrics, canvas, { up: 'heavy' }); break;
  // '╺'
  case 0x257a: linesChar(metrics, canvas, { right: 'heavy' }); break;
  // '╻'
  case 0x257b: linesChar(metrics, canvas, { down: 'heavy' }); break;
  // '╼'
  case 0x257c: linesChar(metrics, canvas, { left: 'light', right: 'heavy' }); break;
  // '╽'
  case 0x257d: linesChar(metrics, canvas, { up: 'light', down: 'heavy' }); break;
  // '╾'
  case 0x257e: linesChar(metrics, canvas, { left: 'heavy', right: 'light' }); break;
  // '╿'
  case 0x257f: linesChar(metrics, canvas, { up: 'heavy', down: 'light' }); break;
  }
};

export function linesChar(metrics: Metrics, canvas: SpriteCanvas, lines: Lines): void {
  const up: LineStyle = lines.up || 'none';
  const down: LineStyle = lines.down || 'none';
  const left: LineStyle = lines.left || 'none';
  const right: LineStyle = lines.right || 'none';

  const lightPx = thicknessHeight('light', metrics.boxThickness);
  const heavyPx = thicknessHeight('heavy', metrics.boxThickness);

  // Top of light horizontal strokes
  const hLightTop = idiv(satSub(metrics.cellHeight, lightPx), 2);
  // Bottom of light horizontal strokes
  const hLightBottom = hLightTop + lightPx;

  // Top of heavy horizontal strokes
  const hHeavyTop = idiv(satSub(metrics.cellHeight, heavyPx), 2);
  // Bottom of heavy horizontal strokes
  const hHeavyBottom = hHeavyTop + heavyPx;

  // Top of the top doubled horizontal stroke (bottom is `hLightTop`)
  const hDoubleTop = satSub(hLightTop, lightPx);
  // Bottom of the bottom doubled horizontal stroke (top is `hLightBottom`)
  const hDoubleBottom = hLightBottom + lightPx;

  // Left of light vertical strokes
  const vLightLeft = idiv(satSub(metrics.cellWidth, lightPx), 2);
  // Right of light vertical strokes
  const vLightRight = vLightLeft + lightPx;

  // Left of heavy vertical strokes
  const vHeavyLeft = idiv(satSub(metrics.cellWidth, heavyPx), 2);
  // Right of heavy vertical strokes
  const vHeavyRight = vHeavyLeft + heavyPx;

  // Left of the left doubled vertical stroke (right is `vLightLeft`)
  const vDoubleLeft = satSub(vLightLeft, lightPx);
  // Right of the right doubled vertical stroke (left is `vLightRight`)
  const vDoubleRight = vLightRight + lightPx;

  // The bottom of the up line
  const upBottom =
    (left === 'heavy' || right === 'heavy') ? hHeavyBottom :
    (left !== right || down === up)
      ? ((left === 'double' || right === 'double') ? hDoubleBottom : hLightBottom) :
    (left === 'none' && right === 'none') ? hLightBottom : hLightTop;

  // The top of the down line
  const downTop =
    (left === 'heavy' || right === 'heavy') ? hHeavyTop :
    (left !== right || up === down)
      ? ((left === 'double' || right === 'double') ? hDoubleTop : hLightTop) :
    (left === 'none' && right === 'none') ? hLightTop : hLightBottom;

  // The right of the left line
  const leftRight =
    (up === 'heavy' || down === 'heavy') ? vHeavyRight :
    (up !== down || left === right)
      ? ((up === 'double' || down === 'double') ? vDoubleRight : vLightRight) :
    (up === 'none' && down === 'none') ? vLightRight : vLightLeft;

  // The left of the right line
  const rightLeft =
    (up === 'heavy' || down === 'heavy') ? vHeavyLeft :
    (up !== down || right === left)
      ? ((up === 'double' || down === 'double') ? vDoubleLeft : vLightLeft) :
    (up === 'none' && down === 'none') ? vLightLeft : vLightRight;

  switch (up) {
  case 'none': break;
  case 'light':
    canvas.box(vLightLeft, 0, vLightRight, upBottom, SHADE_ON);
    break;
  case 'heavy':
    canvas.box(vHeavyLeft, 0, vHeavyRight, upBottom, SHADE_ON);
    break;
  case 'double': {
    const leftBottom = (left === 'double') ? hLightTop : upBottom;
    const rightBottom = (right === 'double') ? hLightTop : upBottom;
    canvas.box(vDoubleLeft, 0, vLightLeft, leftBottom, SHADE_ON);
    canvas.box(vLightRight, 0, vDoubleRight, rightBottom, SHADE_ON);
    break;
  }
  }

  switch (right) {
  case 'none': break;
  case 'light':
    canvas.box(rightLeft, hLightTop, metrics.cellWidth, hLightBottom, SHADE_ON);
    break;
  case 'heavy':
    canvas.box(rightLeft, hHeavyTop, metrics.cellWidth, hHeavyBottom, SHADE_ON);
    break;
  case 'double': {
    const topLeft = (up === 'double') ? vLightRight : rightLeft;
    const bottomLeft = (down === 'double') ? vLightRight : rightLeft;
    canvas.box(topLeft, hDoubleTop, metrics.cellWidth, hLightTop, SHADE_ON);
    canvas.box(bottomLeft, hLightBottom, metrics.cellWidth, hDoubleBottom, SHADE_ON);
    break;
  }
  }

  switch (down) {
  case 'none': break;
  case 'light':
    canvas.box(vLightLeft, downTop, vLightRight, metrics.cellHeight, SHADE_ON);
    break;
  case 'heavy':
    canvas.box(vHeavyLeft, downTop, vHeavyRight, metrics.cellHeight, SHADE_ON);
    break;
  case 'double': {
    const leftTop = (left === 'double') ? hLightBottom : downTop;
    const rightTop = (right === 'double') ? hLightBottom : downTop;
    canvas.box(vDoubleLeft, leftTop, vLightLeft, metrics.cellHeight, SHADE_ON);
    canvas.box(vLightRight, rightTop, vDoubleRight, metrics.cellHeight, SHADE_ON);
    break;
  }
  }

  switch (left) {
  case 'none': break;
  case 'light':
    canvas.box(0, hLightTop, leftRight, hLightBottom, SHADE_ON);
    break;
  case 'heavy':
    canvas.box(0, hHeavyTop, leftRight, hHeavyBottom, SHADE_ON);
    break;
  case 'double': {
    const topRight = (up === 'double') ? vLightLeft : leftRight;
    const bottomRight = (down === 'double') ? vLightLeft : leftRight;
    canvas.box(0, hDoubleTop, topRight, hLightTop, SHADE_ON);
    canvas.box(0, hLightBottom, bottomRight, hDoubleBottom, SHADE_ON);
    break;
  }
  }
}

export function lightDiagonalUpperRightToLowerLeft(metrics: Metrics, canvas: SpriteCanvas): void {
  const w = metrics.cellWidth;
  const h = metrics.cellHeight;

  // We overshoot the corners by a tiny bit, but we need to
  // maintain the correct slope, so we calculate that here.
  const slopeX = Math.min(1.0, w / h);
  const slopeY = Math.min(1.0, h / w);

  canvas.line({
    p0: { x: w + 0.5 * slopeX, y: -0.5 * slopeY },
    p1: { x: -0.5 * slopeX, y: h + 0.5 * slopeY },
  }, thicknessHeight('light', metrics.boxThickness), SHADE_ON);
}

export function lightDiagonalUpperLeftToLowerRight(metrics: Metrics, canvas: SpriteCanvas): void {
  const w = metrics.cellWidth;
  const h = metrics.cellHeight;

  // We overshoot the corners by a tiny bit, but we need to
  // maintain the correct slope, so we calculate that here.
  const slopeX = Math.min(1.0, w / h);
  const slopeY = Math.min(1.0, h / w);

  canvas.line({
    p0: { x: -0.5 * slopeX, y: -0.5 * slopeY },
    p1: { x: w + 0.5 * slopeX, y: h + 0.5 * slopeY },
  }, thicknessHeight('light', metrics.boxThickness), SHADE_ON);
}

export function lightDiagonalCross(metrics: Metrics, canvas: SpriteCanvas): void {
  lightDiagonalUpperRightToLowerLeft(metrics, canvas);
  lightDiagonalUpperLeftToLowerRight(metrics, canvas);
}

export function arc(
  metrics: Metrics,
  canvas: SpriteCanvas,
  corner: Corner,
  thickness: Thickness,
): void {
  const thickPx = thicknessHeight(thickness, metrics.boxThickness);
  const w = metrics.cellWidth;
  const h = metrics.cellHeight;
  const centerX = idiv(satSub(w, thickPx), 2) + thickPx / 2;
  const centerY = idiv(satSub(h, thickPx), 2) + thickPx / 2;

  const r = Math.min(w, h) / 2;

  // Fraction away from the center to place the middle control points.
  const s = 0.25;

  const path = canvas.path();

  switch (corner) {
  case 'tl':
    path.moveTo(centerX, 0);
    path.lineTo(centerX, centerY - r);
    path.curveTo(centerX, centerY - s * r, centerX - s * r, centerY, centerX - r, centerY);
    path.lineTo(0, centerY);
    break;
  case 'tr':
    path.moveTo(centerX, 0);
    path.lineTo(centerX, centerY - r);
    path.curveTo(centerX, centerY - s * r, centerX + s * r, centerY, centerX + r, centerY);
    path.lineTo(w, centerY);
    break;
  case 'bl':
    path.moveTo(centerX, h);
    path.lineTo(centerX, centerY + r);
    path.curveTo(centerX, centerY + s * r, centerX - s * r, centerY, centerX - r, centerY);
    path.lineTo(0, centerY);
    break;
  case 'br':
    path.moveTo(centerX, h);
    path.lineTo(centerX, centerY + r);
    path.curveTo(centerX, centerY + s * r, centerX + s * r, centerY, centerX + r, centerY);
    path.lineTo(w, centerY);
    break;
  }

  canvas.strokePath(path, { cap: 'butt', width: thickPx }, SHADE_ON);
}

function dashHorizontal(
  metrics: Metrics,
  canvas: SpriteCanvas,
  count: number,
  thickPx: number,
  desiredGap: number,
): void {
  // Our dashed line should be made such that when tiled horizontally
  // it creates one consistent line with no uneven gap or segment sizes.
  // In order to make sure this is the case, we should have half-sized
  // gaps on the left and right so that it is centered properly.

  // For N dashes, there are N - 1 gaps between them, but we also have
  // half-sized gaps on either side, adding up to N total gaps.
  const gapCount = count;

  // We need at least 1 pixel for each gap and each dash, if we don't
  // have that then we can't draw our dashed line correctly so we just
  // draw a solid line and return.
  if (metrics.cellWidth < count + gapCount) {
    hlineMiddle(metrics, canvas, 'light');
    return;
  }

  // We never want the gaps to take up more than 50% of the space,
  // because if they do the dashes are too small and look wrong.
  const gapWidth = Math.min(desiredGap, idiv(metrics.cellWidth, 2 * count));
  const totalGapWidth = gapCount * gapWidth;
  const totalDashWidth = metrics.cellWidth - totalGapWidth;
  const dashWidth = Math.floor(totalDashWidth / count);
  const remaining = ((totalDashWidth % count) + count) % count;

  // Our dashes should be centered vertically.
  const y = idiv(satSub(metrics.cellHeight, thickPx), 2);

  // We start at half a gap from the left edge, in order to center
  // our dashes properly.
  let x = Math.floor(gapWidth / 2);

  // We'll distribute the extra space in to dash widths, 1px at a
  // time. We prefer this to making gaps larger since that is much
  // more visually obvious.
  let extra = remaining;

  for (let i = 0; i < count; i++) {
    let x1 = x + dashWidth;
    // We distribute left-over size in to dash widths,
    // since it's less obvious there than in the gaps.
    if (extra > 0) { extra -= 1; x1 += 1; }
    hline(canvas, x, x1, y, thickPx);
    // Advance by the width of the dash we drew and the width
    // of a gap to get the start of the next dash.
    x = x1 + gapWidth;
  }
}

function dashVertical(
  metrics: Metrics,
  canvas: SpriteCanvas,
  count: number,
  thickPx: number,
  desiredGap: number,
): void {
  // Our dashed line should be made such that when tiled vertically it
  // creates one consistent line with no uneven gap or segment sizes.
  // In order to make sure this is the case, we should have an extra
  // gap at the bottom (see ghostty for the full rationale).

  // Because of the extra gap at the bottom, there are as many gaps as
  // there are dashes.
  const gapCount = count;

  // We need at least 1 pixel for each gap and each dash, if we don't
  // have that then we can't draw our dashed line correctly so we just
  // draw a solid line and return.
  if (metrics.cellHeight < count + gapCount) {
    vlineMiddle(metrics, canvas, 'light');
    return;
  }

  // We never want the gaps to take up more than 50% of the space,
  // because if they do the dashes are too small and look wrong.
  const gapHeight = Math.min(desiredGap, idiv(metrics.cellHeight, 2 * count));
  const totalGapHeight = gapCount * gapHeight;
  const totalDashHeight = metrics.cellHeight - totalGapHeight;
  const dashHeight = Math.floor(totalDashHeight / count);
  const remaining = ((totalDashHeight % count) + count) % count;

  // Our dashes should be centered horizontally.
  const x = idiv(satSub(metrics.cellWidth, thickPx), 2);

  // We start at the top of the cell.
  let y = 0;

  // We'll distribute the extra space in to dash heights, 1px at a
  // time. We prefer this to making gaps larger since that is much
  // more visually obvious.
  let extra = remaining;

  for (let i = 0; i < count; i++) {
    let y1 = y + dashHeight;
    // We distribute left-over size in to dash widths,
    // since it's less obvious there than in the gaps.
    if (extra > 0) { extra -= 1; y1 += 1; }
    vline(canvas, y, y1, x, thickPx);
    // Advance by the height of the dash we drew and the height
    // of a gap to get the start of the next dash.
    y = y1 + gapHeight;
  }
}
