// Surface details drawn onto building faces and roofs: window ribbons, solar fields, server fronts, battery doors.

import type { Ctx, R } from './draw';
import { onFaceX, onFaceY, onTop } from './draw';
import type { Palette } from './palette';

const gradCache = new WeakMap<Palette, Map<string, CanvasGradient>>();

function vgrad(ctx: Ctx, pal: Palette, key: string, top: number, bot: number, c0: string, c1: string) {
  let m = gradCache.get(pal);
  if (!m) gradCache.set(pal, (m = new Map()));
  const k = `${key}:${top}:${bot}`;
  let g = m.get(k);
  if (!g) {
    g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    m.set(k, g);
  }
  return g;
}

export interface Band {
  /** distance down from the top of the face */
  top: number;
  bot: number;
  /** mullion spacing */
  every?: number;
  /** horizontal spans [from, to] along the face; whole width if omitted */
  spans?: number[][];
  dark?: boolean;
}

/** Warm glazing in horizontal bands, with mullions. Call inside a face transform. */
export function ribbons(r: R, pal: Palette, ctx: Ctx, w: number, bands: Band[]) {
  const [c0, c1] = r.night ? pal.windowNight : pal.window;
  for (const b of bands) {
    const spans = b.spans ?? [[0.5, w - 0.5]];
    ctx.fillStyle = b.dark ? pal.glassDark : vgrad(ctx, pal, 'win', b.top, b.bot, c0, c1);
    for (const [a, z] of spans) ctx.fillRect(a, b.top, z - a, b.bot - b.top);
    const every = b.every ?? 1.4;
    ctx.beginPath();
    for (const [a, z] of spans) {
      for (let u = a + every; u < z - 0.05; u += every) {
        ctx.moveTo(u, b.top);
        ctx.lineTo(u, b.bot);
      }
      ctx.moveTo(a, b.top + (b.bot - b.top) * 0.32);
      ctx.lineTo(z, b.top + (b.bot - b.top) * 0.32);
    }
    ctx.strokeStyle = pal.mullion;
    ctx.lineWidth = 0.07;
    ctx.stroke();
  }
}

/** Night glow spilling from the windows. */
export function windowGlow(r: R, ctx: Ctx, w: number, bands: Band[]) {
  if (!r.night) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255, 190, 110, 0.10)';
  for (const b of bands) {
    if (b.dark) continue;
    for (const [a, z] of b.spans ?? [[0.5, w - 0.5]]) ctx.fillRect(a - 0.3, b.top - 0.3, z - a + 0.6, b.bot - b.top + 0.6);
  }
  ctx.restore();
}

export function windowsX(r: R, pal: Palette, x1: number, y0: number, y1: number, z1: number, bands: Band[]) {
  onFaceX(r, x1, y0, y1, z1, (ctx, w) => {
    ribbons(r, pal, ctx, w, bands);
    windowGlow(r, ctx, w, bands);
  });
}

export function windowsY(r: R, pal: Palette, x0: number, x1: number, y1: number, z1: number, bands: Band[]) {
  onFaceY(r, x0, x1, y1, z1, (ctx, w) => {
    ribbons(r, pal, ctx, w, bands);
    windowGlow(r, ctx, w, bands);
  });
}

/**
 * A roof covered with solar glass (see `solarGlint` for the moving highlight). With `strip` > 0 the panels come in
 * rows of that depth with walkways between them, like a factory roof.
 */
export function solarRoof(r: R, pal: Palette, x0: number, y0: number, x1: number, y1: number, z: number, inset = 0.5, strip = 0) {
  const w = x1 - x0, d = y1 - y0;
  onTop(r, x0, y0, z, (ctx) => {
    ctx.fillStyle = pal.solar;
    const cell = 1.05;
    ctx.beginPath();
    if (strip > 0) {
      const gap = 0.75;
      for (let q = inset; q < d - inset - 0.5; q += strip + gap) ctx.rect(inset, q, w - inset * 2, Math.min(strip, d - inset - q));
      ctx.fill();
      ctx.beginPath();
      for (let q = inset; q < d - inset - 0.5; q += strip + gap) {
        const h = Math.min(strip, d - inset - q);
        for (let p = inset + cell; p < w - inset - 0.1; p += cell) {
          ctx.moveTo(p, q);
          ctx.lineTo(p, q + h);
        }
        ctx.moveTo(inset, q + h / 2);
        ctx.lineTo(w - inset, q + h / 2);
      }
    } else {
      ctx.fillRect(inset, inset, w - inset * 2, d - inset * 2);
      for (let p = inset + cell; p < w - inset - 0.1; p += cell) {
        ctx.moveTo(p, inset);
        ctx.lineTo(p, d - inset);
      }
      for (let q = inset + 1.7; q < d - inset - 0.1; q += 1.7) {
        ctx.moveTo(inset, q);
        ctx.lineTo(w - inset, q);
      }
    }
    ctx.strokeStyle = pal.solarLine;
    ctx.lineWidth = 0.06;
    ctx.stroke();
  });
}

