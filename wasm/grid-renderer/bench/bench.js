// Benchmark runner for the grid renderer (Node, @napi-rs/canvas).
//
//   npm run bench                     # all scenarios, default sizes
//   node bench/bench.js scroll        # one scenario
//   node bench/bench.js --cols 160 --rows 40 --frames 120 --dpr 2
//
// Reports per-frame wall time (mean / p50 / p95 / max) per scenario. The
// numbers are skia-on-CPU, not Chrome-on-GPU, so treat them as RELATIVE: use
// this to compare a change against the previous run, not to predict absolute
// browser frame times. The frame scenarios reproduce the shape of the real
// paint path (mount_into's per-flush render): a full Cell[][] walk with
// damage keys, cache lookups, and putImageData blits.
//
// Scenarios:
//   scroll        every visible row shifts up each frame (worst realistic
//                 case: 100% of cells change, glyph cache fully warm) - this
//                 is the "scrolling through a file" workload.
//   scroll-cold   same, but the cache is cleared every frame (rasterization
//                 cost; how bad a pathological cache miss storm would be).
//   edit          one line changes per frame (typical typing; damage diff
//                 should make this ~free).
//   noop          identical grid re-rendered (pure damage-diff walk: cellKey
//                 building + key comparison, zero blits).
//   sprites       scroll where ~1/3 of cells are box-drawing/braille/shade
//                 sprites (path-drawn rasterization on misses, then warm).
//   cache-get     microbench: GlyphCache.get hits/sec on a warm cache.
//   blit          microbench: putImageData of one cached cell bitmap.
//   rasterize     microbench: CellRasterizer.rasterize (text cells, no cache).
'use strict';

const { createCanvas } = require('@napi-rs/canvas');
const path = require('node:path');
const GR = require(path.join(__dirname, '..', 'dist', 'cjs', 'index.js'));

// ---- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { cols: 160, rows: 40, frames: 120, dpr: 2, fontSize: 16 };
const wanted = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--cols') { opts.cols = parseInt(args[++i], 10); }
  else if (a === '--rows') { opts.rows = parseInt(args[++i], 10); }
  else if (a === '--frames') { opts.frames = parseInt(args[++i], 10); }
  else if (a === '--dpr') { opts.dpr = parseFloat(args[++i]); }
  else if (a === '--font-size') { opts.fontSize = parseFloat(args[++i]); }
  else if (a.startsWith('--')) { console.error('unknown flag ' + a); process.exit(1); }
  else { wanted.push(a); }
}

// ---- deterministic content -------------------------------------------------
// Seeded LCG so every run renders the same "file" (reproducible numbers).
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

const PALETTE = [0xd4d4d4, 0x9cdcfe, 0xce9178, 0x6a9955, 0xdcdcaa, 0xc586c0, 0x569cd6];
const BG = 0x1e1e1e;
const WORDS = ['const', 'function', 'return', 'renderer', 'cell', 'grid', 'for',
  'let', 'cache', 'width', 'height', 'blit', 'frame', 'paint', 'if', 'else'];
const SPRITES = '─│┌┐└┘├┤┬┴┼═║╔╗╚╝▀▄█░▒▓▖▗▘▝⠁⠿⣿🬓🬔\u{1CD00}\u{1CD35}';

// A pseudo source-code line of styled cells, `cols` wide.
function makeLine(rand, cols, spriteRatio) {
  const cells = new Array(cols);
  let c = 0;
  const indent = Math.floor(rand() * 4) * 2;
  while (c < indent && c < cols) { cells[c++] = { text: ' ', fg: 0xd4d4d4, bg: BG }; }
  while (c < cols) {
    if (spriteRatio && rand() < spriteRatio) {
      // A run of sprite glyphs (box drawing / blocks / braille / octants).
      const glyphs = [...SPRITES];
      const g = glyphs[Math.floor(rand() * glyphs.length)];
      const fg = PALETTE[Math.floor(rand() * PALETTE.length)];
      const runLen = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < runLen && c < cols; k++) { cells[c++] = { text: g, fg, bg: BG }; }
    } else {
      const w = WORDS[Math.floor(rand() * WORDS.length)];
      const fg = PALETTE[Math.floor(rand() * PALETTE.length)];
      const bold = rand() < 0.08;
      for (let k = 0; k < w.length && c < cols; k++) {
        cells[c++] = bold ? { text: w[k], fg, bg: BG, bold: true } : { text: w[k], fg, bg: BG };
      }
    }
    if (c < cols) { cells[c++] = { text: ' ', fg: 0xd4d4d4, bg: BG }; }
  }
  return cells;
}

// A "file" of `total` lines to scroll a rows-high viewport through.
function makeBuffer(seed, total, cols, spriteRatio) {
  const rand = lcg(seed);
  const lines = new Array(total);
  for (let i = 0; i < total; i++) { lines[i] = makeLine(rand, cols, spriteRatio); }
  return lines;
}

// ---- renderer construction --------------------------------------------------
function makeRenderer() {
  const target = createCanvas(1, 1);
  const fontPx = Math.round(opts.fontSize * opts.dpr);
  const renderer = new GR.GridRenderer(target, {
    createCanvas: (w, h) => createCanvas(w, h),
    fontFamily: '"DejaVu Sans Mono", monospace',
    fontSizePx: fontPx,
  });
  renderer.resize(opts.cols, opts.rows);
  return renderer;
}

// ---- measurement harness -----------------------------------------------------
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { mean: sum / samples.length, p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] };
}

