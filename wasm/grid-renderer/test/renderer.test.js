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

test('glyph cache: repeated cells rasterize once', () => {
  const { renderer } = makeRenderer();
  renderer.resize(10, 2);
  const row = () => Array.from({ length: 10 }, () => cell('x', 0xffffff, 0x000000));
  renderer.render([row(), row()]);
  // 20 identical cells -> exactly 1 rasterization (miss), 19 cache hits.
  assert.equal(renderer.cache.misses, 1);
  assert.equal(renderer.cache.hits, 19);
});

test('glyph cache: distinct colors are distinct entries (no alpha-compositing reuse)', () => {
  const { renderer } = makeRenderer();
  renderer.resize(2, 1);
  renderer.render([[cell('x', 0xffffff, 0x000000), cell('x', 0xff0000, 0x000000)]]);
  assert.equal(renderer.cache.misses, 2, 'same glyph, different fg -> separate bitmaps');
});

test('glyph cache: LRU evicts oldest', () => {
  const { GlyphCache } = gridRenderer();
  const c = new GlyphCache(2);
  c.set('a', { width: 1, height: 1, data: new Uint8ClampedArray(4) });
  c.set('b', { width: 1, height: 1, data: new Uint8ClampedArray(4) });
  c.get('a');                                                       // refresh 'a'
  c.set('c', { width: 1, height: 1, data: new Uint8ClampedArray(4) }); // evicts 'b'
  assert.ok(c.get('a'), "'a' survived (recently used)");
  assert.equal(c.get('b'), undefined, "'b' evicted");
  assert.ok(c.get('c'));
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
