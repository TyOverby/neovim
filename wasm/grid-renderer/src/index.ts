// grid-renderer - canvas-based character-grid renderer.
//
// Public surface:
//   * GridRenderer  - the renderer (bitmap glyph cache + putImageData blits)
//   * Cell helpers  - the application-agnostic cell model
//   * Metrics       - cell geometry (computed from the font, overridable)
//   * SpriteCanvas + draw registry - the path-drawn glyph machinery (exposed
//     for tests and for embedders that want to rasterize sprites directly)

export type { CanvasLike, CanvasFactory, Ctx2D, ImageDataLike } from './canvas-types';
export type { Cell } from './cell';
export { cellKey, styleBits, reverseCell, hex } from './cell';
export type { FontSpec } from './metrics';
export { computeMetrics, cssFont } from './metrics';
export type { Metrics } from './metrics';
export { GlyphAtlas } from './glyph-atlas';
export type { AtlasSlot } from './glyph-atlas';
export { CellRasterizer } from './rasterizer';
export { GridRenderer } from './renderer';
export type { GridRendererOptions, CursorPos, BlitStrategy } from './renderer';
export {
  SpriteCanvas, PathBuilder,
  SHADE_OFF, SHADE_LIGHT, SHADE_MEDIUM, SHADE_DARK, SHADE_ON,
} from './sprite-canvas';
export type { Point, Line, Triangle, Quad, Rect, StrokeOpts, LineCap } from './sprite-canvas';
export { ranges, findDraw, isSpriteCodepoint } from './draw/registry';
export type { Range } from './draw/registry';
export type { DrawFn } from './draw/common';
