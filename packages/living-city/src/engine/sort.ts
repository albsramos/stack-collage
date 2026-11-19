// Painter's-order sorting for isometric boxes.
//
// Every drawable has a world-space bounding box. Two boxes that overlap on screen are ordered by the first axis
// that separates them (the camera sits towards +x, +y, +z, so the box on the far side of the gap goes first);
// boxes that truly intersect fall back to comparing centres. A depth-first walk of those "behind" edges gives the
// draw order. Only pairs that overlap on screen are compared, using a sweep over screen x.

import { C } from './core';
import type { R } from './draw';

export interface Item {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  draw(r: R): void;
  /** @internal sort scratch */
  _s?: SortScratch;
}

interface SortScratch {
  sx0: number;
  sx1: number;
  sy0: number;
  sy1: number;
  behind: Item[];
  mark: number;
}

const EPS = 0.001;

function behind(a: Item, b: Item): number {
  if (a.x1 <= b.x0 + EPS) return -1;
  if (b.x1 <= a.x0 + EPS) return 1;
  if (a.y1 <= b.y0 + EPS) return -1;
  if (b.y1 <= a.y0 + EPS) return 1;
  if (a.z1 <= b.z0 + EPS) return -1;
  if (b.z1 <= a.z0 + EPS) return 1;
  const da = a.x0 + a.x1 + a.y0 + a.y1 + (a.z0 + a.z1) * 0.5;
  const db = b.x0 + b.x1 + b.y0 + b.y1 + (b.z0 + b.z1) * 0.5;
  return da <= db ? -1 : 1;
}

let markGen = 1;
const byX = (a: Item, b: Item) => a._s!.sx0 - b._s!.sx0;

/** Sort `items` into `out` in back-to-front order, skipping anything outside the view rectangle. */
export function depthSort(items: Item[], out: Item[], vx0: number, vy0: number, vx1: number, vy1: number) {
  const list: Item[] = SORT_LIST;
  list.length = 0;
  for (const it of items) {
    const s = it._s ?? (it._s = { sx0: 0, sx1: 0, sy0: 0, sy1: 0, behind: [], mark: 0 });
    s.sx0 = (it.x0 - it.y1) * C;
    s.sx1 = (it.x1 - it.y0) * C;
    s.sy0 = (it.x0 + it.y0) * 0.5 - it.z1;
    s.sy1 = (it.x1 + it.y1) * 0.5 - it.z0;
    if (s.sx1 < vx0 || s.sx0 > vx1 || s.sy1 < vy0 || s.sy0 > vy1) continue;
    s.behind.length = 0;
    list.push(it);
  }
  list.sort(byX);
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i], sa = a._s!;
    for (let j = i + 1; j < n; j++) {
      const b = list[j], sb = b._s!;
      if (sb.sx0 >= sa.sx1) break;
      if (sb.sy0 >= sa.sy1 || sa.sy0 >= sb.sy1) continue;
      if (behind(a, b) < 0) sb.behind.push(a);
      else sa.behind.push(b);
    }
  }
  const gen = ++markGen;
  out.length = 0;
  const visit = (it: Item) => {
    const s = it._s!;
    if (s.mark === gen) return;
    s.mark = gen;
    for (const b of s.behind) visit(b);
    out.push(it);
  };
  for (let i = 0; i < n; i++) visit(list[i]);
}

const SORT_LIST: Item[] = [];
