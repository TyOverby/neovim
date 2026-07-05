// Snapshot tests for FONT-rendered cells (text, styles, decorations) and a
// composite "screen" scene mixing text with sprite glyphs.
//
// These exercise the image-backed glyph cache path: glyphs rasterized by the
// host font stack in their exact fg/bg pair. Baselines therefore depend on
// the machine's fonts + rasterizer (DejaVu Sans Mono assumed); on a machine
// that renders text differently, regenerate once with `npm run promote`.
//
// The composite scene includes CJK wide chars, whose FALLBACK font varies
// across machines even when DejaVu matches (e.g. GitHub runners ship a
// different Noto CJK build). SNAPSHOT_FONT_TOLERANCE=1 (set by CI) allows a
// small differing-pixel ratio on that scene only -- a broken renderer still
// blows far past it; the sprite/DejaVu scenes stay pixel-exact everywhere.

'use strict';
const test = require('node:test');
const { makeRenderer, expectSnapshot } = require('./helpers.js');

const FG = 0xe0e0e0, BG = 0x1c1c2e;

function cells(text, extra) {
  return [...text].map((ch) => Object.assign({ text: ch, fg: FG, bg: BG }, extra || {}));
}

test('text styles', async () => {
  const { renderer, canvas } = makeRenderer();
  const grid = [
    cells('regular   '),
    cells('bold      ', { bold: true }),
    cells('italic    ', { italic: true }),
    cells('underline ', { underline: true }),
    cells('undercurl ', { undercurl: true, sp: 0xff5050 }),
    cells('underdots ', { underdotted: true, sp: 0x50ff50 }),
    cells('underdash ', { underdashed: true }),
    cells('strike    ', { strikethrough: true }),
    cells('underdbl  ', { underdouble: true }),
  ];
  renderer.resize(10, grid.length);
  renderer.render(grid);
  await expectSnapshot(canvas, 'text-styles');
});

test('text colors', async () => {
  const { renderer, canvas } = makeRenderer();
  const palette = [0xff5050, 0x50ff50, 0x5050ff, 0xffff50, 0xff50ff, 0x50ffff];
  const grid = [0, 1].map((r) =>
    palette.map((c, i) => (r === 0
      ? { text: 'x', fg: c, bg: BG }
      : { text: 'x', fg: BG, bg: c })));
  renderer.resize(6, 2);
  renderer.render(grid);
  await expectSnapshot(canvas, 'text-colors');
});

test('composite screen: text + box borders + wide char + cursor', async () => {
  const { renderer, canvas } = makeRenderer();
  const W = 20;
  const top = [...'┌──────────────────┐'].map((ch) => ({ text: ch, fg: FG, bg: BG }));
  const bottom = [...'└──────────────────┘'].map((ch) => ({ text: ch, fg: FG, bg: BG }));
  const mid = (inner) => {
    const row = [{ text: '│', fg: FG, bg: BG }];
    for (const c of inner) { row.push(c); }
    while (row.length < W - 1) { row.push({ text: ' ', fg: FG, bg: BG }); }
    row.push({ text: '│', fg: FG, bg: BG });
    return row;
  };
  const grid = [
    top,
    mid(cells('hello ').concat([{ text: '世', fg: 0xffd700, bg: BG, width: 2 }, { text: '', fg: FG, bg: BG }, { text: '界', fg: 0xffd700, bg: BG, width: 2 }, { text: '', fg: FG, bg: BG }])),
    mid(cells('sprites: ').concat([...'▀▄█░▒▓'].map((ch) => ({ text: ch, fg: 0x50a0ff, bg: BG })))),
    bottom,
  ];
  renderer.resize(W, grid.length);
  renderer.render(grid, { row: 1, col: 2 });
  const fontTolerant = process.env.SNAPSHOT_FONT_TOLERANCE === '1';
  await expectSnapshot(canvas, 'composite-screen',
    fontTolerant ? { maxDiffRatio: 0.10 } : undefined);
});
