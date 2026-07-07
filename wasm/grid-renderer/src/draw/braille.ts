// Braille Patterns | U+2800...U+28FF
// https://en.wikipedia.org/wiki/Braille_Patterns
//
// (6 dot patterns)
// ⠀ ⠁ ⠂ ⠃ ⠄ ⠅ ⠆ ⠇ ⠈ ⠉ ⠊ ⠋ ⠌ ⠍ ⠎ ⠏
// ⠐ ⠑ ⠒ ⠓ ⠔ ⠕ ⠖ ⠗ ⠘ ⠙ ⠚ ⠛ ⠜ ⠝ ⠞ ⠟
// ⠠ ⠡ ⠢ ⠣ ⠤ ⠥ ⠦ ⠧ ⠨ ⠩ ⠪ ⠫ ⠬ ⠭ ⠮ ⠯
// ⠰ ⠱ ⠲ ⠳ ⠴ ⠵ ⠶ ⠷ ⠸ ⠹ ⠺ ⠻ ⠼ ⠽ ⠾ ⠿
//
// (8 dot patterns)
// ⡀ ⡁ ⡂ ⡃ ⡄ ⡅ ⡆ ⡇ ⡈ ⡉ ⡊ ⡋ ⡌ ⡍ ⡎ ⡏
// ⡐ ⡑ ⡒ ⡓ ⡔ ⡕ ⡖ ⡗ ⡘ ⡙ ⡚ ⡛ ⡜ ⡝ ⡞ ⡟
// ⡠ ⡡ ⡢ ⡣ ⡤ ⡥ ⡦ ⡧ ⡨ ⡩ ⡪ ⡫ ⡬ ⡭ ⡮ ⡯
// ⡰ ⡱ ⡲ ⡳ ⡴ ⡵ ⡶ ⡷ ⡸ ⡹ ⡺ ⡻ ⡼ ⡽ ⡾ ⡿
// ⢀ ⢁ ⢂ ⢃ ⢄ ⢅ ⢆ ⢇ ⢈ ⢉ ⢊ ⢋ ⢌ ⢍ ⢎ ⢏
// ⢐ ⢑ ⢒ ⢓ ⢔ ⢕ ⢖ ⢗ ⢘ ⢙ ⢚ ⢛ ⢜ ⢝ ⢞ ⢟
// ⢠ ⢡ ⢢ ⢣ ⢤ ⢥ ⢦ ⢧ ⢨ ⢩ ⢪ ⢫ ⢬ ⢭ ⢮ ⢯
// ⢰ ⢱ ⢲ ⢳ ⢴ ⢵ ⢶ ⢷ ⢸ ⢹ ⢺ ⢻ ⢼ ⢽ ⢾ ⢿
// ⣀ ⣁ ⣂ ⣃ ⣄ ⣅ ⣆ ⣇ ⣈ ⣉ ⣊ ⣋ ⣌ ⣍ ⣎ ⣏
// ⣐ ⣑ ⣒ ⣓ ⣔ ⣕ ⣖ ⣗ ⣘ ⣙ ⣚ ⣛ ⣜ ⣝ ⣞ ⣟
// ⣠ ⣡ ⣢ ⣣ ⣤ ⣥ ⣦ ⣧ ⣨ ⣩ ⣪ ⣫ ⣬ ⣭ ⣮ ⣯
// ⣰ ⣱ ⣲ ⣳ ⣴ ⣵ ⣶ ⣷ ⣸ ⣹ ⣺ ⣻ ⣼ ⣽ ⣾ ⣿
//
// Port of ghostty's src/font/sprite/draw/braille.zig.

import { SHADE_ON } from '../sprite-canvas';
import { DrawFn, idiv } from './common';

// A braille pattern.
//
// Mnemonic:
// [t]op    - .       .
// [u]pper  - .       .
// [l]ower  - .       .
// [b]ottom - .       .
//            |       |
//           [l]eft, [r]ight
//
// Struct layout matches bit patterns of unicode codepoints.
interface Pattern {
  tl: boolean;
  ul: boolean;
  ll: boolean;
  tr: boolean;
  ur: boolean;
  lr: boolean;
  bl: boolean;
  br: boolean;
}

function patternFrom(cp: number): Pattern {
  const b = cp & 0xff;
  return {
    tl: (b & 0x01) !== 0,
    ul: (b & 0x02) !== 0,
    ll: (b & 0x04) !== 0,
    tr: (b & 0x08) !== 0,
    ur: (b & 0x10) !== 0,
    lr: (b & 0x20) !== 0,
    bl: (b & 0x40) !== 0,
    br: (b & 0x80) !== 0,
  };
}

export const draw2800_28FF: DrawFn = (cp, canvas, width, height, _metrics) => {
  let w = Math.min(idiv(width, 4), idiv(height, 8));
  let xSpacing = idiv(width, 4);
  let ySpacing = idiv(height, 8);
  let xMargin = Math.floor(xSpacing / 2);
  let yMargin = Math.floor(ySpacing / 2);

  let xPxLeft = width - 2 * xMargin - xSpacing - 2 * w;
  let yPxLeft = height - 2 * yMargin - 3 * ySpacing - 4 * w;

  // First, try hard to ensure the DOT width is non-zero
  if (xPxLeft >= 2 && yPxLeft >= 4 && w === 0) {
    w += 1;
    xPxLeft -= 2;
    yPxLeft -= 4;
  }

  // Second, prefer a non-zero margin
  if (xPxLeft >= 2 && xMargin === 0) {
    xMargin = 1;
    xPxLeft -= 2;
  }
  if (yPxLeft >= 2 && yMargin === 0) {
    yMargin = 1;
    yPxLeft -= 2;
  }

  // Third, increase spacing
  if (xPxLeft >= 1) {
    xSpacing += 1;
    xPxLeft -= 1;
  }
  if (yPxLeft >= 3) {
    ySpacing += 1;
    yPxLeft -= 3;
  }

  // Fourth, margins ("spacing", but on the sides)
  if (xPxLeft >= 2) {
    xMargin += 1;
    xPxLeft -= 2;
  }
  if (yPxLeft >= 2) {
    yMargin += 1;
    yPxLeft -= 2;
  }

  // Last - increase dot width
  if (xPxLeft >= 2 && yPxLeft >= 4) {
    w += 1;
    xPxLeft -= 2;
    yPxLeft -= 4;
  }

  const x: [number, number] = [xMargin, xMargin + w + xSpacing];
  const y: [number, number, number, number] = [0, 0, 0, 0];
  y[0] = yMargin;
  y[1] = y[0] + w + ySpacing;
  y[2] = y[1] + w + ySpacing;
  y[3] = y[2] + w + ySpacing;

  const p = patternFrom(cp);

  if (p.tl) { canvas.box(x[0], y[0], x[0] + w, y[0] + w, SHADE_ON); }
  if (p.ul) { canvas.box(x[0], y[1], x[0] + w, y[1] + w, SHADE_ON); }
  if (p.ll) { canvas.box(x[0], y[2], x[0] + w, y[2] + w, SHADE_ON); }
  if (p.bl) { canvas.box(x[0], y[3], x[0] + w, y[3] + w, SHADE_ON); }
  if (p.tr) { canvas.box(x[1], y[0], x[1] + w, y[0] + w, SHADE_ON); }
  if (p.ur) { canvas.box(x[1], y[1], x[1] + w, y[1] + w, SHADE_ON); }
  if (p.lr) { canvas.box(x[1], y[2], x[1] + w, y[2] + w, SHADE_ON); }
  if (p.br) { canvas.box(x[1], y[3], x[1] + w, y[3] + w, SHADE_ON); }
};
