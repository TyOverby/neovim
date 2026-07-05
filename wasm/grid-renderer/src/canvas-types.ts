// Structural types for the 2D canvas surface the renderer draws on.
//
// The renderer is host-agnostic: it never touches `document` or any other
// global. Everything that creates a canvas goes through a `CanvasFactory`
// supplied by the embedder, so the same code runs against a browser
// HTMLCanvasElement / OffscreenCanvas or a Node canvas implementation
// (node-canvas in the tests). These interfaces list only the members we
// actually use, so any of those implementations satisfies them structurally.

// A width x height RGBA pixel buffer (browser ImageData or a Node equivalent).
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

// The subset of CanvasRenderingContext2D the renderer uses.
export interface Ctx2D {
  canvas: CanvasLike;
  fillStyle: any;
  strokeStyle: any;
  lineWidth: number;
  lineCap: string;
  font: string;
  textBaseline: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  save(): void;
  restore(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): TextMetricsLike;
  getImageData(x: number, y: number, w: number, h: number): ImageDataLike;
  putImageData(data: ImageDataLike, x: number, y: number): void;
  createImageData(w: number, h: number): ImageDataLike;
  drawImage(image: CanvasLike, sx: number, sy: number, sw: number, sh: number,
            dx: number, dy: number, dw: number, dh: number): void;
}

export interface TextMetricsLike {
  width: number;
  fontBoundingBoxAscent?: number;
  fontBoundingBoxDescent?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
}

// A canvas surface: browser canvas, OffscreenCanvas, or a Node canvas.
export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d', opts?: any): Ctx2D | null;
}

// How the embedder hands us canvas creation (scratch surfaces for glyph
// rasterization). E.g. in a browser: (w, h) => { const c =
// document.createElement('canvas'); c.width = w; c.height = h; return c; },
// or with node-canvas: its createCanvas.
export type CanvasFactory = (width: number, height: number) => CanvasLike;
