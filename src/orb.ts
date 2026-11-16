// The Stack orb: a lit sphere drawn as an ordered (Bayer) dither on a square grid, with a little dust shed
// off its shadow side. Pure drawing code, shared by the live <Orb> component and the icon generator.

export interface OrbFrame {
  /** Seconds since the orb started. */
  t: number;
  /** 0 = resting, 1 = busy (the light circles the sphere and the dust orbits). Animate between them. */
  spin: number;
  /** 0–1 while something with a known length runs: the sphere fills in as it rises. */
  fill: number;
  /** Light direction (screen angle, y down) to use instead of the resting sway, e.g. towards a finger. */
  aim?: number | null;
  /** 0–1: the dots fly in from scattered positions and settle into the sphere (an intro). 1 = settled. */
  assemble?: number;
  /** How far the light has travelled round while spinning (radians). Default: steady from `t`. */
  phase?: number;
  /** How far the dust has orbited (radians). Default: steady from `t`, while spinning. */
  orbit?: number;
  /** 0–1: the dust is flung outwards (a reaction), then falls back. */
  burst?: number;
}

export interface Dot {
  i: number;
  j: number;
}

// 8×8 Bayer matrix: the classic ordered-dither thresholds, 0–63.
export const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54,
  22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
];

const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Which cells of a `grid`×`grid` board are lit for this frame. */
/** `dust` scales how many specks are shed (1 = the default; small icons look cleaner with fewer). */
export function orbDots(grid: number, f: OrbFrame, dust = 1): Dot[] {
  const cx = grid / 2;
  const cy = grid * 0.45;
  const R = grid * 0.4;

  // The light sits up and to the right. At rest it sways a little; busy, it travels all the way round.
  const base = -Math.PI / 4;
  const rest = f.aim ?? base + Math.sin(f.t * 0.6) * 0.18;
  const theta = rest * (1 - f.spin) + (base + (f.phase ?? f.t * 2.2)) * f.spin;
  const lx = Math.cos(theta) * 0.62;
  const ly = Math.sin(theta) * 0.62;
  const lz = 0.48;

  const lit = new Set<number>();
  const out: Dot[] = [];
  const add = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= grid || j >= grid) return;
    const k = j * grid + i;
    if (lit.has(k)) return;
    lit.add(k);
    out.push({ i, j });
  };

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const x = (i + 0.5 - cx) / R;
      const y = (j + 0.5 - cy) / R;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const nz = Math.sqrt(1 - r2);
      let I = x * lx + y * ly + nz * lz; // Lambert, -1..1
      I = I * 0.9 + 0.34;
      // A slightly ragged rim, like the reference print, instead of a perfect circle.
      if (r2 > 0.86) I -= hash(i, j) * 0.35;
      I = I + (1 - I) * f.fill * 0.85;
      const th = (BAYER[(j % 8) * 8 + (i % 8)] + 0.5) / 64;
      if (I > th) add(i, j);
    }
  }

  // Dust: specks shed from the shadow side. At rest they twinkle in place; busy, they orbit the sphere.
  const N = Math.round(grid * 0.55 * dust);
  for (let k = 0; k < N; k++) {
    const h1 = hash(k, 1.3);
    const h2 = hash(k, 7.9);
    const h3 = hash(k, 4.2);
    // Mostly straight below, leaning left (screen angles, y down): 60°–140°.
    const a0 = ((60 + h1 * 80) * Math.PI) / 180;
    const d = (1.06 + h2 * h2 * 0.4) * (1 + (f.burst ?? 0) * (0.3 + h3 * 0.6)); // most sit close to the rim
    const a = a0 + (f.orbit ?? f.t * 1.6 * f.spin) / d;
    // Busy, the far specks fade in and out as they travel so the ring never looks solid.
    const tick = Math.floor(f.t * (2 + f.spin * 4) + h3 * 10);
    if (hash(k, tick) < 0.18 + f.spin * 0.2) continue;
    add(Math.floor(cx + Math.cos(a) * d * R), Math.floor(cy + Math.sin(a) * d * R));
  }

  const as = f.assemble ?? 1;
  if (as < 1) {
    // Each dot starts somewhere random on the board and travels in, staggered, with an ease-out.
    for (const p of out) {
      const h = hash(p.i, p.j);
      const k = Math.min(1, Math.max(0, as * 1.6 - h * 0.6));
      const e = 1 - (1 - k) ** 3;
      const sx = hash(p.i + 3.1, p.j) * grid;
      const sy = hash(p.i, p.j + 5.7) * grid;
      p.i = Math.round(sx + (p.i - sx) * e);
      p.j = Math.round(sy + (p.j - sy) * e);
    }
  }
  return out;
}

/** Draw a frame onto a 2D context sized `px`×`px` device pixels. */
export function drawOrb(ctx: CanvasRenderingContext2D, px: number, grid: number, color: string, f: OrbFrame) {
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = color;
  const cell = px / grid;
  const dot = Math.max(1, cell * 0.8);
  const pad = (cell - dot) / 2;
  for (const { i, j } of orbDots(grid, f)) {
    const x = Math.round(i * cell + pad);
    const y = Math.round(j * cell + pad);
    ctx.fillRect(x, y, Math.round(i * cell + pad + dot) - x, Math.round(j * cell + pad + dot) - y);
  }
}
