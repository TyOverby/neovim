// Symbols for Legacy Computing | U+1FB00...U+1FBFF
// https://en.wikipedia.org/wiki/Symbols_for_Legacy_Computing
//
// 🬀 🬁 🬂 🬃 🬄 🬅 🬆 🬇 🬈 🬉 🬊 🬋 🬌 🬍 🬎 🬏
// 🬐 🬑 🬒 🬓 🬔 🬕 🬖 🬗 🬘 🬙 🬚 🬛 🬜 🬝 🬞 🬟
// 🬠 🬡 🬢 🬣 🬤 🬥 🬦 🬧 🬨 🬩 🬪 🬫 🬬 🬭 🬮 🬯
// 🬰 🬱 🬲 🬳 🬴 🬵 🬶 🬷 🬸 🬹 🬺 🬻 🬼 🬽 🬾 🬿
// 🭀 🭁 🭂 🭃 🭄 🭅 🭆 🭇 🭈 🭉 🭊 🭋 🭌 🭍 🭎 🭏
// 🭐 🭑 🭒 🭓 🭔 🭕 🭖 🭗 🭘 🭙 🭚 🭛 🭜 🭝 🭞 🭟
// 🭠 🭡 🭢 🭣 🭤 🭥 🭦 🭧 🭨 🭩 🭪 🭫 🭬 🭭 🭮 🭯
// 🭰 🭱 🭲 🭳 🭴 🭵 🭶 🭷 🭸 🭹 🭺 🭻 🭼 🭽 🭾 🭿
// 🮀 🮁 🮂 🮃 🮄 🮅 🮆 🮇 🮈 🮉 🮊 🮋 🮌 🮍 🮎 🮏
// 🮐 🮑 🮒   🮔 🮕 🮖 🮗 🮘 🮙 🮚 🮛 🮜 🮝 🮞 🮟
// 🮠 🮡 🮢 🮣 🮤 🮥 🮦 🮧 🮨 🮩 🮪 🮫 🮬 🮭 🮮 🮯
// 🮰 🮱 🮲 🮳 🮴 🮵 🮶 🮷 🮸 🮹 🮺 🮻 🮼 🮽 🮾 🮿
// 🯀 🯁 🯂 🯃 🯄 🯅 🯆 🯇 🯈 🯉 🯊 🯋 🯌 🯍 🯎 🯏
// 🯐 🯑 🯒 🯓 🯔 🯕 🯖 🯗 🯘 🯙 🯚 🯛 🯜 🯝 🯞 🯟
// 🯠 🯡 🯢 🯣 🯤 🯥 🯦 🯧 🯨 🯩 🯪 🯫 🯬 🯭 🯮 🯯
// 🯰 🯱 🯲 🯳 🯴 🯵 🯶 🯷 🯸 🯹
//
// Port of ghostty's src/font/sprite/draw/symbols_for_legacy_computing.zig.

import type { Metrics } from '../metrics';
import { SpriteCanvas, SHADE_ON, SHADE_MEDIUM } from '../sprite-canvas';
import {
  DrawFn, Alignment, ALIGN, Quads, Edge, thicknessHeight,
  fill, fracFloat, eighths, idiv, satSub, round,
  one_eighth, one_quarter, one_third, three_eighths, half, five_eighths,
  two_thirds, three_quarters, seven_eighths,
} from './common';
import { linesChar, lightDiagonalCross } from './box';
import { block, blockShade, fullBlockShade } from './block';
import { cornerTriangleShade } from './geometric_shapes';

// Ghostty's SmoothMosaic packed struct (u10): which corner / edge-midpoint
// vertices participate in the filled polygon outline (clockwise from the
// top-left): tl, ul, ll, bl, bc, br, lr, ur, tr, tc.
interface SmoothMosaic {
  tl: boolean;
  ul: boolean;
  ll: boolean;
  bl: boolean;
  bc: boolean;
  br: boolean;
  lr: boolean;
  ur: boolean;
  tr: boolean;
  tc: boolean;
}

// SmoothMosaic.from: `rows` are the four 3-char rows of the pattern; joined
// with '\n' they index exactly like ghostty's 15-byte pattern literal.
function smoothMosaicFrom(...rows: [string, string, string, string]): SmoothMosaic {
  const pattern = rows.join('\n');
  return {
    tl: pattern[0] === '#',

    ul: pattern[4] === '#' &&
      (pattern[0] !== '#' || pattern[8] !== '#'),

    ll: pattern[8] === '#' &&
      (pattern[4] !== '#' || pattern[12] !== '#'),

    bl: pattern[12] === '#',

    bc: pattern[13] === '#' &&
      (pattern[12] !== '#' || pattern[14] !== '#'),

    br: pattern[14] === '#',

    lr: pattern[10] === '#' &&
      (pattern[14] !== '#' || pattern[6] !== '#'),

    ur: pattern[6] === '#' &&
      (pattern[10] !== '#' || pattern[2] !== '#'),

    tr: pattern[2] === '#',

    tc: pattern[1] === '#' &&
      (pattern[2] !== '#' || pattern[0] !== '#'),
  };
}

