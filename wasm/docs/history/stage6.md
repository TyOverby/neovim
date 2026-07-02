# Stage 6 — the canvas grid renderer (`wasm/grid-renderer`)

> **Status: ✅ shipped.** The browser UI's `<pre>`-innerHTML renderer is replaced
> by a canvas renderer built as its own application-agnostic npm package,
> `wasm/grid-renderer/`: a glyph atlas blitted with `drawImage`, path-drawn
> box-drawing / legacy-computing glyphs ported 1:1 from ghostty's sprite font,
> golden-image snapshot tests, a benchmark runner, and adaptive paint
> scheduling in the Neovim mount. Full-viewport repaint went from ~100ms worst
> case (pre-coalescing) to ~2ms measured in Chrome. The old `<pre>` renderer
> survives as a testing utility.

Prereq reading: `stage3.md` (the browser UI split: headless `neovim.js` core +
`neovim-ui.js` renderer over msgpack-RPC/`ext_linegrid`). This stage replaces
only the **painting** half of `neovim-ui.js`; the `Screen` decode model, the
RPC core, the engine, and the rvim server are untouched.

---

## 1. Why a canvas renderer

The stage-3 renderer decoded `ext_linegrid` into a `Screen` and re-rendered it
as styled `<span>` runs inside a `<pre>` on every flush. Good enough to
bootstrap, but wrong for both goals that matter to a terminal UI:

- **Speed.** Every flush rebuilt the entire innerHTML string and forced a full
  DOM parse + layout + paint of the grid. There is no damage tracking you can
  do through innerHTML.
- **Visual fidelity.** Box-drawing, block, braille and legacy-computing glyphs
  came from whatever font the browser picked: misaligned joins between cells,
  gaps in vertical lines at fractional line-heights, no coverage for the newer
  Unicode blocks (octants, separated mosaics). Terminals that care (kitty,
  ghostty, alacritty) draw these glyphs themselves.

## 2. The package: application-agnostic by construction

`wasm/grid-renderer/` is its own npm package with no Neovim knowledge: the
input is a `Cell[][]` grid (`{ text, fg, bg, sp?, bold?, italic?, underline
variants, strikethrough?, width? }` with fully resolved 24-bit colors) plus a
cursor position. Anything grid-shaped — a terminal emulator, a TUI — can drive
it. The Neovim-specific resolution (hl attrs → colors, reverse video, wide-char
continuation cells) lives in `neovim-ui.ts` as `screenToCells()`.

It is also **host-agnostic**: every canvas it creates goes through an
injectable `CanvasFactory`, and all canvas types are structural interfaces
(`CanvasLike`, `Ctx2D`), so the same code runs against DOM canvases,
`OffscreenCanvas`, or node-canvas in tests. The build mirrors the wasm/web
philosophy — plain `tsc`, no bundler: `dist/cjs/**` for `require()`, plus a
single-file UMD `dist/grid-renderer.js` (global `GridRenderer`) linked by
`tools/bundle-umd.mjs`, a ~60-line CommonJS module-map linker (the multi-file
analog of `web/tools/umd-wrap.mjs`).

## 3. Rendering model

Three layers, each replacing a per-frame cost with a per-glyph cost:

1. **Rasterize once.** Every distinct cell identity `(text, fg, bg, sp,
   style-flags, width)` is rasterized a single time (`CellRasterizer`) into a
   slot of a sprite-sheet canvas. Glyphs are cached **fully colorized**, keyed
   by the exact fg/bg pair — deliberately NOT as alpha masks composited with an
   overlay color at draw time, because compositing does not reproduce the
   subpixel-antialiased pixels the font rasterizer produces for that specific
   color pair. Cache size is traded for fidelity.
2. **`GlyphAtlas`: sprite sheets + intrusive LRU.** Slots are fixed-size
   (one cell span; wide glyphs get a second atlas), packed into ~1024px sheet
   canvases created lazily up to `maxEntries` (default 4096), after which the
   least-recently-used slot's pixels are overwritten in place. Recency is an
   intrusive doubly-linked list — `get()` is two pointer relinks, **not** a Map
   delete + re-insert (which profiled as ~half the frame under V8).
3. **Blit + damage-diff.** `render(grid, cursor)` compares each incoming cell
   against the cell object last painted at that position (field comparison
   with an identity fast path — no per-cell key strings for unchanged cells;
   the cache-key string is built only for cells actually blitted) and copies
   changed cells from the atlas with `drawImage`. In browsers the sheets
   become GPU-cached textures, so a full-viewport scroll is texture copies
   rather than `putImageData`'s per-cell CPU→GPU pixel uploads. The cursor is
   painted as a reverse-video block (`FLAG_CURSOR` in the damage state, so
   cursor moves repaint exactly two cells).

