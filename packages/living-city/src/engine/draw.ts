// Drawing primitives in design space (the camera transform is already on the context).

import { C, Mat, SHADOW_DX, SHADOW_DY, lightT } from './core';

export type Ctx = CanvasRenderingContext2D;

/** Everything a drawable needs at draw time. */
export interface R {
  ctx: Ctx;
  /** Scene clock in seconds. */
  t: number;
  /** Width in design units of half a device pixel; strokes this wide hide anti-aliasing seams between faces. */
  hair: number;
  /** Device pixels per design unit. */
  scale: number;
  night: boolean;
}

function quadPath(ctx: Ctx, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.lineTo(dx, dy);
  ctx.closePath();
}

export function fillQuad(r: R, fill: string, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const ctx = r.ctx;
  quadPath(ctx, ax, ay, bx, by, cx, cy, dx, dy);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = fill;
  ctx.lineWidth = r.hair;
  ctx.stroke();
}

export interface BoxStyle {
  top?: string;
  left?: string;
  right?: string;
  /** Soft highlight along the front edges, which reads as a rounded clay edge. */
  edge?: string | null;
  edgeW?: number;
}

/** An axis-aligned box. Only the three faces that face the camera are drawn. */
export function box(r: R, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Mat, st?: BoxStyle) {
  const X00 = (x0 - y0) * C, X10 = (x1 - y0) * C, X11 = (x1 - y1) * C, X01 = (x0 - y1) * C;
  const Y00 = (x0 + y0) * 0.5, Y10 = (x1 + y0) * 0.5, Y11 = (x1 + y1) * 0.5, Y01 = (x0 + y1) * 0.5;
  const top = st?.top ?? m.top, left = st?.left ?? m.left, right = st?.right ?? m.right;
  if (z1 - z0 > 0.001) {
    fillQuad(r, left, X01, Y01 - z1, X11, Y11 - z1, X11, Y11 - z0, X01, Y01 - z0);
    fillQuad(r, right, X11, Y11 - z1, X10, Y10 - z1, X10, Y10 - z0, X11, Y11 - z0);
  }
  fillQuad(r, top, X00, Y00 - z1, X10, Y10 - z1, X11, Y11 - z1, X01, Y01 - z1);
  const edge = st?.edge;
  if (edge) {
    const ctx = r.ctx;
    ctx.beginPath();
    ctx.moveTo(X01, Y01 - z1);
    ctx.lineTo(X11, Y11 - z1);
    ctx.lineTo(X10, Y10 - z1);
    if (z1 - z0 > 0.4) {
      ctx.moveTo(X11, Y11 - z1);
      ctx.lineTo(X11, Y11 - z0);
    }
    ctx.strokeStyle = edge;
    ctx.lineWidth = st?.edgeW ?? 0.09;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** Run `fn` with the context mapped onto the +x face of a box: local u runs left→right, v runs down from z1. */
export function onFaceX(r: R, x1: number, y0: number, y1: number, z1: number, fn: (ctx: Ctx, w: number) => void) {
  const ctx = r.ctx;
  ctx.save();
  ctx.transform(C, -0.5, 0, 1, (x1 - y1) * C, (x1 + y1) * 0.5 - z1);
  fn(ctx, y1 - y0);
  ctx.restore();
}

/** Run `fn` with the context mapped onto the +y face of a box: local u runs left→right, v runs down from z1. */
export function onFaceY(r: R, x0: number, x1: number, y1: number, z1: number, fn: (ctx: Ctx, w: number) => void) {
  const ctx = r.ctx;
  ctx.save();
  ctx.transform(C, 0.5, 0, 1, (x0 - y1) * C, (x0 + y1) * 0.5 - z1);
  fn(ctx, x1 - x0);
  ctx.restore();
}

/** Run `fn` with the context mapped onto a horizontal plane at height z: local p runs along +x, q along +y. */
export function onTop(r: R, x0: number, y0: number, z: number, fn: (ctx: Ctx) => void) {
  const ctx = r.ctx;
  ctx.save();
  ctx.transform(C, 0.5, -C, 0.5, (x0 - y0) * C, (x0 + y0) * 0.5 - z);
  fn(ctx);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// Meshes: small convex solids in local space (l forward, w left, z up), placed by a position and heading.

export interface Face {
  idx: number[];
  mat: number;
  nl: number;
  nw: number;
  nz: number;
}

export interface Part {
  /** face range */
  s: number;
  e: number;
  d?: number;
  /** centroid in local space */
  l: number;
  w: number;
  z: number;
}

export interface Mesh {
  v: number[]; // l, w, z triples
  faces: Face[];
  parts: Part[];
  /** draw convex parts back to front each frame (for machines whose parts sit side by side) */
  sort: boolean;
  /** faces from this index on are flush decals, always drawn last */
  decals: number;
}

export class MeshBuilder {
  v: number[] = [];
  faces: Face[] = [];
  private cl = 0;
  private cw = 0;
  private cz = 0;
  vert(l: number, w: number, z: number) {
    this.v.push(l, w, z);
    return this.v.length / 3 - 1;
  }
  face(idx: number[], mat: number) {
    this.faces.push({ idx, mat, nl: 0, nw: 0, nz: 0 });
  }
  /** A prism between two polygons (counter-clockwise in l/w) with the same vertex count. */
  frustum(bot: number[][], z0: number, top: number[][], z1: number, side: number, cap: number, bottomFace = false) {
    const b = bot.map((p) => this.vert(p[0], p[1], z0));
    const t = top.map((p) => this.vert(p[0], p[1], z1));
    const n = b.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.face([b[i], b[j], t[j], t[i]], side);
    }
    this.face(t.slice(), cap);
    if (bottomFace) this.face(b.slice().reverse(), cap);
    return this.group();
  }
  /**
   * Extrude a convex side profile (l, z pairs) across the width w0..w1. `mats[i]` colours the edge i→i+1.
   * With `capsOnly` only the two side caps are kept, which makes flush decals such as side windows.
   */
  extrude(profile: number[][], w0: number, w1: number, mats: number[], capMat: number, capsOnly = false) {
    const a = profile.map((p) => this.vert(p[0], w0, p[1]));
    const b = profile.map((p) => this.vert(p[0], w1, p[1]));
    const n = profile.length;
    if (capsOnly) {
      // orient caps by hand: the centroid test needs the side faces
      return this.decal(profile.map((p) => [p[0], w0, p[1]]), capMat, 0, w0 < w1 ? -1 : 1, 0).decal(profile.map((p) => [p[0], w1, p[1]]), capMat, 0, w0 < w1 ? 1 : -1, 0);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.face([a[i], a[j], b[j], b[i]], mats[i] ?? mats[mats.length - 1]);
    }
    this.face(a.slice(), capMat);
    this.face(b.slice(), capMat);
    return this.group();
  }
  private parts: Part[] = [];
  private decalStart = -1;

  /**
   * A flat decal (lights, badges) lying on a face, with that face's outward normal: drawn only when the face
   * looks at the camera, and after every solid part.
   */
  decal(pts: number[][], mat: number, nl: number, nw: number, nz: number) {
    if (this.decalStart < 0) this.decalStart = this.faces.length;
    const idx = pts.map((p) => this.vert(p[0], p[1], p[2]));
    this.faces.push({ idx, mat, nl, nw, nz });
    this.groupStart = this.faces.length;
    return this;
  }

  /** Finish the mesh. */
  build(sort = false): Mesh {
    if (this.groupStart < this.faces.length) this.group();
    return { v: this.v, faces: this.faces, parts: this.parts, sort, decals: this.decalStart < 0 ? this.faces.length : this.decalStart };
  }
  /**
   * Close the convex part made of every face added since the last call: compute its normals (Newell's method)
   * and point them away from the part's centroid.
   */
  group() {
    const v = this.v;
    const start = this.groupStart;
    let sl = 0, sw = 0, sz = 0, n = 0;
    const seen = new Set<number>();
    for (let i = start; i < this.faces.length; i++) for (const k of this.faces[i].idx) if (!seen.has(k)) {
      seen.add(k);
      sl += v[k * 3];
      sw += v[k * 3 + 1];
      sz += v[k * 3 + 2];
      n++;
    }
    this.cl = sl / n;
    this.cw = sw / n;
    this.cz = sz / n;
    for (let i = start; i < this.faces.length; i++) {
      const f = this.faces[i];
      let nl = 0, nw = 0, nz = 0, fl = 0, fw = 0, fz = 0;
      for (let q = 0; q < f.idx.length; q++) {
        const a = f.idx[q] * 3, b = f.idx[(q + 1) % f.idx.length] * 3;
        nl += (v[a + 1] - v[b + 1]) * (v[a + 2] + v[b + 2]);
        nw += (v[a + 2] - v[b + 2]) * (v[a] + v[b]);
        nz += (v[a] - v[b]) * (v[a + 1] + v[b + 1]);
        fl += v[a];
        fw += v[a + 1];
        fz += v[a + 2];
      }
      const k = f.idx.length;
      const d = nl * (fl / k - this.cl) + nw * (fw / k - this.cw) + nz * (fz / k - this.cz);
      if (d < 0) {
        nl = -nl;
        nw = -nw;
        nz = -nz;
        f.idx.reverse();
      }
      f.nl = nl;
      f.nw = nw;
      f.nz = nz;
    }
    this.parts.push({ s: start, e: this.faces.length, l: this.cl, w: this.cw, z: this.cz });
    this.groupStart = this.faces.length;
    return this;
  }
  private groupStart = 0;
}

export type MatSlot = Mat | string;

const SCR = new Float64Array(3 * 256);

/**
 * Draw a mesh at (px, py, pz) facing (hx, hy). Faces turned away from the camera are skipped, so each convex
 * part draws correctly in any order; parts are drawn in the order they were added.
 */
export function drawMesh(r: R, m: Mesh, px: number, py: number, pz: number, hx: number, hy: number, mats: MatSlot[]) {
  const v = m.v;
  const n = v.length / 3;
  for (let i = 0; i < n; i++) {
    const l = v[i * 3], w = v[i * 3 + 1], z = v[i * 3 + 2];
    const x = px + l * hx - w * hy;
    const y = py + l * hy + w * hx;
    SCR[i * 2] = (x - y) * C;
    SCR[i * 2 + 1] = (x + y) * 0.5 - z - pz;
  }
  const ctx = r.ctx;
  ctx.lineWidth = r.hair;
  ctx.lineJoin = 'round';
  if (m.sort) {
    // convex parts back to front along the view direction
    ORDER.length = 0;
    for (const p of m.parts) {
      if (p.s >= m.decals) continue;
      const x = px + p.l * hx - p.w * hy, y = py + p.l * hy + p.w * hx;
      p.d = x + y + p.z * 0.8;
      ORDER.push(p);
    }
    ORDER.sort((a, b) => a.d! - b.d!);
    for (const p of ORDER) drawFaces(r, m, p.s, p.e, hx, hy, mats);
    drawFaces(r, m, m.decals, m.faces.length, hx, hy, mats);
  } else drawFaces(r, m, 0, m.faces.length, hx, hy, mats);
}

const ORDER: (Part & { d?: number })[] = [];

function drawFaces(r: R, m: Mesh, s: number, e: number, hx: number, hy: number, mats: MatSlot[]) {
  const ctx = r.ctx;
  for (let fi = s; fi < e; fi++) {
    const f = m.faces[fi];
    const nx = f.nl * hx - f.nw * hy;
    const ny = f.nl * hy + f.nw * hx;
    if (nx + ny + f.nz <= 1e-9) continue;
    const s = mats[f.mat];
    const fill = typeof s === 'string' ? s : s.at(lightT(nx, ny, f.nz));
    const idx = f.idx;
    ctx.beginPath();
    ctx.moveTo(SCR[idx[0] * 2], SCR[idx[0] * 2 + 1]);
    for (let k = 1; k < idx.length; k++) ctx.lineTo(SCR[idx[k] * 2], SCR[idx[k] * 2 + 1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = fill;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shadows. Shapes are added to the current path so many shadows fill in one go without darkening where they overlap.

const HULL: number[] = [];
const HP: number[] = [];

function cross(o: number, a: number, b: number) {
  return (HP[a * 2] - HP[o * 2]) * (HP[b * 2 + 1] - HP[o * 2 + 1]) - (HP[a * 2 + 1] - HP[o * 2 + 1]) * (HP[b * 2] - HP[o * 2]);
}

/** Add the convex hull of world points (x, y pairs on the ground) to the current path. */
export function hullPath(ctx: Ctx, pts: number[]) {
  const n = pts.length / 2;
  HP.length = 0;
  for (let i = 0; i < pts.length; i++) HP.push(pts[i]);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => HP[a * 2] - HP[b * 2] || HP[a * 2 + 1] - HP[b * 2 + 1]);
  HULL.length = 0;
  for (const i of order) {
    while (HULL.length >= 2 && cross(HULL[HULL.length - 2], HULL[HULL.length - 1], i) <= 0) HULL.pop();
    HULL.push(i);
  }
  const lower = HULL.length + 1;
  for (let k = order.length - 2; k >= 0; k--) {
    const i = order[k];
    while (HULL.length >= lower && cross(HULL[HULL.length - 2], HULL[HULL.length - 1], i) <= 0) HULL.pop();
    HULL.push(i);
  }
  HULL.pop();
  for (let k = 0; k < HULL.length; k++) {
    const i = HULL[k];
    const X = (HP[i * 2] - HP[i * 2 + 1]) * C, Y = (HP[i * 2] + HP[i * 2 + 1]) * 0.5;
    if (k === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  }
  ctx.closePath();
}

const SP: number[] = [];

/** Shadow of an axis-aligned box of height h standing on the ground. */
export function boxShadow(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, h: number, base = 0) {
  const dx = SHADOW_DX * h, dy = SHADOW_DY * h, bx = SHADOW_DX * base, by = SHADOW_DY * base;
  SP.length = 0;
  SP.push(x0 + bx, y0 + by, x1 + bx, y0 + by, x1 + bx, y1 + by, x0 + bx, y1 + by);
  SP.push(x0 + dx, y0 + dy, x1 + dx, y0 + dy, x1 + dx, y1 + dy, x0 + dx, y1 + dy);
  hullPath(ctx, SP);
}

/** Shadow of an oriented rectangle (centre, heading, half length/width) of height h. */
export function rectShadow(ctx: Ctx, cx: number, cy: number, hx: number, hy: number, hl: number, hw: number, h: number) {
  const dx = SHADOW_DX * h, dy = SHADOW_DY * h;
  SP.length = 0;
  const lx = hx * hl, ly = hy * hl, wx = -hy * hw, wy = hx * hw;
  for (const [a, b] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const x = cx + lx * a + wx * b, y = cy + ly * a + wy * b;
    SP.push(x, y, x + dx, y + dy);
  }
  hullPath(ctx, SP);
}

/** A soft round shadow (trees, people): an ellipse on the ground stretched along the light. */
export function blobShadow(ctx: Ctx, x: number, y: number, rad: number, h: number) {
  const ox = x + SHADOW_DX * h * 0.5, oy = y + SHADOW_DY * h * 0.5;
  const X = (ox - oy) * C, Y = (ox + oy) * 0.5;
  const len = Math.hypot((SHADOW_DX - SHADOW_DY) * C, (SHADOW_DX + SHADOW_DY) * 0.5) * h * 0.5;
  ctx.moveTo(X + rad * C + len, Y);
  ctx.ellipse(X, Y, rad * C + len, rad * 0.5 + len * 0.12, 0.2, 0, Math.PI * 2);
}

/** Add a world-space ground polygon (x, y pairs) to the current path. */
export function groundPoly(ctx: Ctx, pts: number[], z = 0) {
  for (let i = 0; i < pts.length; i += 2) {
    const X = (pts[i] - pts[i + 1]) * C, Y = (pts[i] + pts[i + 1]) * 0.5 - z;
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  }
  ctx.closePath();
}

export function groundRect(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, z = 0) {
  groundPoly(ctx, [x0, y0, x1, y0, x1, y1, x0, y1], z);
}

/** Points along a world-space arc (centre, radius, start angle, sweep), as x, y pairs. */
export function arcPts(cx: number, cy: number, rad: number, a0: number, da: number, steps = 14): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (da * i) / steps;
    out.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  return out;
}

export function lineW(ctx: Ctx, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  ctx.moveTo((x0 - y0) * C, (x0 + y0) * 0.5 - z0);
  ctx.lineTo((x1 - y1) * C, (x1 + y1) * 0.5 - z1);
}