// Sextants
export const draw1FB00_1FB3B: DrawFn = (cp, canvas, _width, _height, metrics) => {
  // Sextants packed struct (u6, LSB first): tl, tr, ml, mr, bl, br.
  const idx = cp - 0x1fb00;
  const sex = idx + idiv(idx, 0x14) + 1;

  if (sex & 0b000001) { fill(metrics, canvas, 0, half, 0, one_third); } // tl
  if (sex & 0b000010) { fill(metrics, canvas, half, 1, 0, one_third); } // tr
  if (sex & 0b000100) { fill(metrics, canvas, 0, half, one_third, two_thirds); } // ml
  if (sex & 0b001000) { fill(metrics, canvas, half, 1, one_third, two_thirds); } // mr
  if (sex & 0b010000) { fill(metrics, canvas, 0, half, two_thirds, 1); } // bl
  if (sex & 0b100000) { fill(metrics, canvas, half, 1, two_thirds, 1); } // br
};

// Smooth Mosaics
export const draw1FB3C_1FB67: DrawFn = (cp, canvas, _width, _height, metrics) => {
  // Hand written lookup table for these shapes since I couldn't
  // determine any sort of mathematical pattern in the codepoints.
  let mosaic: SmoothMosaic;
  switch (cp) {
  // '🬼'
  case 0x1fb3c: mosaic = smoothMosaicFrom(
    '...',
    '...',
    '#..',
    '##.',
  ); break;
  // '🬽'
  case 0x1fb3d: mosaic = smoothMosaicFrom(
    '...',
    '...',
    '#\\.',
    '###',
  ); break;
  // '🬾'
  case 0x1fb3e: mosaic = smoothMosaicFrom(
    '...',
    '#..',
    '#\\.',
    '##.',
  ); break;
  // '🬿'
  case 0x1fb3f: mosaic = smoothMosaicFrom(
    '...',
    '#..',
    '##.',
    '###',
  ); break;
  // '🭀'
  case 0x1fb40: mosaic = smoothMosaicFrom(
    '#..',
    '#..',
    '##.',
    '##.',
  ); break;

  // '🭁'
  case 0x1fb41: mosaic = smoothMosaicFrom(
    '/##',
    '###',
    '###',
    '###',
  ); break;
  // '🭂'
  case 0x1fb42: mosaic = smoothMosaicFrom(
    './#',
    '###',
    '###',
    '###',
  ); break;
  // '🭃'
  case 0x1fb43: mosaic = smoothMosaicFrom(
    '.##',
    '.##',
    '###',
    '###',
  ); break;
  // '🭄'
  case 0x1fb44: mosaic = smoothMosaicFrom(
    '..#',
    '.##',
    '###',
    '###',
  ); break;
  // '🭅'
  case 0x1fb45: mosaic = smoothMosaicFrom(
    '.##',
    '.##',
    '.##',
    '###',
  ); break;
  // '🭆'
  case 0x1fb46: mosaic = smoothMosaicFrom(
    '...',
    './#',
    '###',
    '###',
  ); break;

  // '🭇'
  case 0x1fb47: mosaic = smoothMosaicFrom(
    '...',
    '...',
    '..#',
    '.##',
  ); break;
  // '🭈'
  case 0x1fb48: mosaic = smoothMosaicFrom(
    '...',
    '...',
    './#',
    '###',
  ); break;
  // '🭉'
  case 0x1fb49: mosaic = smoothMosaicFrom(
    '...',
    '..#',
    './#',
    '.##',
  ); break;
  // '🭊'
  case 0x1fb4a: mosaic = smoothMosaicFrom(
    '...',
    '..#',
    '.##',
    '###',
  ); break;
  // '🭋'
  case 0x1fb4b: mosaic = smoothMosaicFrom(
    '..#',
    '..#',
    '.##',
    '.##',
  ); break;

  // '🭌'
  case 0x1fb4c: mosaic = smoothMosaicFrom(
    '##\\',
    '###',
    '###',
    '###',
  ); break;
  // '🭍'
  case 0x1fb4d: mosaic = smoothMosaicFrom(
    '#\\.',
    '###',
    '###',
    '###',
  ); break;
  // '🭎'
  case 0x1fb4e: mosaic = smoothMosaicFrom(
    '##.',
    '##.',
    '###',
    '###',
  ); break;
  // '🭏'
  case 0x1fb4f: mosaic = smoothMosaicFrom(
    '#..',
    '##.',
    '###',
    '###',
  ); break;
  // '🭐'
  case 0x1fb50: mosaic = smoothMosaicFrom(
    '##.',
    '##.',
    '##.',
    '###',
  ); break;
  // '🭑'
  case 0x1fb51: mosaic = smoothMosaicFrom(
    '...',
    '#\\.',
    '###',
    '###',
  ); break;

  // '🭒'
  case 0x1fb52: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '###',
    '\\##',
  ); break;
  // '🭓'
  case 0x1fb53: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '###',
    '.\\#',
  ); break;
  // '🭔'
  case 0x1fb54: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '.##',
    '.##',
  ); break;
  // '🭕'
  case 0x1fb55: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '.##',
    '..#',
  ); break;
  // '🭖'
  case 0x1fb56: mosaic = smoothMosaicFrom(
    '###',
    '.##',
    '.##',
    '.##',
  ); break;

  // '🭗'
  case 0x1fb57: mosaic = smoothMosaicFrom(
    '##.',
    '#..',
    '...',
    '...',
  ); break;
  // '🭘'
  case 0x1fb58: mosaic = smoothMosaicFrom(
    '###',
    '#/.',
    '...',
    '...',
  ); break;
  // '🭙'
  case 0x1fb59: mosaic = smoothMosaicFrom(
    '##.',
    '#/.',
    '#..',
    '...',
  ); break;
  // '🭚'
  case 0x1fb5a: mosaic = smoothMosaicFrom(
    '###',
    '##.',
    '#..',
    '...',
  ); break;
  // '🭛'
  case 0x1fb5b: mosaic = smoothMosaicFrom(
    '##.',
    '##.',
    '#..',
    '#..',
  ); break;

  // '🭜'
  case 0x1fb5c: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '#/.',
    '...',
  ); break;
  // '🭝'
  case 0x1fb5d: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '###',
    '##/',
  ); break;
  // '🭞'
  case 0x1fb5e: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '###',
    '#/.',
  ); break;
  // '🭟'
  case 0x1fb5f: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '##.',
    '##.',
  ); break;
  // '🭠'
  case 0x1fb60: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '##.',
    '#..',
  ); break;
  // '🭡'
  case 0x1fb61: mosaic = smoothMosaicFrom(
    '###',
    '##.',
    '##.',
    '##.',
  ); break;

  // '🭢'
  case 0x1fb62: mosaic = smoothMosaicFrom(
    '.##',
    '..#',
    '...',
    '...',
  ); break;
  // '🭣'
  case 0x1fb63: mosaic = smoothMosaicFrom(
    '###',
    '.\\#',
    '...',
    '...',
  ); break;
  // '🭤'
  case 0x1fb64: mosaic = smoothMosaicFrom(
    '.##',
    '.\\#',
    '..#',
    '...',
  ); break;
  // '🭥'
  case 0x1fb65: mosaic = smoothMosaicFrom(
    '###',
    '.##',
    '..#',
    '...',
  ); break;
  // '🭦'
  case 0x1fb66: mosaic = smoothMosaicFrom(
    '.##',
    '.##',
    '..#',
    '..#',
  ); break;
  // '🭧'
  case 0x1fb67: mosaic = smoothMosaicFrom(
    '###',
    '###',
    '.\\#',
    '...',
  ); break;
  default: return;
  }

  const top: number = 0.0;
  const upper: number = fracFloat(one_third, metrics.cellHeight);
  const lower: number = fracFloat(two_thirds, metrics.cellHeight);
  const bottom: number = metrics.cellHeight;
  const left: number = 0.0;
  const center: number = fracFloat(half, metrics.cellWidth);
  const right: number = metrics.cellWidth;

  const path = canvas.path();
  if (mosaic.tl) { path.lineTo(left, top); }
  if (mosaic.ul) { path.lineTo(left, upper); }
  if (mosaic.ll) { path.lineTo(left, lower); }
  if (mosaic.bl) { path.lineTo(left, bottom); }
  if (mosaic.bc) { path.lineTo(center, bottom); }
  if (mosaic.br) { path.lineTo(right, bottom); }
  if (mosaic.lr) { path.lineTo(right, lower); }
  if (mosaic.ur) { path.lineTo(right, upper); }
  if (mosaic.tr) { path.lineTo(right, top); }
  if (mosaic.tc) { path.lineTo(center, top); }
  path.close();

  canvas.fillPath(path, SHADE_ON);
};

