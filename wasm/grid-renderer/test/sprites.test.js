// Snapshot tests for the path-drawn sprite glyphs (box drawing, block
// elements, braille, powerline, branch, legacy computing, ...).
//
// Each Unicode block renders as a grid of cells with alternating fg/bg color
// pairs (so cell edges, colorization, and cell-filling geometry are all
// visible) and is compared against a committed golden PNG. Pure geometry -
// no font involvement - so these are stable across machines.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gridRenderer, makeRenderer, expectSnapshot, codepointGrid, range } = require('./helpers.js');

async function renderBlock(name, codepoints, cols) {
  const { renderer, canvas } = makeRenderer();
  const grid = codepointGrid(codepoints, cols);
  renderer.resize(cols, grid.length);
  renderer.render(grid);
  await expectSnapshot(canvas, name);
}

// Registered sprite codepoints within [min, max] (skips gaps ghostty leaves).
function registered(min, max) {
  const { isSpriteCodepoint } = gridRenderer();
  return range(min, max).filter(isSpriteCodepoint);
}

test('box drawing U+2500-257F', async () => {
  const cps = registered(0x2500, 0x257f);
  assert.equal(cps.length, 128, 'full box drawing block must be registered');
  await renderBlock('box-drawing', cps, 16);
});

test('block elements U+2580-259F', async () => {
  const cps = registered(0x2580, 0x259f);
  assert.equal(cps.length, 32, 'full block elements block must be registered');
  await renderBlock('block-elements', cps, 16);
});

test('geometric shapes (ghostty subset)', async () => {
  const cps = registered(0x25a0, 0x25ff);
  assert.ok(cps.length >= 8, `expected the ghostty geometric-shapes subset, got ${cps.length}`);
  await renderBlock('geometric-shapes', cps, 8);
});

test('braille U+2800-28FF', async () => {
  const cps = registered(0x2800, 0x28ff);
  assert.equal(cps.length, 256, 'full braille block must be registered');
  await renderBlock('braille', cps, 16);
});

test('powerline glyphs', async () => {
  const cps = registered(0xe0b0, 0xe0d4);
  assert.ok(cps.length >= 14, `expected the powerline set, got ${cps.length}`);
  await renderBlock('powerline', cps, 8);
});

test('branch drawing U+F5D0-F60D', async () => {
  const cps = registered(0xf5d0, 0xf60d);
  assert.equal(cps.length, 62, 'full branch drawing set must be registered');
  await renderBlock('branch-drawing', cps, 16);
});

test('symbols for legacy computing U+1FB00-1FBFF', async () => {
  const cps = registered(0x1fb00, 0x1fbff);
  assert.ok(cps.length >= 200, `expected most of the legacy computing block, got ${cps.length}`);
  await renderBlock('legacy-computing', cps, 16);
});

test('symbols for legacy computing supplement U+1CC00-1CEBF', async () => {
  const cps = registered(0x1cc00, 0x1cebf);
  assert.ok(cps.length >= 200, `expected a large supplement coverage, got ${cps.length}`);
  await renderBlock('legacy-computing-supplement', cps, 16);
});

// Box-drawing glyphs must fill the cell edge-to-edge so adjacent cells form
// continuous lines: a row of '─' must paint its horizontal line through
// every x, and a column of '│' through every y.
test('box drawing connects across cells', async () => {
  const { renderer, canvas } = makeRenderer();
  renderer.resize(4, 2);
  renderer.render([
    [c('─'), c('─'), c('─'), c('─')],
    [c('│'), c('│'), c('│'), c('│')],
  ]);
  const ctx = canvas.getContext('2d');
  const m = renderer.metrics;
  // Row of '─': the center scanline is white for the full row width.
  const mid = ctx.getImageData(0, Math.floor(m.cellHeight / 2), 4 * m.cellWidth, 1).data;
  for (let x = 0; x < 4 * m.cellWidth; x++) {
    assert.equal(mid[x * 4], 255, `horizontal line broken at x=${x}`);
  }
  // Row of '│': the center column is white for the full cell height.
  const cx = Math.floor(m.cellWidth / 2);
  const col = ctx.getImageData(cx, m.cellHeight, 1, m.cellHeight).data;
  for (let y = 0; y < m.cellHeight; y++) {
    assert.equal(col[y * 4], 255, `vertical line broken at y=${y}`);
  }

  function c(text) { return { text, fg: 0xffffff, bg: 0x000000 }; }
});

// The sprite shade characters must produce the ghostty shade levels
// (fg blended over bg at 0x40/0x80/0xc0).
test('shade blocks blend fg over bg', async () => {
  const { renderer, canvas } = makeRenderer();
  renderer.resize(3, 1);
  renderer.render([[
    { text: '░', fg: 0xff0000, bg: 0x000000 },
    { text: '▒', fg: 0xff0000, bg: 0x000000 },
    { text: '▓', fg: 0xff0000, bg: 0x000000 },
  ]]);
  const ctx = canvas.getContext('2d');
  const m = renderer.metrics;
  const px = (i) => ctx.getImageData(i * m.cellWidth + 2, 2, 1, 1).data;
  const approx = (a, b) => Math.abs(a - b) <= 2;
  assert.ok(approx(px(0)[0], 0x40), `light shade red ${px(0)[0]} != ~0x40`);
  assert.ok(approx(px(1)[0], 0x80), `medium shade red ${px(1)[0]} != ~0x80`);
  assert.ok(approx(px(2)[0], 0xc0), `dark shade red ${px(2)[0]} != ~0xc0`);
});
