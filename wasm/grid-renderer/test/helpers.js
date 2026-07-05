// Test helpers: snapshot ("golden image") comparison with promotion, plus
// renderer construction on node-canvas (cairo).
//
// Methodology:
//   * Each test renders into a canvas and calls expectSnapshot(canvas, name).
//   * The rendered PNG is compared pixel-for-pixel against
//     test/baselines/<name>.png (committed to the repo).
//   * On mismatch (or missing baseline) the test FAILS and writes
//     test/__artifacts__/<name>.actual.png plus a red-highlighted
//     <name>.diff.png for inspection.
//   * To accept the current output as the new baseline: `npm run promote`
//     (equivalently SNAPSHOT_PROMOTE=1) - review the images before
//     committing them.
//
// Baselines are rasterizer-dependent (cairo via node-canvas + the host's
// fonts for TEXT glyphs). Sprite-glyph tests draw pure geometry - stable
// everywhere; text tests use DejaVu Sans Mono and may need a one-time
// `npm run promote` on a machine with different fonts.
//
// Why node-canvas and not a skia binding: both @napi-rs/canvas and
// skia-canvas RETAIN the pixel payload of every putImageData/drawImage call
// (unbounded native growth under sustained rendering - it OOM'd the bench);
// cairo is immediate-mode and stays flat.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');

const BASELINE_DIR = path.join(__dirname, 'baselines');
const ARTIFACT_DIR = path.join(__dirname, '__artifacts__');
const PROMOTE = !!process.env.SNAPSHOT_PROMOTE;

// The compiled package (dist/cjs). `npm test` builds first (pretest).
function gridRenderer() {
  return require('../dist/cjs/index.js');
}

// A GridRenderer drawing into a fresh node-canvas, with fixed metrics so
// baselines don't depend on font-metric rounding. Returns { renderer, canvas }.
function makeRenderer(opts) {
  const { GridRenderer } = gridRenderer();
  const target = createCanvas(1, 1);
  const renderer = new GridRenderer(target, Object.assign({
    createCanvas: (w, h) => createCanvas(w, h),
    fontFamily: '"DejaVu Sans Mono", monospace',
    fontSizePx: 16,
    // Pin the cell geometry: snapshot layout must not wobble if a font
    // substitution changes the measured advance width. 2px strokes center
    // exactly in the 10x20 cell.
    metrics: {
      cellWidth: 10, cellHeight: 20, baseline: 15,
      boxThickness: 2, underlinePosition: 16, underlineThickness: 2,
      strikethroughPosition: 10, strikethroughThickness: 2, cursorThickness: 2,
    },
  }, opts || {}));
  return { renderer, canvas: target };
}

function imageDataOf(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// NOTE: async for loadImage (works identically across node canvases).
async function pngToImageData(buf) {
  const img = await loadImage(buf);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

// Compare `canvas` against baselines/<name>.png (async - await it!). Options:
//   maxChannelDelta  per-channel tolerance (default 0 = exact)
//   maxDiffRatio     fraction of pixels allowed to exceed it (default 0)
async function expectSnapshot(canvas, name, options) {
  const opts = options || {};
  const maxChannelDelta = opts.maxChannelDelta || 0;
  const maxDiffRatio = opts.maxDiffRatio || 0;

  const baselinePath = path.join(BASELINE_DIR, name + '.png');
  const actualPng = canvas.toBuffer('image/png');

  if (!fs.existsSync(baselinePath)) {
    if (PROMOTE) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      fs.writeFileSync(baselinePath, actualPng);
      console.log(`  [snapshot] created baseline ${name}.png`);
      return;
    }
    writeArtifact(name + '.actual.png', actualPng);
    throw new Error(
      `snapshot '${name}': no baseline at ${baselinePath}.\n` +
      `  actual written to test/__artifacts__/${name}.actual.png\n` +
      `  run \`npm run promote\` to create it (review the image first!)`);
  }

  const expected = await pngToImageData(fs.readFileSync(baselinePath));
  const actual = imageDataOf(canvas);

  if (expected.width !== actual.width || expected.height !== actual.height) {
    if (PROMOTE) { fs.writeFileSync(baselinePath, actualPng); console.log(`  [snapshot] resized baseline ${name}.png`); return; }
    writeArtifact(name + '.actual.png', actualPng);
    throw new Error(
      `snapshot '${name}': size ${actual.width}x${actual.height} != baseline ` +
      `${expected.width}x${expected.height} (run \`npm run promote\` to accept)`);
  }

  const total = actual.width * actual.height;
  let diffCount = 0;
  const diff = createCanvas(actual.width, actual.height);
  const dctx = diff.getContext('2d');
  const dimg = dctx.createImageData(actual.width, actual.height);
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const delta = Math.max(
      Math.abs(actual.data[o] - expected.data[o]),
      Math.abs(actual.data[o + 1] - expected.data[o + 1]),
      Math.abs(actual.data[o + 2] - expected.data[o + 2]),
      Math.abs(actual.data[o + 3] - expected.data[o + 3]));
    if (delta > maxChannelDelta) {
      diffCount++;
      dimg.data[o] = 255; dimg.data[o + 1] = 0; dimg.data[o + 2] = 0; dimg.data[o + 3] = 255;
    } else {
      // Faded copy of the expected pixel for context.
      dimg.data[o] = expected.data[o]; dimg.data[o + 1] = expected.data[o + 1];
      dimg.data[o + 2] = expected.data[o + 2]; dimg.data[o + 3] = 64;
    }
  }

  if (diffCount / total > maxDiffRatio) {
    if (PROMOTE) {
      fs.writeFileSync(baselinePath, actualPng);
      console.log(`  [snapshot] updated baseline ${name}.png (${diffCount} px changed)`);
      return;
    }
    writeArtifact(name + '.actual.png', actualPng);
    dctx.putImageData(dimg, 0, 0);
    writeArtifact(name + '.diff.png', diff.toBuffer('image/png'));
    throw new Error(
      `snapshot '${name}': ${diffCount}/${total} pixels differ ` +
      `(tolerance: delta<=${maxChannelDelta}, ratio<=${maxDiffRatio}).\n` +
      `  see test/__artifacts__/${name}.{actual,diff}.png\n` +
      `  run \`npm run promote\` to accept the new output (review it first!)`);
  }
}

function writeArtifact(name, buf) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), buf);
}

// Render a block of codepoints as a labeled grid: `cols` glyphs per row.
// Returns a Cell[][] grid (checkerboarded fg/bg pairs so cell boundaries and
// colorization are visible in the snapshot).
function codepointGrid(codepoints, cols, palette) {
  const p = palette || [
    { fg: 0xe0e0e0, bg: 0x1c1c2e },
    { fg: 0x1c1c2e, bg: 0xd0d0ff },
  ];
  const grid = [];
  for (let i = 0; i < codepoints.length; i += cols) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      const idx = i + j;
      const colors = p[(Math.floor(i / cols) + j) % p.length];
      if (idx < codepoints.length) {
        row.push({ text: String.fromCodePoint(codepoints[idx]), fg: colors.fg, bg: colors.bg });
      } else {
        row.push({ text: ' ', fg: colors.fg, bg: colors.bg });
      }
    }
    grid.push(row);
  }
  return grid;
}

function range(min, max) {
  const out = [];
  for (let cp = min; cp <= max; cp++) { out.push(cp); }
  return out;
}

module.exports = {
  gridRenderer, makeRenderer, expectSnapshot, codepointGrid, range,
  createCanvas,
};