export const draw1FB68_1FB6F: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '🭨'
  case 0x1fb68:
    edgeTriangle(metrics, canvas, 'left');
    canvas.invert();
    // Set the clip so we don't include anything outside of the cell.
    canvas.clipLeft = canvas.paddingX;
    canvas.clipRight = canvas.paddingX;
    canvas.clipTop = canvas.paddingY;
    canvas.clipBottom = canvas.paddingY;
    break;
  // '🭩'
  case 0x1fb69:
    edgeTriangle(metrics, canvas, 'top');
    canvas.invert();
    // Set the clip so we don't include anything outside of the cell.
    canvas.clipLeft = canvas.paddingX;
    canvas.clipRight = canvas.paddingX;
    canvas.clipTop = canvas.paddingY;
    canvas.clipBottom = canvas.paddingY;
    break;
  // '🭪'
  case 0x1fb6a:
    edgeTriangle(metrics, canvas, 'right');
    canvas.invert();
    // Set the clip so we don't include anything outside of the cell.
    canvas.clipLeft = canvas.paddingX;
    canvas.clipRight = canvas.paddingX;
    canvas.clipTop = canvas.paddingY;
    canvas.clipBottom = canvas.paddingY;
    break;
  // '🭫'
  case 0x1fb6b:
    edgeTriangle(metrics, canvas, 'bottom');
    canvas.invert();
    // Set the clip so we don't include anything outside of the cell.
    canvas.clipLeft = canvas.paddingX;
    canvas.clipRight = canvas.paddingX;
    canvas.clipTop = canvas.paddingY;
    canvas.clipBottom = canvas.paddingY;
    break;
  // '🭬'
  case 0x1fb6c: edgeTriangle(metrics, canvas, 'left'); break;
  // '🭭'
  case 0x1fb6d: edgeTriangle(metrics, canvas, 'top'); break;
  // '🭮'
  case 0x1fb6e: edgeTriangle(metrics, canvas, 'right'); break;
  // '🭯'
  case 0x1fb6f: edgeTriangle(metrics, canvas, 'bottom'); break;
  }
};

