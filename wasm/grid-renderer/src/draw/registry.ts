// Draw-function registry: which codepoints get path-drawn instead of
// font-rendered, and the dispatch to the right draw function.
//
// Mirrors ghostty's Face.zig comptime collection: every draw module exports
// functions named `draw<CP>` or `draw<MIN>_<MAX>` (hex codepoints); we scan
// the module exports for that pattern and build a sorted range table.

import { DrawFn } from './common';

import * as block from './block';
import * as box from './box';
import * as braille from './braille';
import * as branch from './branch';
import * as geometricShapes from './geometric_shapes';
import * as powerline from './powerline';
import * as sflc from './symbols_for_legacy_computing';
import * as sflcSupplement from './symbols_for_legacy_computing_supplement';

export interface Range { min: number; max: number; draw: DrawFn }

const NAME_RE = /^draw([0-9A-Fa-f]+)(?:_([0-9A-Fa-f]+))?$/;

function collect(mods: Record<string, any>[]): Range[] {
  const out: Range[] = [];
  for (const mod of mods) {
    for (const name of Object.keys(mod)) {
      const m = NAME_RE.exec(name);
      if (!m || typeof mod[name] !== 'function') { continue; }
      const min = parseInt(m[1], 16);
      const max = m[2] ? parseInt(m[2], 16) : min;
      out.push({ min, max, draw: mod[name] as DrawFn });
    }
  }
  out.sort((a, b) => a.min - b.min);
  return out;
}

export const ranges: Range[] = collect([
  block, box, braille, branch, geometricShapes, powerline, sflc, sflcSupplement,
]);

// The draw function for a codepoint, or null if it isn't a sprite glyph
// (binary search over the sorted ranges).
export function findDraw(cp: number): DrawFn | null {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (cp < r.min) { hi = mid - 1; }
    else if (cp > r.max) { lo = mid + 1; }
    else { return r.draw; }
  }
  return null;
}

// Whether the renderer should path-draw this codepoint rather than ask the
// font for it.
export function isSpriteCodepoint(cp: number): boolean {
  return findDraw(cp) !== null;
}