Cells are treated as immutable; HiDPI is the embedder's concern (the mount
scales `fontSizePx` by `devicePixelRatio` and styles the element down).

### Blit strategies (and the skia leak that forced them)

`blitStrategy: 'drawImage' | 'imageData'`, auto-detected. Browsers get
`drawImage` (the whole point). Non-DOM hosts default to `putImageData` of a
per-slot pixel copy because **both skia-based Node canvases leak the pixel
payload of every draw call**: `@napi-rs/canvas` (0.1.x and 1.0.x) retains a
snapshot of the entire *source canvas* per `drawImage` (~4MB per blitted cell
when the source is a 1024px sheet!) and ~3-4KB per `putImageData`; `skia-canvas`
retains ~1.4-3.8KB per call. Forced GC does not reclaim it; neither does
forcing rasterization with a readback. This is what OOM-killed the original
benchmark run — notably the pre-atlas `putImageData` renderer leaked the same
way, it was just slower to blow up. The tests/bench therefore run on
**node-canvas (cairo)**: immediate-mode, prebuilt N-API binaries (no system
cairo needed), measured flat at 78MB over 200k+ blits. Do not move them back
to a skia binding. The two strategies are locked byte-identical by a test.

## 4. Path-drawn glyphs: the ghostty sprite port

Box drawing and the legacy-computing blocks are **drawn as paths/rects**, never
font glyphs, so they fill cells edge-to-edge and connect seamlessly across
cells with any font. The code is a 1:1 TypeScript port of ghostty's sprite
font (`src/font/sprite/draw/*.zig`), coverage tracked against
[arewelegacycomputingyet.com](https://arewelegacycomputingyet.com/):

| Block | Range | Module |
|---|---|---|
| Box Drawing (complete) | U+2500–257F | `draw/box.ts` |
| Block Elements (complete) | U+2580–259F | `draw/block.ts` |
| Geometric Shapes (terminal subset) | U+25E2–25FF | `draw/geometric_shapes.ts` |
| Braille (complete) | U+2800–28FF | `draw/braille.ts` |
| Powerline | U+E0B0–E0D4 | `draw/powerline.ts` |
| Branch drawing (kitty set) | U+F5D0–F60D | `draw/branch.ts` |
| Symbols for Legacy Computing | U+1FB00–1FBEF | `draw/symbols_for_legacy_computing.ts` |
| … Supplement (incl. all 230 octants) | U+1CC1B–1CEAF | `draw/symbols_for_legacy_computing_supplement.ts` |

Port mechanics, mirroring ghostty exactly:

- **`SpriteCanvas`** reproduces ghostty's alpha8 coverage surface on a 2D
  canvas: draw functions paint opaque grayscale (rects pixel-exact, paths
  antialiased) and the R channel *is* the coverage map, which is then
  colorized per-pixel over the cell background (`bg + coverage·(fg − bg)`).
  This makes ghostty's `invert()` / `flipHorizontal()` / shade levels
  (`0x40/0x80/0xc0`) trivial and exact.
- **The registry** (`draw/registry.ts`) auto-collects exported functions named
  `draw<CP>` / `draw<MIN>_<MAX>` from the draw modules — ghostty's comptime
  collection, done at module load. `isSpriteCodepoint(cp)` is the
  path-vs-font decision.
- Zig semantics are preserved via helpers (`idiv` for truncating division,
  `satSub` for `-|`, `round` for half-away-from-zero `@round`); the porting
  conventions live at the top of `draw/common.ts`.

The port was parallelized: box/block by hand (everything depends on them),
then four agents ported the remaining modules against a fixed API spec, each
smoke-rendering ASCII-art coverage dumps before handoff.

## 5. Testing: golden images + promotion

`npm test` renders every path-drawn block (and text styles/decorations,
colors, a composite screen with borders + wide chars + cursor) through the
real renderer on node-canvas and compares **pixel-for-pixel** against PNGs
committed in `test/baselines/`. On mismatch the test fails and writes
`test/__artifacts__/<name>.actual.png` + a red-highlighted `.diff.png`;
`npm run promote` accepts the current output as the new baseline (review the
images, then commit them). Sprite scenes are pure geometry and
machine-stable; text scenes depend on the host's fonts (DejaVu Sans Mono
assumed) and may need a one-time promote elsewhere. Unit tests pin the
atlas (one rasterization per identity, LRU slot reuse), damage tracking,
cursor paint/restore, wide-cell blitting, and drawImage/imageData pixel
equality. The wasm/web e2e additionally locks `screenToCells` against real
engine highlight streams.

## 6. The benchmark runner