// Vertical one eighth blocks
export const draw1FB70_1FB75: DrawFn = (cp, canvas, _width, _height, metrics) => {
  const n = cp + 1 - 0x1fb70;

  fill(
    metrics,
    canvas,
    eighths[n],
    eighths[n + 1],
    0, // .top
    1, // .bottom
  );
};

// Horizontal one eighth blocks
export const draw1FB76_1FB7B: DrawFn = (cp, canvas, _width, _height, metrics) => {
  const n = cp + 1 - 0x1fb76;

  fill(
    metrics,
    canvas,
    0, // .left
    1, // .right
    eighths[n],
    eighths[n + 1],
  );
};

export const draw1FB7C_1FB97: DrawFn = (cp, canvas, width, height, metrics) => {
  switch (cp) {

  // '🭼' LEFT AND LOWER ONE EIGHTH BLOCK
  case 0x1fb7c:
    block(metrics, canvas, ALIGN.left, one_eighth, 1);
    block(metrics, canvas, ALIGN.lower, 1, one_eighth);
    break;
  // '🭽' LEFT AND UPPER ONE EIGHTH BLOCK
  case 0x1fb7d:
    block(metrics, canvas, ALIGN.left, one_eighth, 1);
    block(metrics, canvas, ALIGN.upper, 1, one_eighth);
    break;
  // '🭾' RIGHT AND UPPER ONE EIGHTH BLOCK
  case 0x1fb7e:
    block(metrics, canvas, ALIGN.right, one_eighth, 1);
    block(metrics, canvas, ALIGN.upper, 1, one_eighth);
    break;
  // '🭿' RIGHT AND LOWER ONE EIGHTH BLOCK
  case 0x1fb7f:
    block(metrics, canvas, ALIGN.right, one_eighth, 1);
    block(metrics, canvas, ALIGN.lower, 1, one_eighth);
    break;
  // '🮀' UPPER AND LOWER ONE EIGHTH BLOCK
  case 0x1fb80:
    block(metrics, canvas, ALIGN.upper, 1, one_eighth);
    block(metrics, canvas, ALIGN.lower, 1, one_eighth);
    break;
  // '🮁' Horizontal One Eighth Block 1358
  case 0x1fb81:
    // We just call the draw function for each of the relevant codepoints.
    // The first codepoint is actually a lie, it's before the range, but
    // we need it to get the first (0th) block position. This might be a
    // bit brittle, oh well, if it breaks we can fix it.
    draw1FB76_1FB7B(0x1fb74 + 1, canvas, width, height, metrics);
    draw1FB76_1FB7B(0x1fb74 + 3, canvas, width, height, metrics);
    draw1FB76_1FB7B(0x1fb74 + 5, canvas, width, height, metrics);
    draw1FB76_1FB7B(0x1fb74 + 8, canvas, width, height, metrics);
    break;

  // '🮂' UPPER ONE QUARTER BLOCK
  case 0x1fb82: block(metrics, canvas, ALIGN.upper, 1, one_quarter); break;
  // '🮃' UPPER THREE EIGHTHS BLOCK
  case 0x1fb83: block(metrics, canvas, ALIGN.upper, 1, three_eighths); break;
  // '🮄' UPPER FIVE EIGHTHS BLOCK
  case 0x1fb84: block(metrics, canvas, ALIGN.upper, 1, five_eighths); break;
  // '🮅' UPPER THREE QUARTERS BLOCK
  case 0x1fb85: block(metrics, canvas, ALIGN.upper, 1, three_quarters); break;
  // '🮆' UPPER SEVEN EIGHTHS BLOCK
  case 0x1fb86: block(metrics, canvas, ALIGN.upper, 1, seven_eighths); break;

  // '🮇' RIGHT ONE QUARTER BLOCK
  case 0x1fb87: block(metrics, canvas, ALIGN.right, one_quarter, 1); break;
  // '🮈' RIGHT THREE EIGHTHS BLOCK
  case 0x1fb88: block(metrics, canvas, ALIGN.right, three_eighths, 1); break;
  // '🮉' RIGHT FIVE EIGHTHS BLOCK
  case 0x1fb89: block(metrics, canvas, ALIGN.right, five_eighths, 1); break;
  // '🮊' RIGHT THREE QUARTERS BLOCK
  case 0x1fb8a: block(metrics, canvas, ALIGN.right, three_quarters, 1); break;
  // '🮋' RIGHT SEVEN EIGHTHS BLOCK/
  case 0x1fb8b: block(metrics, canvas, ALIGN.right, seven_eighths, 1); break;

  // '🮌'
  case 0x1fb8c: blockShade(metrics, canvas, ALIGN.left, half, 1, SHADE_MEDIUM); break;
  // '🮍'
  case 0x1fb8d: blockShade(metrics, canvas, ALIGN.right, half, 1, SHADE_MEDIUM); break;
  // '🮎'
  case 0x1fb8e: blockShade(metrics, canvas, ALIGN.upper, 1, half, SHADE_MEDIUM); break;
  // '🮏'
  case 0x1fb8f: blockShade(metrics, canvas, ALIGN.lower, 1, half, SHADE_MEDIUM); break;

  // '🮐'
  case 0x1fb90: fullBlockShade(metrics, canvas, SHADE_MEDIUM); break;
  // '🮑'
  case 0x1fb91:
    fullBlockShade(metrics, canvas, SHADE_MEDIUM);
    block(metrics, canvas, ALIGN.upper, 1, half);
    break;
  // '🮒'
  case 0x1fb92:
    fullBlockShade(metrics, canvas, SHADE_MEDIUM);
    block(metrics, canvas, ALIGN.lower, 1, half);
    break;
  case 0x1fb93:
    // NOTE: This codepoint is currently un-allocated, it's a hole
    //       in the unicode block, so it's safe to just render it
    //       as an empty glyph, probably.
    break;
  // '🮔'
  case 0x1fb94:
    fullBlockShade(metrics, canvas, SHADE_MEDIUM);
    block(metrics, canvas, ALIGN.right, half, 1);
    break;
  // '🮕'
  case 0x1fb95: checkerboardFill(metrics, canvas, 0); break;
  // '🮖'
  case 0x1fb96: checkerboardFill(metrics, canvas, 1); break;
  // '🮗'
  case 0x1fb97:
    canvas.box(
      0,
      idiv(height, 4),
      width,
      idiv(2 * height, 4),
      SHADE_ON,
    );
    canvas.box(
      0,
      idiv(3 * height, 4),
      width,
      height,
      SHADE_ON,
    );
    break;
  }
};