function fmt(ms) {
  return (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + 'ms';
}

const results = [];
// One scenario: `makeFrame` returns frame(i), called `frames` times after
// `warmup` untimed calls. `note` is printed alongside.
function scenario(name, { warmup = 10, frames = opts.frames, note = '' }, makeFrame) {
  if (wanted.length && !wanted.includes(name)) { return; }
  const frameFn = makeFrame();
  for (let i = 0; i < warmup; i++) { frameFn(i); }
  const samples = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const t0 = process.hrtime.bigint();
    frameFn(warmup + i);
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const s = stats(samples);
  results.push({ name, frames, ...s, note });
  console.log(
    name.padEnd(14) +
    ('mean ' + fmt(s.mean)).padEnd(14) +
    ('p50 ' + fmt(s.p50)).padEnd(13) +
    ('p95 ' + fmt(s.p95)).padEnd(13) +
    ('max ' + fmt(s.max)).padEnd(13) +
    (note ? '  ' + note : ''));
}

console.log(`grid-renderer bench: ${opts.cols}x${opts.rows} cells, font ${opts.fontSize}px @${opts.dpr}x ` +
  `(${opts.frames} frames/scenario, node ${process.version})`);
const CELLS = opts.cols * opts.rows;

// ---- frame scenarios ---------------------------------------------------------

scenario('scroll', { note: `${CELLS} cells, 100% damage, warm cache` }, () => {
  const renderer = makeRenderer();
  const buffer = makeBuffer(42, opts.frames + 200, opts.cols, 0);
  return (i) => {
    renderer.render(buffer.slice(i, i + opts.rows), { row: opts.rows - 1, col: 0 });
  };
});

scenario('scroll-cold', { note: 'cache cleared every frame' }, () => {
  const renderer = makeRenderer();
  const buffer = makeBuffer(42, opts.frames + 200, opts.cols, 0);
  return (i) => {
    renderer.cache.clear();
    renderer.render(buffer.slice(i, i + opts.rows), { row: opts.rows - 1, col: 0 });
  };
});

scenario('edit', { note: 'one line changes per frame' }, () => {
  const renderer = makeRenderer();
  const buffer = makeBuffer(42, opts.rows, opts.cols, 0);
  const alt = makeBuffer(1337, opts.frames + opts.rows + 10, opts.cols, 0);
  const grid = buffer.slice(0, opts.rows);
  renderer.render(grid, null);
  return (i) => {
    grid[i % opts.rows] = alt[i];
    renderer.render(grid, { row: i % opts.rows, col: 0 });
  };
});

scenario('noop', { note: 'unchanged grid (pure damage-diff walk)' }, () => {
  const renderer = makeRenderer();
  const grid = makeBuffer(42, opts.rows, opts.cols, 0);
  renderer.render(grid, null);
  return () => { renderer.render(grid, null); };
});

scenario('sprites', { note: 'scroll, ~1/3 sprite cells (box/braille/octant)' }, () => {
  const renderer = makeRenderer();
  const buffer = makeBuffer(42, opts.frames + 200, opts.cols, 0.33);
  return (i) => {
    renderer.render(buffer.slice(i, i + opts.rows), { row: opts.rows - 1, col: 0 });
  };
});

// ---- microbenches --------------------------------------------------------------
// Sized so one "frame" ~ one full-screen's worth of work (CELLS operations),
// making them directly comparable to the frame scenarios above.

scenario('cache-get', { note: `${CELLS} warm gets/frame` }, () => {
  const cache = new GR.GlyphCache(8192);
  const keys = [];
  for (let i = 0; i < 512; i++) {
    keys.push('key-' + i);
    cache.set(keys[i], { width: 1, height: 1, data: new Uint8ClampedArray(4) });
  }
  return () => {
    let x = 0;
    for (let i = 0; i < CELLS; i++) { x += cache.get(keys[i & 511]) ? 1 : 0; }
    if (x !== CELLS) { throw new Error('cache miss in warm bench'); }
  };
});

scenario('blit', { note: `${CELLS} putImageData/frame` }, () => {
  const renderer = makeRenderer();
  const cell = { text: 'x', fg: 0xd4d4d4, bg: BG };
  renderer.drawCell(0, 0, cell);            // warm the one bitmap
  const img = renderer.cache.get(GR.cellKey(cell));
  const ctx = renderer['ctx'] || renderer.ctx;
  const m = renderer.metrics;
  return () => {
    for (let i = 0; i < CELLS; i++) {
      ctx.putImageData(img, (i % opts.cols) * m.cellWidth, Math.floor(i / opts.cols) * m.cellHeight);
    }
  };
});

scenario('rasterize', { warmup: 2, frames: Math.min(opts.frames, 30), note: `${opts.cols} text cells/frame, no cache` }, () => {
  const renderer = makeRenderer();
  const rast = new GR.CellRasterizer(
    (w, h) => createCanvas(w, h),
    { fontFamily: '"DejaVu Sans Mono", monospace', fontSizePx: Math.round(opts.fontSize * opts.dpr) },
    renderer.metrics);
  return () => {
    for (let i = 0; i < opts.cols; i++) {
      rast.rasterize({ text: String.fromCharCode(33 + (i % 90)), fg: 0xd4d4d4, bg: BG });
    }
  };
});

// ---- summary --------------------------------------------------------------------
if (!results.length) {
  console.error('no scenario matched; known: scroll scroll-cold edit noop sprites cache-get blit rasterize');
  process.exit(1);
}
const budget = results.filter((r) => ['scroll', 'sprites'].includes(r.name));
if (budget.length) {
  console.log('');
  for (const r of budget) {
    const fps = 1000 / r.mean;
    console.log(`${r.name}: ${fmt(r.mean)}/frame = ${fps.toFixed(0)} fps sustained ` +
      `(${((r.mean / 16.7) * 100).toFixed(0)}% of a 60fps frame budget)`);
  }
}