/** The moving glint across a solar roof, clipped analytically to the panel area (cheap enough to run live). */
export function solarGlint(r: R, x0: number, y0: number, x1: number, y1: number, z: number, inset = 0.5, phase = 0) {
  const w = x1 - x0 - inset * 2, d = y1 - y0 - inset * 2;
  const span = w + d;
  const pos = (((r.t * 0.045 + phase) % 1.4) - 0.2) * span;
  const half = 2.2;
  // the band pos-half < p+q < pos+half, intersected with the panel rectangle
  let poly = [[0, 0], [w, 0], [w, d], [0, d]];
  const cut = (pts: number[][], k: number, sign: number) => {
    const out: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const fa = sign * (a[0] + a[1] - k), fb = sign * (b[0] + b[1] - k);
      if (fa >= 0) out.push(a);
      if (fa * fb < 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  poly = cut(cut(poly, pos - half, 1), pos + half, -1);
  if (poly.length < 3) return;
  onTop(r, x0 + inset, y0 + inset, z, (ctx) => {
    const g = ctx.createLinearGradient((pos - half) / 2, (pos - half) / 2, (pos + half) / 2, (pos + half) / 2);
    g.addColorStop(0, 'rgba(200, 215, 255, 0)');
    g.addColorStop(0.5, r.night ? 'rgba(150, 170, 230, 0.10)' : 'rgba(210, 225, 255, 0.26)');
    g.addColorStop(1, 'rgba(200, 215, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
    ctx.closePath();
    ctx.fill();
  });
}

const H = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Server rack fronts (a +y face): the dark panel and unit dividers. */
export function rackFront(r: R, pal: Palette, x0: number, x1: number, y1: number, z0: number, z1: number) {
  onFaceY(r, x0, x1, y1, z1, (ctx, w) => {
    const h = z1 - z0;
    ctx.fillStyle = pal.rackFront;
    ctx.fillRect(0.06, 0.08, w - 0.12, h - 0.12);
    const n = Math.floor((w - 0.1) / RACK_UNIT);
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      ctx.moveTo(0.05 + i * RACK_UNIT, 0.08);
      ctx.lineTo(0.05 + i * RACK_UNIT, h - 0.05);
    }
    ctx.strokeStyle = pal.night ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 0.05;
    ctx.stroke();
  });
}

const RACK_UNIT = 0.62;

/** Blinking status lights on a rack front. */
export function rackLeds(r: R, pal: Palette, x0: number, x1: number, y1: number, z1: number, seed: number) {
  onFaceY(r, x0, x1, y1, z1, (ctx, w) => {
    const n = Math.floor((w - 0.1) / RACK_UNIT);
    const tick = Math.floor(r.t * 3.2);
    for (const blue of [false, true]) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 7; j++) {
          const hsh = H(i + seed * 13, j + tick * (0.3 + H(i, j) * 0.7));
          if (hsh < 0.45 || hsh > 0.86 !== blue) continue;
          ctx.rect(0.14 + i * RACK_UNIT + (j % 2) * 0.2, 0.3 + j * 0.26, 0.12, 0.06);
        }
      }
      ctx.fillStyle = blue ? pal.ledBlue : pal.led;
      ctx.fill();
    }
  });
}

/** Battery cabinet doors and a breathing status light (a +y face). */
export function batteryFront(r: R, pal: Palette, x0: number, x1: number, y1: number, z1: number) {
  onFaceY(r, x0, x1, y1, z1, (ctx, w) => {
    ctx.beginPath();
    const doors = 6;
    for (let i = 1; i < doors; i++) {
      const u = (w / doors) * i;
      ctx.moveTo(u, 0.22);
      ctx.lineTo(u, 2.55);
    }
    ctx.moveTo(0.1, 0.2);
    ctx.lineTo(w - 0.1, 0.2);
    ctx.strokeStyle = pal.night ? 'rgba(0,0,0,0.35)' : 'rgba(110,112,126,0.30)';
    ctx.lineWidth = 0.05;
    ctx.stroke();
    // vents
    ctx.fillStyle = pal.night ? 'rgba(0,0,0,0.35)' : 'rgba(90,92,104,0.22)';
    for (let i = 0; i < doors; i++) ctx.fillRect((w / doors) * i + 0.25, 0.38, w / doors - 0.5, 0.14);
  });
}

/** The breathing status light on a battery cabinet. */
export function batteryLed(r: R, pal: Palette, x0: number, x1: number, y1: number, z1: number, seed: number) {
  onFaceY(r, x0, x1, y1, z1, (ctx, w) => {
    const p = 0.5 + 0.5 * Math.sin(r.t * 1.6 + seed * 2.1);
    ctx.globalAlpha = 0.35 + 0.65 * p;
    ctx.fillStyle = pal.led;
    ctx.fillRect(w - 0.62, 0.62, 0.32, 0.07);
    ctx.globalAlpha = 1;
  });
}