// Upper Left to Lower Right Fill
// 🮘
export const draw1FB98: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;

  // TODO: This doesn't align properly for most cell sizes, fix that.

  const thick_px = thicknessHeight('light', metrics.boxThickness);
  const line_count = idiv(metrics.cellWidth, 2 * thick_px);

  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;
  const float_thick: number = thick_px;
  const stride = round(float_width / line_count);

  for (let _i = 0; _i < line_count * 2 + 1; _i++) {
    const i = _i - line_count;
    const top_x = i * stride;
    const bottom_x = float_width + top_x;
    canvas.line({
      p0: { x: top_x, y: 0 },
      p1: { x: bottom_x, y: float_height },
    }, float_thick, SHADE_ON);
  }
};

// Upper Right to Lower Left Fill
// 🮙
export const draw1FB99: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;

  // TODO: This doesn't align properly for most cell sizes, fix that.

  const thick_px = thicknessHeight('light', metrics.boxThickness);
  const line_count = idiv(metrics.cellWidth, 2 * thick_px);

  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;
  const float_thick: number = thick_px;
  const stride = round(float_width / line_count);

  for (let _i = 0; _i < line_count * 2 + 1; _i++) {
    const i = _i - line_count;
    const bottom_x = i * stride;
    const top_x = float_width + bottom_x;
    canvas.line({
      p0: { x: top_x, y: 0 },
      p1: { x: bottom_x, y: float_height },
    }, float_thick, SHADE_ON);
  }
};

