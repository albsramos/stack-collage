// Core math, isometric projection and clay-style materials.
//
// World space: x runs to the screen's lower right, y to the lower left, z up. One unit is about a metre.
// Screen ("design") space: X = (x - y)·cos30°, Y = (x + y)/2 - z. The camera then scales design units to pixels.

export const C = 0.8660254037844386; // cos 30°

export const sx = (x: number, y: number) => (x - y) * C;
export const sy = (x: number, y: number, z: number) => (x + y) * 0.5 - z;

export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rr = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
export const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng() * a.length) % a.length];
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------------------------------------------------------------------------------------------------------------
// Colour

export type RGB = readonly [number, number, number];

export function hex(h: string): RGB {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.replace(/./g, (c) => c + c) : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const c255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export function css(c: RGB, a = 1): string {
  return a >= 1 ? `rgb(${c255(c[0])},${c255(c[1])},${c255(c[2])})` : `rgba(${c255(c[0])},${c255(c[1])},${c255(c[2])},${a})`;
}

/** Parse '#rrggbb' or 'rgb(r,g,b)'. */
export function parse(c: string): RGB {
  if (c[0] === '#') return hex(c);
  const m = c.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [128, 128, 128];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------------------------------------------
// Lighting: a soft key light from the upper left, so shadows fall to the right like the reference render.

const LL = Math.hypot(-0.58, 0.26, 0.77);
const LX = -0.58 / LL, LY = 0.26 / LL, LZ = 0.77 / LL;

/** Wrap lighting in [0, 1] for a surface normal (need not be normalised). */
export function lightT(nx: number, ny: number, nz: number): number {
  const l = Math.hypot(nx, ny, nz) || 1;
  return 0.5 + 0.5 * ((nx * LX + ny * LY + nz * LZ) / l);
}

export const T_TOP = lightT(0, 0, 1);
export const T_LEFT = lightT(0, 1, 0); // faces pointing +y (screen lower-left)
export const T_RIGHT = lightT(1, 0, 0); // faces pointing +x (screen lower-right)

/** Shadow direction on the ground per unit of height (world units). */
export const SHADOW_DX = 0.55;
export const SHADOW_DY = -0.25;

/**
 * A matte material: a base colour that darkens (and cools slightly) as a face turns away from the light.
 * Thirty-three shades are precomputed so drawing never builds colour strings.
 */
export class Mat {
  readonly lv: string[] = [];
  readonly top: string;
  readonly left: string;
  readonly right: string;
  constructor(readonly base: RGB, readonly k = 0.19) {
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const f = 1 - k * (1 - t);
      const fb = 1 - k * 0.82 * (1 - t);
      this.lv.push(css([base[0] * f, base[1] * f, base[2] * fb]));
    }
    this.top = this.at(T_TOP);
    this.left = this.at(T_LEFT);
    this.right = this.at(T_RIGHT);
  }
  at(t: number): string {
    return this.lv[Math.round(clamp(t, 0, 1) * 32)];
  }
}

export const mat = (h: string, k?: number) => new Mat(hex(h), k);
