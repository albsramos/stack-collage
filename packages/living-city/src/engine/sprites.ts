// Pre-rendered foliage. Trees and bushes are drawn once per scale into small canvases, then stamped.

import { css, makeRng, mix, rr, type RGB } from './core';
import type { Palette } from './palette';

export interface Sprite {
  img: HTMLCanvasElement | OffscreenCanvas;
  /** anchor (the trunk base) inside the sprite, in design units */
  ax: number;
  ay: number;
  w: number;
  h: number;
}

interface Blob {
  x: number;
  y: number;
  r: number;
  d: number; // 0 = back/shaded … 1 = front/lit
}

interface Spec {
  w: number;
  h: number;
  ax: number;
  ay: number;
  trunk?: { top: number; w: number; branches: number[][] };
  blobs: Blob[];
}

function canopy(seed: number, cx: number, cy: number, rx: number, ry: number, n: number, rmin: number, rmax: number): Blob[] {
  const rng = makeRng(seed);
  const out: Blob[] = [];
  // a few big, shaded blobs fill the volume; many small ones give it a leafy edge
  const big = Math.max(3, Math.round(n * 0.22));
  for (let i = 0; i < big; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 0.45;
    out.push({ x: cx + Math.cos(a) * rx * d, y: cy + Math.sin(a) * ry * d, r: Math.min(rx, ry) * rr(rng, 0.45, 0.62), d: 0.05 });
  }
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const d = 0.35 + Math.sqrt(rng()) * 0.65;
    const x = cx + Math.cos(a) * rx * d * 0.92;
    const y = cy + Math.sin(a) * ry * d * 0.92;
    out.push({ x, y, r: rr(rng, rmin, rmax), d: 0 });
  }
  // lit order: blobs higher and further left are lit and drawn last
  for (const b of out) if (b.d === 0) b.d = Math.min(1, Math.max(0.1, 0.55 + ((cy - b.y) / ry) * 0.35 + ((cx - b.x) / rx) * 0.18));
  out.sort((a, b) => a.d - b.d);
  return out;
}

const SPECS: Record<string, Spec> = {
  tree: {
    w: 6.0, h: 8.2, ax: 3.0, ay: 7.95,
    trunk: { top: 4.6, w: 0.17, branches: [[0, -2.4, -0.9, -4.0], [0, -2.9, 0.85, -4.3], [0, -3.4, 0.1, -5.2]] },
    blobs: canopy(11, 3.0, 2.85, 2.05, 1.75, 34, 0.32, 0.6),
  },
  tree2: {
    w: 5.4, h: 7.4, ax: 2.7, ay: 7.15,
    trunk: { top: 4.0, w: 0.16, branches: [[0, -2.1, -0.8, -3.5], [0, -2.5, 0.7, -3.8]] },
    blobs: canopy(29, 2.7, 2.6, 1.85, 1.55, 30, 0.3, 0.56),
  },
  poplar: {
    w: 3.4, h: 8.4, ax: 1.7, ay: 8.15,
    trunk: { top: 4.8, w: 0.15, branches: [[0, -2.6, -0.35, -4.6], [0, -2.9, 0.4, -5.0]] },
    blobs: canopy(7, 1.7, 3.3, 1.0, 2.3, 30, 0.26, 0.46),
  },
  small: {
    w: 4.0, h: 5.4, ax: 2.0, ay: 5.2,
    trunk: { top: 2.8, w: 0.13, branches: [[0, -1.6, -0.6, -2.7], [0, -1.8, 0.55, -2.9]] },
    blobs: canopy(41, 2.0, 1.9, 1.3, 1.1, 22, 0.24, 0.44),
  },
  bush: {
    w: 2.4, h: 1.8, ax: 1.2, ay: 1.5,
    blobs: canopy(5, 1.2, 0.85, 0.78, 0.42, 14, 0.2, 0.34),
  },
  bush2: {
    w: 2.4, h: 1.8, ax: 1.2, ay: 1.5,
    blobs: canopy(17, 1.2, 0.88, 0.8, 0.4, 14, 0.19, 0.33),
  },
};

export type SpriteName = keyof typeof SPECS;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Sprites {
  private cache = new Map<string, Sprite>();
  constructor(private pal: Palette, private scale: number) {}

  reset(pal: Palette, scale: number) {
    if (pal === this.pal && Math.abs(scale - this.scale) < 1e-6) return;
    this.pal = pal;
    this.scale = scale;
    this.cache.clear();
  }

  get(name: SpriteName): Sprite {
    let s = this.cache.get(name);
    if (!s) {
      s = this.render(SPECS[name]);
      this.cache.set(name, s);
    }
    return s;
  }

  private render(sp: Spec): Sprite {
    const k = this.scale;
    const img = makeCanvas(Math.max(1, Math.ceil(sp.w * k)), Math.max(1, Math.ceil(sp.h * k)));
    const ctx = img.getContext('2d') as CanvasRenderingContext2D;
    ctx.scale(k, k);
    const pal = this.pal;
    if (sp.trunk) {
      const t = sp.trunk;
      ctx.strokeStyle = pal.trunk;
      ctx.lineCap = 'round';
      ctx.lineWidth = t.w;
      ctx.beginPath();
      ctx.moveTo(sp.ax, sp.ay);
      ctx.lineTo(sp.ax, sp.ay - t.top);
      ctx.stroke();
      ctx.lineWidth = t.w * 0.6;
      for (const b of t.branches) {
        ctx.beginPath();
        ctx.moveTo(sp.ax + b[0], sp.ay + b[1]);
        ctx.lineTo(sp.ax + b[2], sp.ay + b[3]);
        ctx.stroke();
      }
    }
    const hi: RGB = pal.leafHi, lo: RGB = pal.leafLo;
    // the canopy as one soft mass: union of all clusters, lit from the upper left
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ctx.beginPath();
    for (const b of sp.blobs) {
      ctx.moveTo(b.x + b.r, b.y);
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      x0 = Math.min(x0, b.x - b.r);
      y0 = Math.min(y0, b.y - b.r);
      x1 = Math.max(x1, b.x + b.r);
      y1 = Math.max(y1, b.y + b.r);
    }
    const body = ctx.createLinearGradient(x0, y0, x1, y1);
    body.addColorStop(0, css(mix(lo, hi, 0.92)));
    body.addColorStop(0.55, css(mix(lo, hi, 0.62)));
    body.addColorStop(1, css(mix(lo, hi, 0.12)));
    ctx.fillStyle = body;
    ctx.fill();
    // each cluster catches a little light on its upper-left side and shades its lower-right rim
    for (const b of sp.blobs) {
      if (b.d < 0.1) continue;
      const g = ctx.createRadialGradient(b.x - b.r * 0.4, b.y - b.r * 0.45, 0, b.x - b.r * 0.2, b.y - b.r * 0.2, b.r * 0.95);
      const a = 0.25 + b.d * 0.55;
      g.addColorStop(0, css(hi, a));
      g.addColorStop(1, css(hi, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = css(lo, 0.18 + (1 - b.d) * 0.2);
      ctx.lineWidth = b.r * 0.12;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * 0.9, Math.PI * 0.05, Math.PI * 0.7);
      ctx.stroke();
    }
    return { img, ax: sp.ax, ay: sp.ay, w: sp.w, h: sp.h };
  }
}