export const draw1FB9A_1FB9F: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '🮚'
  case 0x1fb9a:
    edgeTriangle(metrics, canvas, 'top');
    edgeTriangle(metrics, canvas, 'bottom');
    break;
  // '🮛'
  case 0x1fb9b:
    edgeTriangle(metrics, canvas, 'left');
    edgeTriangle(metrics, canvas, 'right');
    break;
  // '🮜'
  case 0x1fb9c: cornerTriangleShade(metrics, canvas, 'tl', SHADE_MEDIUM); break;
  // '🮝'
  case 0x1fb9d: cornerTriangleShade(metrics, canvas, 'tr', SHADE_MEDIUM); break;
  // '🮞'
  case 0x1fb9e: cornerTriangleShade(metrics, canvas, 'br', SHADE_MEDIUM); break;
  // '🮟'
  case 0x1fb9f: cornerTriangleShade(metrics, canvas, 'bl', SHADE_MEDIUM); break;
  }
};

export const draw1FBA0_1FBAE: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '🮠'
  case 0x1fba0: cornerDiagonalLines(metrics, canvas, { tl: true }); break;
  // '🮡'
  case 0x1fba1: cornerDiagonalLines(metrics, canvas, { tr: true }); break;
  // '🮢'
  case 0x1fba2: cornerDiagonalLines(metrics, canvas, { bl: true }); break;
  // '🮣'
  case 0x1fba3: cornerDiagonalLines(metrics, canvas, { br: true }); break;
  // '🮤'
  case 0x1fba4: cornerDiagonalLines(metrics, canvas, { tl: true, bl: true }); break;
  // '🮥'
  case 0x1fba5: cornerDiagonalLines(metrics, canvas, { tr: true, br: true }); break;
  // '🮦'
  case 0x1fba6: cornerDiagonalLines(metrics, canvas, { bl: true, br: true }); break;
  // '🮧'
  case 0x1fba7: cornerDiagonalLines(metrics, canvas, { tl: true, tr: true }); break;
  // '🮨'
  case 0x1fba8: cornerDiagonalLines(metrics, canvas, { tl: true, br: true }); break;
  // '🮩'
  case 0x1fba9: cornerDiagonalLines(metrics, canvas, { tr: true, bl: true }); break;
  // '🮪'
  case 0x1fbaa: cornerDiagonalLines(metrics, canvas, { tr: true, bl: true, br: true }); break;
  // '🮫'
  case 0x1fbab: cornerDiagonalLines(metrics, canvas, { tl: true, bl: true, br: true }); break;
  // '🮬'
  case 0x1fbac: cornerDiagonalLines(metrics, canvas, { tl: true, tr: true, br: true }); break;
  // '🮭'
  case 0x1fbad: cornerDiagonalLines(metrics, canvas, { tl: true, tr: true, bl: true }); break;
  // '🮮'
  case 0x1fbae: cornerDiagonalLines(metrics, canvas, { tl: true, tr: true, bl: true, br: true }); break;
  }
};

// 🮯
export const draw1FBAF: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  linesChar(metrics, canvas, {
    up: 'heavy',
    down: 'heavy',
    left: 'light',
    right: 'light',
  });
};

// 🮽
export const draw1FBBD: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  lightDiagonalCross(metrics, canvas);
  canvas.invert();
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;
};

// 🮾
export const draw1FBBE: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  cornerDiagonalLines(metrics, canvas, { br: true });
  canvas.invert();
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;
};

// 🮿
export const draw1FBBF: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  cornerDiagonalLines(metrics, canvas, {
    tl: true,
    tr: true,
    bl: true,
    br: true,
  });
  canvas.invert();
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;
};

// 🯎
export const draw1FBCE: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  block(metrics, canvas, ALIGN.left, two_thirds, 1);
};

// 🯏
export const draw1FBCF: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  block(metrics, canvas, ALIGN.left, one_third, 1);
};

