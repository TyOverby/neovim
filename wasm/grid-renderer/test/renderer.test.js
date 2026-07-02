// Unit tests for the renderer core: glyph cache behavior, damage tracking,
// cursor painting, colorization. No snapshots here - these assert pixels and
// counters directly.

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gridRenderer, makeRenderer } = require('./helpers.js');

function cell(text, fg, bg, extra) {
  return Object.assign({ text, fg, bg }, extra || {});
}

test('glyph atlas: repeated cells rasterize once', () => {
  const { renderer } = makeRenderer();
  renderer.resize(10, 2);
  const row = () => Array.from({ length: 10 }, () => cell('x', 0xffffff, 0x000000));
  renderer.render([row(), row()]);
  // 20 identical cells -> exactly 1 rasterization (miss), 19 atlas hits.
  assert.equal(renderer.atlas.misses, 1);
  assert.equal(renderer.atlas.hits, 19);
});

test('glyph atlas: distinct colors are distinct entries (no alpha-compositing reuse)', () => {
  const { renderer } = makeRenderer();
  renderer.resize(2, 1);
  renderer.render([[cell('x', 0xffffff, 0x000000), cell('x', 0xff0000, 0x000000)]]);
  assert.equal(renderer.atlas.misses, 2, 'same glyph, different fg -> separate bitmaps');
});

test('glyph atlas: LRU evicts oldest and reuses its slot', () => {
  const { GlyphAtlas } = gridRenderer();
  const { createCanvas } = require('canvas');
  const atlas = new GlyphAtlas((w, h) => createCanvas(w, h), 4, 8, 2);
  const src = createCanvas(4, 8);
  atlas.insert('a', src);
  const slotB = atlas.insert('b', src);
  const bX = slotB.x, bY = slotB.y;
  atlas.get('a');                       // refresh 'a' -> 'b' is now oldest
  const slotC = atlas.insert('c', src); // full: evicts 'b', reuses its slot
  assert.ok(atlas.get('a'), "'a' survived (recently used)");
  assert.equal(atlas.get('b'), undefined, "'b' evicted");
  assert.ok(atlas.get('c'));
  assert.equal(atlas.size, 2);
  assert.equal(slotC.x, bX, "'c' reuses 'b's slot pixels");
  assert.equal(slotC.y, bY);
});

test('glyph atlas: colorized pixels round-trip through the sheet', () => {
  const { renderer, canvas } = makeRenderer();
  renderer.resize(1, 1);
  renderer.render([[cell('█', 0x123456, 0x000000)]]);
  const px = canvas.getContext('2d').getImageData(3, 3, 1, 1).data;
  assert.deepEqual(Array.from(px.slice(0, 3)), [0x12, 0x34, 0x56]);
});

// The browser fast path ('drawImage'): must produce byte-identical output
// to the 'imageData' strategy.
test("blit strategy 'drawImage' produces the same pixels", () => {
  const strategies = ['imageData', 'drawImage'].map((blitStrategy) => {
    const { renderer, canvas } = makeRenderer({ blitStrategy });
    assert.equal(renderer.blitStrategy, blitStrategy);
    renderer.resize(3, 1);
    renderer.render([[cell('▚', 0xff8800, 0x000022), cell('A', 0xffffff, 0x123456), cell('░', 0x00ff00, 0x000000)]]);
    return canvas.toBuffer('image/png');
  });
  assert.deepEqual(strategies[0], strategies[1]);
});

test('damage tracking: unchanged cells are not re-blitted', () => {
  const { renderer } = makeRenderer();
  renderer.resize(4, 1);
  const grid = [[cell('a', 0xffffff, 0), cell('b', 0xffffff, 0), cell('c', 0xffffff, 0), cell('d', 0xffffff, 0)]];
  renderer.render(grid);
  assert.equal(renderer.blitCount, 4);
  renderer.render(grid);
  assert.equal(renderer.blitCount, 4, 'second identical render blits nothing');
  grid[0][2] = cell('X', 0xffffff, 0);
  renderer.render(grid);
  assert.equal(renderer.blitCount, 5, 'only the changed cell re-blits');
});

test('cursor: paints reverse video and repaints on move', () => {
  const { renderer, canvas } = makeRenderer();
  renderer.resize(2, 1);
  const grid = [[cell(' ', 0xffffff, 0x000000), cell(' ', 0xffffff, 0x000000)]];
  renderer.render(grid, { row: 0, col: 0 });
  const ctx = canvas.getContext('2d');
  const m = renderer.metrics;
  // Cursor cell = solid fg block (reverse of empty cell).
  assert.deepEqual(
    Array.from(ctx.getImageData(2, 2, 1, 1).data.slice(0, 3)), [255, 255, 255]);
  // Move the cursor: old cell restores, new cell inverts.
  renderer.render(grid, { row: 0, col: 1 });
  assert.deepEqual(
    Array.from(ctx.getImageData(2, 2, 1, 1).data.slice(0, 3)), [0, 0, 0]);
  assert.deepEqual(
    Array.from(ctx.getImageData(m.cellWidth + 2, 2, 1, 1).data.slice(0, 3)), [255, 255, 255]);
});

test('resize sets pixel dimensions from metrics', () => {
  const { renderer, canvas } = makeRenderer();
  renderer.resize(80, 24);
  assert.equal(canvas.width, 80 * renderer.metrics.cellWidth);
  assert.equal(canvas.height, 24 * renderer.metrics.cellHeight);
});

test('sprite codepoint registry covers the expected blocks', () => {
  const { isSpriteCodepoint } = gridRenderer();
  // Spot checks, one per ported module.
  for (const cp of [0x2500, 0x257f, 0x2580, 0x259f, 0x25e2, 0x2800, 0x28ff,
    0xe0b0, 0xf5d0, 0x1fb00, 0x1fb95, 0x1cd00, 0x1cde5, 0x1ce90]) {
    assert.ok(isSpriteCodepoint(cp), `U+${cp.toString(16)} should be a sprite`);
  }
  // And things that must NOT be sprites (font glyphs).
  for (const cp of [0x41 /* A */, 0x3042 /* あ */, 0x1f600 /* 😀 */]) {
    assert.ok(!isSpriteCodepoint(cp), `U+${cp.toString(16)} should not be a sprite`);
  }
});

test('wide cells blit one double-width bitmap', () => {
  const { renderer } = makeRenderer();
  renderer.resize(4, 1);
  renderer.render([[
    cell('漢', 0xffffff, 0x000000, { width: 2 }), cell('', 0xffffff, 0x000000),
    cell('a', 0xffffff, 0x000000), cell('b', 0xffffff, 0x000000),
  ]]);
  // 3 blits: the wide glyph (spanning cells 0-1), 'a', 'b'.
  assert.equal(renderer.blitCount, 3);
});
