# grid-renderer — canvas-based character-grid renderer

A fast, high-fidelity renderer for terminal-style character grids on an HTML
`<canvas>` (or any canvas-compatible surface). **Application-agnostic**: it
knows nothing about Neovim — anything that models its screen as a grid of
styled cells (a terminal emulator, Neovim's `ext_linegrid`, a TUI framework)
can drive it. The Neovim wiring lives one package over, in
`wasm/web/src/neovim-ui.ts`.

## Rendering model

1. **Bitmap glyph cache.** Every distinct cell identity —
   `(text, fg, bg, sp, style-flags, width)` — is rasterized **once** into an
   `ImageData` bitmap and kept in a bounded LRU (`GlyphCache`, default 8192
   entries). Bitmaps are cached **fully colorized**, keyed by the exact fg/bg
   pair — *not* as alpha masks composited at draw time. Recreating fg-on-bg
   via alpha compositing does not reproduce the pixels a font rasterizer
   produces for that exact color pair at the subpixel-antialiasing level, so
   we deliberately trade cache size for fidelity.
2. **`putImageData` blits.** Cells are painted by blitting the cached bitmap
   — no per-frame text shaping, no compositing, no canvas state changes.
   `render(grid, cursor)` diffs against what's on screen and only blits cells
   whose identity changed.
3. **Path-drawn sprite glyphs.** Box drawing, block elements, braille,
   powerline, branch-drawing, and the legacy-computing blocks are **drawn as
   paths/rects** (never font glyphs), so they fill the cell edge-to-edge,
   connect seamlessly across cells, and look identical with any font. The
   draw functions are a 1:1 TypeScript port of
   [ghostty](https://github.com/ghostty-org/ghostty)'s sprite font
   (`src/font/sprite/draw/*.zig`): each glyph paints an alpha *coverage* map
   (`SpriteCanvas`) which is colorized per-pixel over the cell background —
   exactly ghostty's alpha8-atlas model.

### Path-drawn Unicode coverage

Matching ghostty (see [arewelegacycomputingyet.com](https://arewelegacycomputingyet.com/)):

| Block | Range | Module |
|---|---|---|
| Box Drawing (complete) | U+2500–257F | `draw/box.ts` |
| Block Elements (complete) | U+2580–259F | `draw/block.ts` |
| Geometric Shapes (terminal subset ◢◣◤◥◸◹◺◿) | U+25E2–25FF | `draw/geometric_shapes.ts` |
| Braille Patterns (complete) | U+2800–28FF | `draw/braille.ts` |
| Powerline glyphs | U+E0B0–E0D4 | `draw/powerline.ts` |
| Branch drawing (kitty set) | U+F5D0–F60D | `draw/branch.ts` |
| Symbols for Legacy Computing (sextants, smooth mosaics, wedges, eighths, checkerboards, diagonals, circle pieces) | U+1FB00–1FBEF | `draw/symbols_for_legacy_computing.ts` |
| Symbols for Legacy Computing Supplement (octants — all 230 —, separated quadrants/sextants, sixteenths, quarter circles, stubs) | U+1CC1B–1CEAF | `draw/symbols_for_legacy_computing_supplement.ts` |

The registry (`draw/registry.ts`) auto-collects `draw<CP>` / `draw<MIN>_<MAX>`
exports from those modules — ghostty's comptime collection, at module load.
`isSpriteCodepoint(cp)` answers "path or font?".

## Usage

```js
// Browser (UMD): <script src="grid-renderer.js"></script> -> globalThis.GridRenderer
// Node: const GridRenderer = require('grid-renderer/dist/cjs/index.js')
const r = new GridRenderer.GridRenderer(canvasEl, {
  fontFamily: '"DejaVu Sans Mono", monospace',
  fontSizePx: 16,                      // scale by devicePixelRatio for HiDPI
  // createCanvas: (w, h) => ...       // required outside the DOM (e.g. Node)
});
r.resize(80, 24);                       // or r.fit(pixelW, pixelH, bg)
r.render(cells, { row: 0, col: 0 });    // Cell[][] + cursor (reverse-video block)
```

A `Cell` is `{ text, fg, bg, sp?, bold?, italic?, underline?, undercurl?,
underdouble?, underdotted?, underdashed?, strikethrough?, width? }` with 24-bit
`0xRRGGBB` colors, fully resolved by the caller (reverse video, palettes,
defaults). A double-width glyph sets `width: 2` and leaves the following
cell's text `''` (the terminal / ext_linegrid convention).

## Build

```sh
npm install        # typescript + @napi-rs/canvas (tests)
./build-ts.sh      # -> dist/cjs/** (CommonJS + d.ts) and dist/grid-renderer.js
                   #    (single-file UMD linked by tools/bundle-umd.mjs)
```

## Tests: snapshot ("golden image") methodology

```sh
npm test           # builds, then runs test/*.test.js under node:test
npm run promote    # accept current rendering as the new baselines
```

Tests render scenes through the real renderer on
[`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (a skia-backed
Node canvas; no system dependencies) and compare **pixel-for-pixel** against
committed PNGs in `test/baselines/`. On mismatch the test fails and writes
`test/__artifacts__/<name>.actual.png` + a red-highlighted `<name>.diff.png`;
inspect them, and if the change is intended run `npm run promote` and commit
the updated baselines.

Two classes of snapshot:

* **Sprite-glyph scenes** (`sprites.test.js`) are pure geometry — no font —
  and stable across machines.
* **Text scenes** (`text.test.js`) depend on the host's fonts + rasterizer
  (DejaVu Sans Mono assumed). On a machine that rasterizes text differently,
  regenerate once with `npm run promote`.

`renderer.test.js` unit-tests the cache (one rasterization per identity, LRU
eviction), damage tracking (unchanged cells never re-blit), cursor
paint/restore, and wide-cell blitting — no snapshots.

## Benchmarks

```sh
npm run bench                     # all scenarios (builds first)
node bench/bench.js scroll        # one scenario
node bench/bench.js --cols 160 --rows 40 --dpr 2 --frames 120
```

`bench/bench.js` reports per-frame wall time (mean/p50/p95/max) for frame
scenarios — `scroll` (100% damage, warm cache: the "scrolling through a file"
workload), `scroll-cold`, `edit`, `noop`, `sprites` — plus microbenches sized
to one screenful per frame: `cache-get`, `blit` (raw `putImageData`), and
`rasterize`. Content is seeded-deterministic, so runs are comparable. Numbers
are skia-on-CPU under Node, not Chrome-on-GPU: use them to compare a change
against the previous run, not to predict absolute browser frame times.