// Cell diagonals.
export const draw1FBD0_1FBDF: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '🯐'
  case 0x1fbd0: cellDiagonal(
    metrics,
    canvas,
    ALIGN.right, // .middle_right
    ALIGN.lower_left,
  ); break;
  // '🯑'
  case 0x1fbd1: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper_right,
    ALIGN.left, // .middle_left
  ); break;
  // '🯒'
  case 0x1fbd2: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper_left,
    ALIGN.right, // .middle_right
  ); break;
  // '🯓'
  case 0x1fbd3: cellDiagonal(
    metrics,
    canvas,
    ALIGN.left, // .middle_left
    ALIGN.lower_right,
  ); break;
  // '🯔'
  case 0x1fbd4: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper_left,
    ALIGN.lower, // .lower_center
  ); break;
  // '🯕'
  case 0x1fbd5: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper, // .upper_center
    ALIGN.lower_right,
  ); break;
  // '🯖'
  case 0x1fbd6: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper_right,
    ALIGN.lower, // .lower_center
  ); break;
  // '🯗'
  case 0x1fbd7: cellDiagonal(
    metrics,
    canvas,
    ALIGN.upper, // .upper_center
    ALIGN.lower_left,
  ); break;
  // '🯘'
  case 0x1fbd8:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_left,
      ALIGN.center, // .middle_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.center, // .middle_center
      ALIGN.upper_right,
    );
    break;
  // '🯙'
  case 0x1fbd9:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_right,
      ALIGN.center, // .middle_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.center, // .middle_center
      ALIGN.lower_right,
    );
    break;
  // '🯚'
  case 0x1fbda:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.lower_left,
      ALIGN.center, // .middle_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.center, // .middle_center
      ALIGN.lower_right,
    );
    break;
  // '🯛'
  case 0x1fbdb:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_left,
      ALIGN.center, // .middle_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.center, // .middle_center
      ALIGN.lower_left,
    );
    break;
  // '🯜'
  case 0x1fbdc:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_left,
      ALIGN.lower, // .lower_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.lower, // .lower_center
      ALIGN.upper_right,
    );
    break;
  // '🯝'
  case 0x1fbdd:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_right,
      ALIGN.left, // .middle_left
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.left, // .middle_left
      ALIGN.lower_right,
    );
    break;
  // '🯞'
  case 0x1fbde:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.lower_left,
      ALIGN.upper, // .upper_center
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper, // .upper_center
      ALIGN.lower_right,
    );
    break;
  // '🯟'
  case 0x1fbdf:
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.upper_left,
      ALIGN.right, // .middle_right
    );
    cellDiagonal(
      metrics,
      canvas,
      ALIGN.right, // .middle_right
      ALIGN.lower_left,
    );
    break;
  }
};

export const draw1FBE0_1FBEF: DrawFn = (cp, canvas, _width, _height, metrics) => {
  switch (cp) {
  // '🯠'
  case 0x1fbe0: circle(metrics, canvas, ALIGN.upper /* .top */, false); break;
  // '🯡'
  case 0x1fbe1: circle(metrics, canvas, ALIGN.right, false); break;
  // '🯢'
  case 0x1fbe2: circle(metrics, canvas, ALIGN.lower /* .bottom */, false); break;
  // '🯣'
  case 0x1fbe3: circle(metrics, canvas, ALIGN.left, false); break;
  // '🯤'
  case 0x1fbe4: block(metrics, canvas, ALIGN.upper /* .upper_center */, 0.5, 0.5); break;
  // '🯥'
  case 0x1fbe5: block(metrics, canvas, ALIGN.lower /* .lower_center */, 0.5, 0.5); break;
  // '🯦'
  case 0x1fbe6: block(metrics, canvas, ALIGN.left /* .middle_left */, 0.5, 0.5); break;
  // '🯧'
  case 0x1fbe7: block(metrics, canvas, ALIGN.right /* .middle_right */, 0.5, 0.5); break;
  // '🯨'
  case 0x1fbe8: circle(metrics, canvas, ALIGN.upper /* .top */, true); break;
  // '🯩'
  case 0x1fbe9: circle(metrics, canvas, ALIGN.right, true); break;
  // '🯪'
  case 0x1fbea: circle(metrics, canvas, ALIGN.lower /* .bottom */, true); break;
  // '🯫'
  case 0x1fbeb: circle(metrics, canvas, ALIGN.left, true); break;
  // '🯬'
  case 0x1fbec: circle(metrics, canvas, ALIGN.upper_right /* .top_right */, true); break;
  // '🯭'
  case 0x1fbed: circle(metrics, canvas, ALIGN.lower_left /* .bottom_left */, true); break;
  // '🯮'
  case 0x1fbee: circle(metrics, canvas, ALIGN.lower_right /* .bottom_right */, true); break;
  // '🯯'
  case 0x1fbef: circle(metrics, canvas, ALIGN.upper_left /* .top_left */, true); break;
  }
};

