// Static drawables: boxes with details, foliage, street furniture.

import { C, type Mat } from './core';
import { box, boxShadow, blobShadow, type BoxStyle, type Ctx, type R } from './draw';
import type { Item } from './sort';
import type { Sprites, SpriteName } from './sprites';

export interface Static extends Item {
  /** Add this object's ground shadow to the current path (baked once into the ground layer). */
  shadow?(ctx: Ctx): void;
  /** `draw` never changes, so the scene may render it once into a bitmap and stamp that. */
  bake?: boolean;
  /** Animated details drawn on top of the (possibly baked) object every frame. */
  overlay?(r: R): void;
}

export class BoxItem implements Static {
  bake = true;
  overlay?: (r: R) => void;
  constructor(
    public x0: number,
    public y0: number,
    public z0: number,
    public x1: number,
    public y1: number,
    public z1: number,
    readonly m: Mat,
    readonly st?: BoxStyle,
    readonly deco?: (r: R, b: BoxItem) => void,
    readonly castShadow = true,
  ) {}
  draw(r: R) {
    box(r, this.x0, this.y0, this.z0, this.x1, this.y1, this.z1, this.m, this.st);
    this.deco?.(r, this);
  }
  /** Add animated details (lights, glints) drawn live over the baked box. */
  live(fn: (r: R) => void) {
    this.overlay = fn;
    return this;
  }
  shadow(ctx: Ctx) {
    if (this.castShadow) boxShadow(ctx, this.x0, this.y0, this.x1, this.y1, this.z1, this.z0);
  }
}

/** Anything with a bounding box and a draw function. */
export class FnItem implements Static {
  bake = false;
  constructor(
    public x0: number,
    public y0: number,
    public z0: number,
    public x1: number,
    public y1: number,
    public z1: number,
    readonly fn: (r: R) => void,
    readonly sh?: (ctx: Ctx) => void,
  ) {}
  draw(r: R) {
    this.fn(r);
  }
  shadow(ctx: Ctx) {
    this.sh?.(ctx);
  }
  /** Mark as unchanging so it can be baked. */
  still() {
    this.bake = true;
    return this;
  }
}

export class TreeItem implements Static {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0 = 0;
  z1: number;
  constructor(readonly sprites: Sprites, readonly x: number, readonly y: number, readonly kind: SpriteName, readonly s = 1, readonly phase = 0) {
    const rad = kind === 'poplar' ? 0.9 : kind === 'small' ? 1.0 : 1.5;
    this.x0 = x - rad * s;
    this.x1 = x + rad * s;
    this.y0 = y - rad * s;
    this.y1 = y + rad * s;
    this.z1 = (kind === 'poplar' ? 7.6 : kind === 'small' ? 4.4 : 7) * s;
  }
  draw(r: R) {
    const sp = this.sprites.get(this.kind);
    const X = (this.x - this.y) * C, Y = (this.x + this.y) * 0.5;
    const ctx = r.ctx;
    const k = Math.sin(r.t * 0.8 + this.phase) * 0.018 + Math.sin(r.t * 1.9 + this.phase * 2) * 0.006;
    ctx.save();
    ctx.transform(1, 0, k, 1, -k * Y, 0);
    ctx.drawImage(sp.img as CanvasImageSource, X - sp.ax * this.s, Y - sp.ay * this.s, sp.w * this.s, sp.h * this.s);
    ctx.restore();
  }
  shadow(ctx: Ctx) {
    const h = this.z1;
    // the canopy's shadow lands a little away from the trunk
    blobShadow(ctx, this.x + 0.55 * h * 0.22, this.y - 0.25 * h * 0.22, (this.kind === 'poplar' ? 0.8 : this.kind === 'small' ? 1.0 : 1.4) * this.s, h * 0.38);
  }
}

/** A low planter running along x or y with bushes on top. */
export class HedgeItem implements Static {
  bake = true;
  z0 = 0;
  z1 = 1.25;
  private pts: { x: number; y: number; n: SpriteName; s: number }[] = [];
  constructor(
    readonly sprites: Sprites,
    public x0: number,
    public y0: number,
    public x1: number,
    public y1: number,
    readonly planter: Mat,
    seed = 0,
  ) {
    const alongX = x1 - x0 >= y1 - y0;
    const len = alongX ? x1 - x0 : y1 - y0;
    const n = Math.max(1, Math.round(len / 0.62));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const j = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
      const jit = j - Math.floor(j);
      this.pts.push({
        x: alongX ? x0 + f * len : (x0 + x1) / 2 + (jit - 0.5) * 0.2,
        y: alongX ? (y0 + y1) / 2 + (jit - 0.5) * 0.2 : y0 + f * len,
        n: jit > 0.5 ? 'bush' : 'bush2',
        s: 0.72 + jit * 0.32,
      });
    }
    // back to front
    this.pts.sort((a, b) => a.x + a.y - (b.x + b.y));
  }
  draw(r: R) {
    box(r, this.x0, this.y0, 0, this.x1, this.y1, 0.32, this.planter, { edge: 'rgba(255,255,255,0.55)', edgeW: 0.07 });
    const ctx = r.ctx;
    for (const p of this.pts) {
      const sp = this.sprites.get(p.n);
      const X = (p.x - p.y) * C, Y = (p.x + p.y) * 0.5 - 0.3;
      ctx.drawImage(sp.img as CanvasImageSource, X - sp.ax * p.s, Y - sp.ay * p.s, sp.w * p.s, sp.h * p.s);
    }
  }
  shadow(ctx: Ctx) {
    boxShadow(ctx, this.x0, this.y0, this.x1, this.y1, 1.1);
  }
}

export class LampItem implements Static {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0 = 0;
  z1 = 4.6;
  constructor(readonly x: number, readonly y: number, readonly ax: number, readonly ay: number, readonly pole: Mat, readonly head: string) {
    this.x0 = Math.min(x, x + ax) - 0.12;
    this.x1 = Math.max(x, x + ax) + 0.12;
    this.y0 = Math.min(y, y + ay) - 0.12;
    this.y1 = Math.max(y, y + ay) + 0.12;
  }
  draw(r: R) {
    const ctx = r.ctx;
    const X = (this.x - this.y) * C, Y = (this.x + this.y) * 0.5;
    const hx = this.x + this.ax, hy = this.y + this.ay;
    const HX = (hx - hy) * C, HY = (hx + hy) * 0.5 - 4.45;
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.pole.right;
    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.lineTo(X, Y - 4.4);
    ctx.lineTo(HX, HY);
    ctx.stroke();
    ctx.strokeStyle = this.head;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(HX - 0.2, HY + 0.02);
    ctx.lineTo(HX + 0.2, HY + 0.02);
    ctx.stroke();
    if (r.night) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(HX, HY + 2.2, 0, HX, HY + 2.2, 3.2);
      g.addColorStop(0, 'rgba(255, 220, 160, 0.16)');
      g.addColorStop(1, 'rgba(255, 220, 160, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(HX - 3.2, HY - 1, 6.4, 6.4);
      ctx.restore();
    }
  }
  shadow(ctx: Ctx) {
    blobShadow(ctx, this.x + 0.8, this.y - 0.36, 0.12, 3.4);
  }
}
