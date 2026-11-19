// Shadows cast by tall buildings onto the things standing near them (the ground's shadows are baked separately).
//
// A box of height Z standing on the ground, lit along the scene's light, shades every point p for which the ray
// from p towards the light passes through the box. That set is convex: at height z it is the box's footprint
// swept by the shadow offset for a box of height Z - z. Written as half-spaces n·p ≤ c, any face can be clipped
// against it and the part inside filled with a shadow tint.

import { C, SHADOW_DX, SHADOW_DY } from './core';
import type { Ctx } from './draw';

export interface Caster {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** height */
  z: number;
  /** the object casting it, which never shades itself */
  owner: unknown;
  /** half-spaces [nx, ny, nz, c] */
  planes: number[][];
  /** bounds of the shadow volume, for quick rejection */
  bx0: number;
  bx1: number;
  by0: number;
  by1: number;
}

export function caster(x0: number, y0: number, x1: number, y1: number, z: number, owner: unknown): Caster {
  const a = SHADOW_DX, b = SHADOW_DY; // the shadow runs towards +x, -y
  const planes = [
    [-1, 0, 0, -x0],
    [0, 1, 0, y1],
    [0, 0, 1, z],
    [1, 0, a, x1 + a * z],
    [0, -1, -b, -(y0 + b * z)],
    [b, -a, 0, b * x0 - a * y0],
    [-b, a, 0, -b * x1 + a * y1],
  ];
  return { x0, y0, x1, y1, z, owner, planes, bx0: x0, bx1: x1 + a * z, by0: y0 + b * z, by1: y1 };
}

const A: number[] = [];
const B: number[] = [];

/** Clip a 3D polygon (x, y, z triples) to a caster's shadow volume; returns the clipped polygon or null. */
function clip(poly: number[], c: Caster): number[] | null {
  let src = A, dst = B;
  src.length = 0;
  for (const v of poly) src.push(v);
  for (const [nx, ny, nz, k] of c.planes) {
    dst.length = 0;
    const n = src.length / 3;
    if (n < 3) return null;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
      const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
      const da = nx * ax + ny * ay + nz * az - k, db = nx * bx + ny * by + nz * bz - k;
      if (da <= 0) dst.push(ax, ay, az);
      if (da * db < 0) {
        const t = da / (da - db);
        dst.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src.length >= 9 ? src : null;
}

/** Darken the part of a face (x, y, z triples) that lies in any caster's shadow. */
export function shadeFace(ctx: Ctx, poly: number[], casters: readonly Caster[], fill: string, owner?: unknown) {
  let fx0 = Infinity, fx1 = -Infinity, fy0 = Infinity, fy1 = -Infinity, fz0 = Infinity;
  for (let i = 0; i < poly.length; i += 3) {
    fx0 = Math.min(fx0, poly[i]);
    fx1 = Math.max(fx1, poly[i]);
    fy0 = Math.min(fy0, poly[i + 1]);
    fy1 = Math.max(fy1, poly[i + 1]);
    fz0 = Math.min(fz0, poly[i + 2]);
  }
  for (const c of casters) {
    if (c.owner === owner && owner !== undefined) continue;
    if (fx1 < c.bx0 || fx0 > c.bx1 || fy1 < c.by0 || fy0 > c.by1 || fz0 > c.z) continue;
    const p = clip(poly, c);
    if (!p) continue;
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 3) {
      const X = (p[i] - p[i + 1]) * C, Y = (p[i] + p[i + 1]) * 0.5 - p[i + 2];
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
}

/** Is this point in any caster's shadow? */
export function inShadow(x: number, y: number, z: number, casters: readonly Caster[]) {
  for (const c of casters) {
    if (x < c.bx0 || x > c.bx1 || y < c.by0 || y > c.by1 || z > c.z) continue;
    let inside = true;
    for (const [nx, ny, nz, k] of c.planes) if (nx * x + ny * y + nz * z > k) {
      inside = false;
      break;
    }
    if (inside) return true;
  }
  return false;
}