`npm run bench` (`bench/bench.js`) measures per-frame wall time with
seeded-deterministic content: frame scenarios (`scroll` = 100% damage + warm
cache, `scroll-cold`, `edit`, `noop`, `sprites`) plus microbenches sized to
one screenful per frame (`cache-get`, `blit`, `rasterize`). Numbers are
cairo-on-CPU — treat them as relative, for before/after comparisons.

The optimization arc it measured (160×40 cells @2x, this repo's dev box):

| scenario | putImageData + Map-LRU cache | glyph atlas + intrusive LRU + field-diff |
|---|---|---|
| scroll (100% damage, warm) | 15.3ms | **5.9ms** |
| scroll-cold | 18.0ms | 12.1ms |
| edit (one line) | 1.06ms | **0.20ms** |
| noop (pure damage walk) | 0.66ms | **0.02ms** |
| cache-get (6400 warm gets) | 0.20ms | 0.08ms |

In Chrome (GPU `drawImage` path, where the original profile showed ~30ms
frames split between `putImageData` and `GlyphCache.get`): **~2ms** for a
full-viewport repaint.

## 7. Integration into the browser UI

- `neovim-ui.ts` keeps the headless `Screen` (unchanged — the e2e still
  drives it directly) but `mount_into` now targets a **`<canvas>`** and paints
  through the renderer. The grid-renderer dependency resolves at runtime like
  msgpack does for the core: `opts.grid_renderer`, else the `GridRenderer`
  UMD global — `index.html` loads `grid-renderer.js` before `neovim-ui.js`.
- Auto-sizing: the canvas backing store tracks the element's CSS box ×
  `devicePixelRatio` (`renderer.fit()` — whole cells + a bg-painted margin), a
  ResizeObserver refits and drives `nvim_ui_try_resize`, and the engine's
  `grid_resize` reflows the `Screen` as before.
- The legacy `<pre>` renderer moved to `web/src/neovim-ui-pre-testutil.ts`:
  plain CommonJS in `web/dist/`, `require()`d by tests (it renders a `Screen`
  to inspectable HTML), **not** shipped by build-site/build-lib.
- `serve.js`, `build-site.sh`, `build-lib.sh`, `build-nvim.sh` build and ship
  `dist/grid-renderer.js`; the library bundle exports it under
  `./grid-renderer.js`.

## 8. Paint scheduling: three iterations

1. **Paint per flush** (initial): correct but defenseless — a fast scroll
   emits hundreds of flush-terminated redraw batches per browser frame, each
   repainting; ~100ms frames.
2. **rAF coalescing**: decode synchronously, paint at most once per
   `requestAnimationFrame`. Fixed the floods (a G + 40×⟨C-u⟩ burst over 5000
   lines: hundreds of paints → 2) but taxed every paint — including a lone
   keystroke echo — with up to a frame of latency.
3. **Adaptive budget** (shipped; the user's design): flushes paint
   **immediately in the same task**, metered against `paint_budget_ms`
   (default 8ms) per ~17ms window. A flood that burns the budget leaves the
   painted state as "the frame" and coalesces the remainder into one rAF
   paint of the final state. Interactive latency is zero-added while painting
   is cheap (~2ms), floods cost at most budget + one paint per frame, hidden
   tabs always defer to rAF (Chrome parks it; one catch-up paint on
   visibility), and `paint_budget_ms: 0` restores pure coalescing.

## 9. Operational gotchas fixed along the way

- **`rvim` embeds a gitignored bundle.** `//go:embed all:site` bakes whatever
  is in `wasm/rvim/server/site/` — a manual `go build -tags embed_assets`
  after renderer changes shipped a stale `<pre>` UI until
  `web/build-site.sh server/site` was re-run (`build-release.sh` does this
  automatically).
- **`download-rvim.sh` trusted run-level status.** A hung Pages `deploy` job,
  cancelled by hand, marked the whole CI run `cancelled` even though every
  `build-rvim` job had uploaded fresh artifacts — and the script's
  `--status success` filter silently fell back to an older run's binary. It
  now walks recent completed runs newest-first and takes the first one the
  artifact actually downloads from (into a temp subdir: `gh run download -D .`
  trips gh's path-traversal guard).

## 10. Future work

- **Row-run batching**: one `drawImage` per run of horizontally-adjacent
  same-sheet slots would cut draw-call count further if blits ever dominate
  again.
- **Cursor shapes**: only a reverse-video block today; `mode_info_set`
  (bar/underline/blink) is decoded but unused.
- **Ligatures / complex shaping**: cells are rasterized independently by
  design; a shaping pass is out of scope for a cell cache.
- **Emoji**: color-font rasterization works where the host provides it
  (browser canvas does); no fallback atlas.