function edgeTriangle(
  metrics: Metrics,
  canvas: SpriteCanvas,
  edge: Edge,
): void {
  const upper: number = 0.0;
  const middle: number = round(metrics.cellHeight / 2);
  const lower: number = metrics.cellHeight;
  const left: number = 0.0;
  const center: number = round(metrics.cellWidth / 2);
  const right: number = metrics.cellWidth;

  let x0: number, y0: number, x1: number, y1: number;
  switch (edge) {
  case 'top': x0 = right; y0 = upper; x1 = left; y1 = upper; break;
  case 'left': x0 = left; y0 = upper; x1 = left; y1 = lower; break;
  case 'bottom': x0 = left; y0 = lower; x1 = right; y1 = lower; break;
  case 'right': x0 = right; y0 = lower; x1 = right; y1 = upper; break;
  }

  const path = canvas.path();
  path.moveTo(center, middle);
  path.lineTo(x0, y0);
  path.lineTo(x1, y1);
  path.close();

  canvas.fillPath(path, SHADE_ON);
}

function cornerDiagonalLines(
  metrics: Metrics,
  canvas: SpriteCanvas,
  corners: Quads,
): void {
  const thick_px = thicknessHeight('light', metrics.boxThickness);

  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;
  const float_thick: number = thick_px;
  const center_x: number = idiv(metrics.cellWidth, 2) + metrics.cellWidth % 2;
  const center_y: number = idiv(metrics.cellHeight, 2) + metrics.cellHeight % 2;

  if (corners.tl) {
    canvas.line({
      p0: { x: center_x, y: 0 },
      p1: { x: 0, y: center_y },
    }, float_thick, SHADE_ON);
  }

  if (corners.tr) {
    canvas.line({
      p0: { x: center_x, y: 0 },
      p1: { x: float_width, y: center_y },
    }, float_thick, SHADE_ON);
  }

  if (corners.bl) {
    canvas.line({
      p0: { x: center_x, y: float_height },
      p1: { x: 0, y: center_y },
    }, float_thick, SHADE_ON);
  }

  if (corners.br) {
    canvas.line({
      p0: { x: center_x, y: float_height },
      p1: { x: float_width, y: center_y },
    }, float_thick, SHADE_ON);
  }
}

function cellDiagonal(
  metrics: Metrics,
  canvas: SpriteCanvas,
  from: Alignment,
  to: Alignment,
): void {
  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;

  const x0: number = from.horizontal === 'left' ? 0
    : from.horizontal === 'right' ? float_width
    : float_width / 2;
  const y0: number = from.vertical === 'top' ? 0
    : from.vertical === 'bottom' ? float_height
    : float_height / 2;
  const x1: number = to.horizontal === 'left' ? 0
    : to.horizontal === 'right' ? float_width
    : float_width / 2;
  const y1: number = to.vertical === 'top' ? 0
    : to.vertical === 'bottom' ? float_height
    : float_height / 2;

  canvas.line(
    {
      p0: { x: x0, y: y0 },
      p1: { x: x1, y: y1 },
    },
    thicknessHeight('light', metrics.boxThickness),
    SHADE_ON,
  );
}

function checkerboardFill(
  metrics: Metrics,
  canvas: SpriteCanvas,
  parity: number,
): void {
  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;
  const x_size = 4;
  const y_size = Math.trunc(round(4 * (float_height / float_width)));
  for (let x = 0; x < x_size; x++) {
    const x0 = idiv(metrics.cellWidth * x, x_size);
    const x1 = idiv(metrics.cellWidth * (x + 1), x_size);
    for (let y = 0; y < y_size; y++) {
      const y0 = idiv(metrics.cellHeight * y, y_size);
      const y1 = idiv(metrics.cellHeight * (y + 1), y_size);
      if ((x + y) % 2 === parity) {
        canvas.rect({
          x: x0,
          y: y0,
          width: satSub(x1, x0),
          height: satSub(y1, y0),
        }, SHADE_ON);
      }
    }
  }
}

export function circle(
  metrics: Metrics,
  canvas: SpriteCanvas,
  position: Alignment,
  filled: boolean,
): void {
  // Set the clip so we don't include anything outside of the cell.
  canvas.clipLeft = canvas.paddingX;
  canvas.clipRight = canvas.paddingX;
  canvas.clipTop = canvas.paddingY;
  canvas.clipBottom = canvas.paddingY;

  const float_width: number = metrics.cellWidth;
  const float_height: number = metrics.cellHeight;

  const x: number = position.horizontal === 'left' ? 0
    : position.horizontal === 'right' ? float_width
    : float_width / 2;
  const y: number = position.vertical === 'top' ? 0
    : position.vertical === 'bottom' ? float_height
    : float_height / 2;
  const r: number = 0.5 * Math.min(float_width, float_height);

  const line_width: number = thicknessHeight('light', metrics.boxThickness);

  if (filled) {
    const path = canvas.path();
    path.arc(x, y, r, 0, Math.PI * 2);
    path.close();
    canvas.fillPath(path, SHADE_ON);
  } else {
    const path = canvas.path();
    path.arc(x, y, r - line_width / 2, 0, Math.PI * 2);
    path.close();
    canvas.strokePath(path, { width: line_width }, SHADE_ON);
  }
}
