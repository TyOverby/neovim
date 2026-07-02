// Powerline + Powerline Extra Symbols | U+E0B0...U+E0D4
// https://github.com/ryanoasis/powerline-extra-symbols
//
//
//
//
//
// We implement the more geometric glyphs here, but not the stylized ones.
//
// Port of ghostty's src/font/sprite/draw/powerline.zig.

import { SHADE_ON } from '../sprite-canvas';
import { DrawFn, thicknessHeight } from './common';
import {
  lightDiagonalUpperLeftToLowerRight,
  lightDiagonalUpperRightToLowerLeft,
} from './box';

// '' (U+E0B0)
export const drawE0B0: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: 0, y: 0 },
    p1: { x: float_width, y: float_height / 2 },
    p2: { x: 0, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0B2)
export const drawE0B2: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: float_width, y: 0 },
    p1: { x: 0, y: float_height / 2 },
    p2: { x: float_width, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0B8)
export const drawE0B8: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: 0, y: 0 },
    p1: { x: float_width, y: float_height },
    p2: { x: 0, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0B9)
export const drawE0B9: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  lightDiagonalUpperLeftToLowerRight(metrics, canvas);
};

// '' (U+E0BA)
export const drawE0BA: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: float_width, y: 0 },
    p1: { x: float_width, y: float_height },
    p2: { x: 0, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0BB)
export const drawE0BB: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  lightDiagonalUpperRightToLowerLeft(metrics, canvas);
};

// '' (U+E0BC)
export const drawE0BC: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: 0, y: 0 },
    p1: { x: float_width, y: 0 },
    p2: { x: 0, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0BD)
export const drawE0BD: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  lightDiagonalUpperRightToLowerLeft(metrics, canvas);
};

// '' (U+E0BE)
export const drawE0BE: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;
  canvas.triangle({
    p0: { x: 0, y: 0 },
    p1: { x: float_width, y: 0 },
    p2: { x: float_width, y: float_height },
  }, SHADE_ON);
};

// '' (U+E0BF)
export const drawE0BF: DrawFn = (_cp, canvas, _width, _height, metrics) => {
  lightDiagonalUpperLeftToLowerRight(metrics, canvas);
};

// '' (U+E0B1)
export const drawE0B1: DrawFn = (_cp, canvas, width, height, metrics) => {
  const float_width = width;
  const float_height = height;

  const path = canvas.path();
  path.moveTo(0, 0);
  path.lineTo(float_width, float_height / 2);
  path.lineTo(0, float_height);

  canvas.strokePath(
    path,
    {
      cap: 'butt',
      width: thicknessHeight('light', metrics.boxThickness),
    },
    SHADE_ON,
  );
};

// '' (U+E0B3)
export const drawE0B3: DrawFn = (cp, canvas, width, height, metrics) => {
  drawE0B1(cp, canvas, width, height, metrics);
  canvas.flipHorizontal();
};

// '' (U+E0B4)
export const drawE0B4: DrawFn = (_cp, canvas, width, height, _metrics) => {
  const float_width = width;
  const float_height = height;

  // Coefficient for approximating a circular arc.
  const c = (Math.SQRT2 - 1.0) * 4.0 / 3.0;

  const radius = Math.min(float_width, float_height / 2);

  const path = canvas.path();
  path.moveTo(0, 0);
  path.curveTo(
    radius * c,
    0,
    radius,
    radius - radius * c,
    radius,
    radius,
  );
  path.lineTo(radius, float_height - radius);
  path.curveTo(
    radius,
    float_height - radius + radius * c,
    radius * c,
    float_height,
    0,
    float_height,
  );
  path.close();

  canvas.fillPath(path, SHADE_ON);
};

// '' (U+E0B5)
export const drawE0B5: DrawFn = (_cp, canvas, width, height, metrics) => {
  const float_width = width;
  const float_height = height;

  // Coefficient for approximating a circular arc.
  const c = (Math.SQRT2 - 1.0) * 4.0 / 3.0;

  const radius = Math.min(float_width, float_height / 2);

  const path = canvas.path();
  path.moveTo(0, 0);
  path.curveTo(
    radius * c,
    0,
    radius,
    radius - radius * c,
    radius,
    radius,
  );
  path.lineTo(radius, float_height - radius);
  path.curveTo(
    radius,
    float_height - radius + radius * c,
    radius * c,
    float_height,
    0,
    float_height,
  );

  canvas.innerStrokePath(path, {
    width: metrics.boxThickness,
    cap: 'butt',
  }, SHADE_ON);
};

// '' (U+E0B6)
export const drawE0B6: DrawFn = (cp, canvas, width, height, metrics) => {
  drawE0B4(cp, canvas, width, height, metrics);
  canvas.flipHorizontal();
};

// '' (U+E0B7)
export const drawE0B7: DrawFn = (cp, canvas, width, height, metrics) => {
  drawE0B5(cp, canvas, width, height, metrics);
  canvas.flipHorizontal();
};

// '' (U+E0D2)
export const drawE0D2: DrawFn = (_cp, canvas, width, height, metrics) => {
  const float_width = width;
  const float_height = height;
  const float_thick = metrics.boxThickness;

  // Top piece
  {
    const path = canvas.path();
    path.moveTo(0, 0);
    path.lineTo(float_width, 0);
    path.lineTo(float_width / 2, float_height / 2 - float_thick / 2);
    path.lineTo(0, float_height / 2 - float_thick / 2);
    path.close();

    canvas.fillPath(path, SHADE_ON);
  }

  // Bottom piece
  {
    const path = canvas.path();
    path.moveTo(0, float_height);
    path.lineTo(float_width, float_height);
    path.lineTo(float_width / 2, float_height / 2 + float_thick / 2);
    path.lineTo(0, float_height / 2 + float_thick / 2);
    path.close();

    canvas.fillPath(path, SHADE_ON);
  }
};

// '' (U+E0D4)
export const drawE0D4: DrawFn = (cp, canvas, width, height, metrics) => {
  drawE0D2(cp, canvas, width, height, metrics);
  canvas.flipHorizontal();
};
