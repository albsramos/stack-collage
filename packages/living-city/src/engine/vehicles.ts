// Vehicles, their meshes, and a small traffic model: lanes are paths, intersections and crosswalks are zones
// a vehicle must reserve before entering, and every vehicle brakes for whatever is in front of it.

import { C, type Mat } from './core';
import { MeshBuilder, drawMesh, fillQuad, rectShadow, type MatSlot, type R, type Ctx } from './draw';
import type { Palette } from './palette';
import { Path, type Pose } from './path';
import type { Item } from './sort';

// ---------------------------------------------------------------------------------------------------------------
// Zones

export type Compat = (a: string, b: string) => boolean;

export class Zone {
  readonly holders = new Map<object, string>();
  /** Waiting list, first come first served: nobody may jump ahead of an earlier waiter it conflicts with. */
  private queue: { who: object; key: string; seen: number }[] = [];
  /** Advanced by the traffic tick; waiters that stop asking for half a second drop out of the queue. */
  clock = 0;
  /**
   * A key that waits for a gap: it may only enter when nobody else is inside or waiting, and nobody waits for it.
   * Crosswalks use 'ped', so people gather at the kerb and cross between cars.
   */
  yieldKey: string | null = null;
  /**
   * Optional invisible signal: approach letters allowed in each phase (e.g. ["NS", "EW"]). Phases switch when the
   * other side is waiting and the current one has had its minimum green, with a short clearance in between.
   */
  phases: string[] | null = null;
  phase = 0;
  private phaseT = 0;
  private clearing = 0;
  constructor(readonly x0: number, readonly y0: number, readonly x1: number, readonly y1: number, readonly compat: Compat) {}
  /** Advance the signal, if any. */
  tick(dt: number) {
    this.clock += dt;
    if (!this.phases) return;
    if (this.clearing > 0) {
      this.clearing -= dt;
      if (this.clearing <= 0) {
        this.phase = (this.phase + 1) % this.phases.length;
        this.phaseT = 0;
      }
      return;
    }
    this.phaseT += dt;
    const here = this.phases[this.phase];
    let mine = 0, others = 0;
    for (const q of this.queue) {
      if (this.clock - q.seen > 0.5) continue;
      if (here.includes(q.key[0])) mine++;
      else others++;
    }
    const minGreen = 4, maxGreen = this.phase === 0 ? 14 : 10;
    if (others > 0 && (this.phaseT > maxGreen || (this.phaseT > minGreen && mine === 0))) this.clearing = 1.2;
  }

  /** Join or refresh the queue; true if `who` could enter now. */
  ask(who: object, key: string): boolean {
    if (this.holders.has(who)) return true;
    let me: { who: object; key: string; seen: number } | undefined;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (this.clock - q.seen > 0.5) this.queue.splice(i, 1);
      else if (q.who === who) me = q;
    }
    if (!me) this.queue.push((me = { who, key, seen: this.clock }));
    else {
      me.seen = this.clock;
      me.key = key;
    }
    for (const [, k] of this.holders) if (!this.compat(k, key)) return false;
    if (this.phases) {
      if (this.clearing > 0) return false;
      const here = this.phases[this.phase];
      if (!here.includes(key[0])) return false;
      for (const q of this.queue) {
        if (q === me) break;
        if (here.includes(q.key[0]) && !this.compat(q.key, key)) return false;
      }
      return true;
    }
    if (this.yieldKey !== null) {
      if (key === this.yieldKey) {
        for (const q of this.queue) if (!this.compat(q.key, key)) return false;
        return true;
      }
      for (const q of this.queue) {
        if (q === me) break;
        if (q.key !== this.yieldKey && !this.compat(q.key, key)) return false;
      }
      return true;
    }
    for (const q of this.queue) {
      if (q === me) break;
      if (!this.compat(q.key, key)) return false;
    }
    return true;
  }
  enter(who: object, key: string) {
    this.holders.set(who, key);
    this.dequeue(who);
  }
  tryEnter(who: object, key: string): boolean {
    if (!this.ask(who, key)) return false;
    this.enter(who, key);
    return true;
  }
  leave(who: object) {
    this.holders.delete(who);
    this.dequeue(who);
  }
  private dequeue(who: object) {
    const i = this.queue.findIndex((q) => q.who === who);
    if (i >= 0) this.queue.splice(i, 1);
  }
  has(who: object) {
    return this.holders.has(who);
  }
  contains(x: number, y: number, m = 0) {
    return x >= this.x0 - m && x <= this.x1 + m && y >= this.y0 - m && y <= this.y1 + m;
  }
}

/** Crosswalks: cars share with cars, people with people. */
export const sameKind: Compat = (a, b) => a === b;

const OPP: Record<string, string> = { N: 'S', S: 'N', E: 'W', W: 'E' };
/** Junction keys are "<approach><turn>": approach N/S/E/W, turn S(traight), R (near side) or L (across traffic). */
export const junction: Compat = (a, b) => {
  if (a[0] === b[0]) return true;
  if (OPP[a[0]] === b[0]) return a[1] !== 'L' && b[1] !== 'L';
  return false;
};

function compass(hx: number, hy: number) {
  return Math.abs(hx) > Math.abs(hy) ? (hx > 0 ? 'E' : 'W') : hy > 0 ? 'S' : 'N';
}

// ---------------------------------------------------------------------------------------------------------------
// Meshes. Material slots: 0 paint, 1 glass, 2 dark/tyre, 3 head light, 4 tail light, 5 secondary paint

const box = (l0: number, l1: number, w: number): number[][] => [[l1, -w], [l1, w], [l0, w], [l0, -w]];

function rounded(a: number, b: number, r: number, steps = 2): number[][] {
  // counter-clockwise rounded rectangle in l/w
  const out: number[][] = [];
  const cs = [[a - r, b - r, 0], [-a + r, b - r, 1], [-a + r, -b + r, 2], [a - r, -b + r, 3]];
  for (const [cx, cy, q] of cs) {
    for (let i = 0; i <= steps; i++) {
      const ang = (q * Math.PI) / 2 + (i / steps) * (Math.PI / 2);
      out.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
    }
  }
  return out;
}

const inset = (p: number[][], k: number, dl = 0) => p.map(([l, w]) => [l * k + dl, w * k]);

/** Light strips as flush decals on the front (+l) or rear (-l) face. */
function lights(m: MeshBuilder, l: number, w: number, z0: number, z1: number, mat: number, split = 0) {
  const n = l > 0 ? 1 : -1;
  if (split > 0) {
    for (const s of [1, -1]) {
      const a = s * split, b = s * w;
      m.decal([[l, a, z0], [l, b, z0], [l, b, z1], [l, a, z1]], mat, n, 0, 0);
    }
  } else m.decal([[l, -w, z0], [l, w, z0], [l, w, z1], [l, -w, z1]], mat, n, 0, 0);
}

export const MESH = {
  car: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-2.05, 2.05, 0.86), 0, box(-2.05, 2.05, 0.86), 0.44, 2, 2);
    const body = rounded(2.35, 0.97, 0.42, 2);
    m.frustum(body, 0.3, body.map(([l, w]) => [l * 0.97 - 0.04, w * 0.95]), 0.86, 0, 0);
    m.frustum(box(-1.6, 0.95, 0.86), 0.86, box(-1.12, 0.22, 0.6), 1.42, 1, 1);
    lights(m, 2.351, 0.62, 0.6, 0.67, 3);
    lights(m, -2.351, 0.66, 0.64, 0.72, 4);
    return m.build();
  })(),
  suv: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-2.1, 2.1, 0.9), 0, box(-2.1, 2.1, 0.9), 0.5, 2, 2);
    const body = rounded(2.4, 1.0, 0.4, 2);
    m.frustum(body, 0.36, body.map(([l, w]) => [l * 0.97 - 0.02, w * 0.95]), 1.0, 0, 0);
    m.frustum(box(-1.95, 1.0, 0.9), 1.0, box(-1.75, 0.3, 0.66), 1.65, 1, 1);
    lights(m, 2.401, 0.64, 0.72, 0.8, 3);
    lights(m, -2.401, 0.68, 0.78, 0.86, 4);
    return m.build();
  })(),
  pickup: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-2.5, 2.5, 0.95), 0, box(-2.5, 2.5, 0.95), 0.5, 2, 2);
    m.extrude([[-2.85, 0.42], [2.85, 0.42], [2.85, 1.05], [0.45, 1.98], [-2.85, 1.3]], -1.05, 1.05, [2, 0, 1, 0, 0], 0);
    m.extrude([[-0.95, 1.32], [1.55, 1.32], [0.5, 1.86], [-0.95, 1.66]], -1.051, 1.051, [1], 1, true);
    lights(m, 2.851, 0.98, 0.9, 0.97, 3);
    lights(m, -2.851, 1.0, 1.14, 1.22, 4);
    return m.build();
  })(),
  pod: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-1.5, 1.5, 0.78), 0, box(-1.5, 1.5, 0.78), 0.38, 2, 2);
    const body = rounded(1.9, 0.95, 0.55, 3);
    m.frustum(body, 0.27, inset(body, 0.97), 0.74, 0, 0);
    const cb = rounded(1.3, 0.86, 0.4, 2).map(([l, w]) => [l - 0.2, w]);
    const ct = rounded(0.62, 0.56, 0.3, 2).map(([l, w]) => [l - 0.05, w]);
    m.frustum(cb, 0.74, ct, 1.33, 1, 1);
    lights(m, 1.901, 0.38, 0.55, 0.61, 3);
    lights(m, -1.901, 0.4, 0.56, 0.62, 4);
    return m.build();
  })(),
  van: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-3.1, 3.1, 1.05), 0, box(-3.1, 3.1, 1.05), 0.36, 2, 2);
    const fp = rounded(3.6, 1.22, 1.0, 3);
    m.frustum(fp, 0.28, inset(fp, 0.99), 0.95, 0, 0);
    m.frustum(inset(fp, 0.985), 0.95, inset(fp, 0.96), 1.72, 1, 1);
    m.frustum(inset(fp, 0.96), 1.72, inset(rounded(3.3, 1.0, 0.95, 3), 1), 2.02, 0, 0);
    lights(m, 3.601, 0.2, 0.62, 0.68, 3);
    lights(m, -3.601, 0.22, 0.62, 0.68, 4);
    return m.build();
  })(),
  tractor: (() => {
    const m = new MeshBuilder();
    // wheels and frame, then the fifth-wheel plate
    m.frustum(box(-3.0, 2.7, 0.92), 0, box(-3.0, 2.7, 0.92), 0.78, 2, 2);
    m.frustum(box(-2.5, -0.9, 0.7), 0.78, box(-2.5, -0.9, 0.7), 0.98, 2, 2);
    // aerodynamic cab: low nose, long raked windscreen
    m.extrude([[-0.7, 0.55], [3.15, 0.55], [3.2, 1.55], [1.35, 3.35], [0.2, 3.62], [-0.7, 3.62]], -1.25, 1.25, [2, 0, 1, 0, 0, 0], 0);
    m.extrude([[0.6, 2.2], [1.95, 2.2], [1.2, 2.95], [0.6, 3.05]], -1.251, 1.251, [1], 1, true);
    lights(m, 3.172, 0.95, 1.0, 1.08, 3);
    return m.build(true);
  })(),
  trailer: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-12.3, -8.6, 1.05), 0, box(-12.3, -8.6, 1.05), 1.25, 2, 2);
    m.frustum(box(-1.7, -1.3, 0.95), 0.1, box(-1.7, -1.3, 0.95), 1.22, 2, 2);
    m.frustum(box(-12.8, 0.6, 1.27), 1.2, box(-12.8, 0.6, 1.27), 4.1, 5, 5);
    lights(m, -12.801, 1.15, 1.3, 1.46, 4, 0.75);
    return m.build();
  })(),
  forklift: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-0.95, 0.75, 0.6), 0, box(-0.95, 0.75, 0.6), 0.34, 2, 2);
    m.frustum(box(-1.05, 0.72, 0.62), 0.3, box(-1.0, 0.7, 0.6), 1.02, 0, 0);
    m.frustum(box(-1.18, -0.6, 0.62), 0.3, box(-1.15, -0.62, 0.6), 1.3, 0, 0);
    // robot operator
    m.frustum(box(-0.5, -0.05, 0.24), 1.02, box(-0.45, -0.1, 0.22), 1.72, 6, 6);
    m.frustum(box(-0.36, -0.12, 0.12), 1.78, box(-0.36, -0.12, 0.12), 2.04, 7, 7);
    // guard posts and roof
    for (const [l, w] of [[0.55, 0.55], [0.55, -0.55], [-0.68, 0.55], [-0.68, -0.55]]) {
      const p = box(l - 0.03, l + 0.03, 0.03).map(([a, b]) => [a, b + w]);
      m.frustum(p, 1.0, p, 2.22, 2, 2);
    }
    m.frustum(box(-0.72, 0.6, 0.6), 2.22, box(-0.72, 0.6, 0.6), 2.3, 0, 0);
    // mast
    m.frustum(box(0.8, 0.92, 0.44), 0.1, box(0.8, 0.92, 0.44), 2.55, 2, 2);
    return m.build(true);
  })(),
  crate: (() => {
    const m = new MeshBuilder();
    m.frustum(box(-0.55, 0.55, 0.55), 0, box(-0.55, 0.55, 0.55), 0.12, 2, 2);
    m.frustum(box(-0.52, 0.52, 0.52), 0.12, box(-0.52, 0.52, 0.52), 0.95, 0, 0);
    return m.build();
  })(),
};

export type VehicleKind = 'car' | 'suv' | 'pickup' | 'pod' | 'van' | 'semi' | 'forklift';

const DIMS: Record<VehicleKind, [number, number, number]> = {
  // half length, half width, height
  car: [2.38, 0.98, 1.42],
  suv: [2.43, 1.0, 1.65],
  pickup: [2.88, 1.06, 1.98],
  pod: [1.92, 0.96, 1.33],
  van: [3.62, 1.23, 2.02],
  semi: [3.15, 1.27, 3.62],
  forklift: [1.15, 0.62, 2.55],
};

// ---------------------------------------------------------------------------------------------------------------
// Legs and vehicles

export interface Req {
  zone: Zone;
  key: string;
  sIn: number;
  sOut: number;
  held: boolean;
  done: boolean;
}

/** Zones that follow each other closely (a crosswalk right before a junction) are reserved together. */
type Group = Req[];

export interface Leg {
  path: Path;
  /** Drive backwards along the path. */
  rev?: boolean;
  vmax: number;
  /** Seconds to wait at the end of this leg. */
  dwell?: number;
  /** Hold at the end of this leg until this returns true. */
  until?: (v: Vehicle) => boolean;
  /** Called once when the leg is finished. */
  done?: (v: Vehicle) => void;
  /** Called once when the vehicle stops at the end of the leg (before dwelling). */
  arrive?: (v: Vehicle) => void;
  /** Don't brake for other vehicles on this leg (scripted yard moves). */
  ghost?: boolean;
}

interface LegState extends Leg {
  reqs: Req[];
  groups: Group[];
  limits: { s0: number; s1: number; v: number }[];
}

export interface Body {
  x: number;
  y: number;
  hx: number;
  hy: number;
  hl: number;
  hw: number;
}

const ACC = 2.6;
const DEC = 4.2;
const LAT = 2.2; // lateral acceleration used to slow down for curves

let VID = 1;

export class Vehicle {
  readonly id = VID++;
  x = 0;
  y = 0;
  hx = 1;
  hy = 0;
  v = 0;
  s = 0;
  li = 0;
  legs: LegState[] = [];
  dead = false;
  hl: number;
  hw: number;
  h: number;
  /** distance from the reference point back to the tail along the path (trailers make this long) */
  tail: number;
  bodies: Body[] = [];
  mats: MatSlot[];
  /** 0..1 — door animation for pods and vans, rear doors for trailers */
  door = 0;
  doorTarget = 0;
  /** trailer cargo fill 0..1 */
  cargo = 0;
  /** forklift fork height and load */
  fork = 0.15;
  load = false;
  /** charging indicator */
  charging = false;
  /** stay put when the plan runs out instead of leaving the scene (yard vehicles) */
  keep = false;
  private dwellT = 0;
  private arrived = false;
  private stuckT = 0;
  private ghostT = 0;
  readonly held = new Set<Zone>();
  // trailer state
  tx = 0;
  ty = 0;
  thx = 1;
  thy = 0;
  readonly items: Item[] = [];
  private readonly pose: Pose = { x: 0, y: 0, hx: 1, hy: 0 };

  constructor(readonly kind: VehicleKind, readonly pal: Palette, paint: Mat, legs: Leg[], readonly traffic: Traffic) {
    const [hl, hw, h] = DIMS[kind];
    this.hl = hl;
    this.hw = hw;
    this.h = h;
    this.tail = kind === 'semi' ? 1.6 + 12.8 : hl;
    this.mats = [paint, pal.carGlass, pal.tyre, pal.headlight, pal.taillight, pal.white, pal.robot, pal.robotHead];
    this.bodies.push({ x: 0, y: 0, hx: 1, hy: 0, hl, hw });
    if (kind === 'semi') this.bodies.push({ x: 0, y: 0, hx: 1, hy: 0, hl: 6.7, hw: 1.27 });
    this.items.push(new VehicleItem(this, 0));
    if (kind === 'semi') this.items.push(new VehicleItem(this, 1));
    this.setLegs(legs);
    this.placeAt(0);
    if (kind === 'semi') {
      // start with the trailer straight behind the tractor
      const kx = this.x - this.hx * 1.6, ky = this.y - this.hy * 1.6;
      this.thx = this.hx;
      this.thy = this.hy;
      this.tx = kx - this.thx * 9.6;
      this.ty = ky - this.thy * 9.6;
    }
    this.syncBodies();
  }

  setLegs(legs: Leg[]) {
    this.legs = legs.map((l) => this.prepare(l));
    this.li = 0;
    this.s = 0;
    this.dwellT = 0;
    this.arrived = false;
  }

  /** Append legs after the current plan. */
  pushLegs(legs: Leg[]) {
    for (const l of legs) this.legs.push(this.prepare(l));
  }

  private prepare(l: Leg): LegState {
    const reqs: Req[] = [];
    for (const z of this.traffic.zones) {
      for (const [a, b] of l.path.spans(z.x0, z.y0, z.x1, z.y1)) {
        const p0 = l.path.at(Math.min(l.path.len, a + 0.5), { x: 0, y: 0, hx: 1, hy: 0 });
        const p1 = l.path.at(Math.max(0, b - 0.5), { x: 0, y: 0, hx: 1, hy: 0 });
        let key = 'car';
        if (z.compat === junction) {
          const cr = p0.hx * p1.hy - p0.hy * p1.hx;
          const dot = p0.hx * p1.hx + p0.hy * p1.hy;
          const turn = dot > 0.85 ? 'S' : cr > 0 ? 'R' : 'L';
          key = compass(p0.hx, p0.hy) + turn;
        }
        reqs.push({ zone: z, key, sIn: a, sOut: b, held: false, done: false });
      }
    }
    reqs.sort((a, b) => a.sIn - b.sIn);
    const groups: Group[] = [];
    for (const q of reqs) {
      const g = groups[groups.length - 1];
      if (g && q.sIn - Math.max(...g.map((x) => x.sOut)) < 3.5) g.push(q);
      else groups.push([q]);
    }
    const limits: { s0: number; s1: number; v: number }[] = [];
    l.path.segs.forEach((g, i) => {
      if (g.k === 1) limits.push({ s0: l.path.cum[i], s1: l.path.cum[i] + g.len, v: Math.max(1.4, Math.sqrt(g.r * LAT)) });
    });
    return { ...l, reqs, groups, limits };
  }

  get leg(): LegState | undefined {
    return this.legs[this.li];
  }

  private placeAt(s: number) {
    const leg = this.leg;
    if (!leg) return;
    leg.path.at(s, this.pose);
    this.x = this.pose.x;
    this.y = this.pose.y;
    if (leg.rev) {
      this.hx = -this.pose.hx;
      this.hy = -this.pose.hy;
    } else {
      this.hx = this.pose.hx;
      this.hy = this.pose.hy;
    }
  }

  /** Jump forward along the current leg (used to start the scene mid-route). */
  advance(ds: number) {
    const leg = this.leg;
    if (!leg) return;
    this.s = Math.min(leg.path.len - 0.01, this.s + ds);
    this.placeAt(this.s);
    if (this.kind === 'semi') {
      const kx = this.x - this.hx * 1.6, ky = this.y - this.hy * 1.6;
      this.thx = this.hx;
      this.thy = this.hy;
      this.tx = kx - this.thx * 9.6;
      this.ty = ky - this.thy * 9.6;
    }
    this.syncBodies();
  }

  private syncBodies() {
    const b = this.bodies[0];
    b.x = this.x;
    b.y = this.y;
    b.hx = this.hx;
    b.hy = this.hy;
    if (this.kind === 'semi') {
      const t = this.bodies[1];
      // centre of the trailer box (-12.8..0.6 from the kingpin), from the rear axle at -9.6
      const kx = this.x - this.hx * 1.6, ky = this.y - this.hy * 1.6;
      t.x = kx - this.thx * 6.1;
      t.y = ky - this.thy * 6.1;
      t.hx = this.thx;
      t.hy = this.thy;
    }
  }

  update(dt: number) {
    const leg = this.leg;
    if (!leg) {
      if (!this.keep) this.die();
      return;
    }
    // door animation
    if (this.door !== this.doorTarget) {
      const sp = this.kind === 'semi' ? 0.45 : 1.6;
      this.door = this.door < this.doorTarget ? Math.min(this.doorTarget, this.door + dt * sp) : Math.max(this.doorTarget, this.door - dt * sp);
    }
    const len = leg.path.len;
    const isLast = this.li === this.legs.length - 1;
    const stopsHere = isLast || leg.dwell !== undefined || !!leg.until || !!leg.arrive || leg.rev !== this.legs[this.li + 1]?.rev;
    let dStop = stopsHere ? len - this.s : Infinity;
    // zones
    const front = this.s + this.hl;
    const reach = 10 + (this.v * this.v) / (2 * DEC);
    for (const g of leg.groups) {
      let pending = false;
      for (const q of g) if (!q.held && !q.done) pending = true;
      if (!pending) continue;
      const sIn = g[0].sIn;
      if (sIn - front >= reach) break;
      let ok = true;
      for (const q of g) if (!q.held && !q.done && !q.zone.ask(this, q.key)) ok = false;
      if (!ok) {
        dStop = Math.min(dStop, sIn - front - 0.4);
        break;
      }
      for (const q of g) {
        if (q.held || q.done) continue;
        q.zone.enter(this, q.key);
        q.held = true;
        this.held.add(q.zone);
      }
    }
    // release zones we have fully left
    for (const z of this.held) {
      let inside = false;
      for (const b of this.bodies) if (z.contains(b.x, b.y, b.hl + 0.3)) inside = true;
      const pending = leg.reqs.some((q) => q.zone === z && !q.done && q.sOut > this.s - this.tail);
      if (!inside && !pending) {
        z.leave(this);
        this.held.delete(z);
        for (const q of leg.reqs) if (q.zone === z) q.done = true;
      }
    }
    // vehicles ahead
    let blocked = false;
    if (!leg.ghost && this.ghostT <= 0) {
      const gap = this.sense();
      if (gap < dStop + 1.4) {
        if (gap - 1.4 < 0.5) blocked = true;
        dStop = Math.min(dStop, gap - 1.4);
      }
    }
    if (this.ghostT > 0) this.ghostT -= dt;
    let vt = leg.vmax;
    for (const lim of leg.limits) {
      if (this.s > lim.s1) continue;
      const d = lim.s0 - this.s;
      vt = Math.min(vt, d <= 0 ? lim.v : Math.sqrt(lim.v * lim.v + 2 * DEC * 0.6 * d));
    }
    if (dStop < Infinity) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * DEC * Math.max(0, dStop))));
    if (vt > this.v) this.v = Math.min(vt, this.v + ACC * dt);
    else this.v = Math.max(vt, this.v - DEC * 2.2 * dt);
    if (dStop <= 0.02 && dStop < len - this.s - 0.05) this.v = 0;
    // deadlock breaker
    if (blocked && this.v < 0.05) {
      this.stuckT += dt;
      if (this.stuckT > 12) {
        this.ghostT = 2.5;
        this.stuckT = 0;
      }
    } else this.stuckT = 0;

    this.s += this.v * dt;
    if (this.s >= len - 1e-4) {
      const extra = Math.max(0, this.s - len);
      this.s = len;
      if (stopsHere) this.v = 0;
      if (!this.arrived) {
        this.arrived = true;
        leg.arrive?.(this);
      }
      let go = true;
      if (leg.dwell !== undefined) {
        this.dwellT += dt;
        if (this.dwellT < leg.dwell) go = false;
      }
      if (go && leg.until && !leg.until(this)) go = false;
      if (go) {
        leg.done?.(this);
        this.li++;
        this.dwellT = 0;
        this.arrived = false;
        if (this.li >= this.legs.length) {
          if (!this.keep) this.die();
          return;
        }
        this.s = stopsHere ? 0 : extra;
      }
    }
    this.placeAt(this.s);
    if (this.kind === 'semi') this.updateTrailer();
    this.syncBodies();
  }

  private updateTrailer() {
    const kx = this.x - this.hx * 1.6, ky = this.y - this.hy * 1.6;
    let dx = kx - this.tx, dy = ky - this.ty;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    this.thx = dx;
    this.thy = dy;
    this.tx = kx - dx * 9.6;
    this.ty = ky - dy * 9.6;
  }

  /** @internal debugging: the body that last blocked us */
  blocker: Vehicle | null = null;

  private readonly probe: Pose = { x: 0, y: 0, hx: 1, hy: 0 };

  /**
   * Distance from our front to the first vehicle that sits on the road we are about to drive, found by walking
   * our own path ahead (into following legs that we flow into) and testing each point against the other bodies.
   */
  private sense(): number {
    this.blocker = null;
    const look = 16;
    const step = 0.7;
    const m = this.hw + 0.15;
    // candidates near enough to matter
    const near: Body[] = [];
    const owners: Vehicle[] = [];
    const rev = this.legs[this.li]?.rev;
    const mx = rev ? -this.hx : this.hx, my = rev ? -this.hy : this.hy;
    for (const o of this.traffic.vehicles) {
      if (o === this || o.dead) continue;
      for (const b of o.bodies) {
        if (Math.abs(b.x - this.x) > look + this.hl + b.hl + 2 || Math.abs(b.y - this.y) > look + this.hl + b.hl + 2) continue;
        // whatever is behind our centre is not in our way
        if ((b.x - this.x) * mx + (b.y - this.y) * my < 0) continue;
        near.push(b);
        owners.push(o);
      }
    }
    if (!near.length) return Infinity;
    let li = this.li, base = this.s + this.hl;
    let leg = this.legs[li];
    const p = this.probe;
    for (let d = 0; d <= look; d += step) {
      let sp = base + d;
      while (leg && sp > leg.path.len) {
        const next = this.legs[li + 1];
        const flows = next && !leg.dwell && !leg.until && !leg.arrive && next.rev === leg.rev;
        if (!flows) {
          sp = leg.path.len;
          break;
        }
        sp -= leg.path.len;
        base -= leg.path.len;
        li++;
        leg = next;
      }
      if (!leg) break;
      leg.path.at(sp, p);
      for (let i = 0; i < near.length; i++) {
        const b = near[i];
        const dx = p.x - b.x, dy = p.y - b.y;
        const a = dx * b.hx + dy * b.hy, c = -dx * b.hy + dy * b.hx;
        if (Math.abs(a) < b.hl + m && Math.abs(c) < b.hw + m) {
          this.blocker = owners[i];
          return d;
        }
      }
    }
    return Infinity;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    for (const z of this.held) z.leave(this);
    this.held.clear();
  }

  shadow(ctx: Ctx) {
    rectShadow(ctx, this.x, this.y, this.hx, this.hy, this.hl * 0.96, this.hw * 0.96, this.h * 0.78);
    if (this.kind === 'semi') {
      const t = this.bodies[1];
      rectShadow(ctx, t.x, t.y, t.hx, t.hy, t.hl, t.hw, 3.6);
    }
  }
}

/** Drawable part of a vehicle: the vehicle itself, or a semi's trailer. */
class VehicleItem implements Item {
  x0 = 0;
  x1 = 0;
  y0 = 0;
  y1 = 0;
  z0 = 0;
  z1 = 0;
  constructor(readonly v: Vehicle, readonly part: 0 | 1) {}

  bounds() {
    const b = this.v.bodies[this.part];
    const ex = Math.abs(b.hx) * b.hl + Math.abs(b.hy) * b.hw;
    const ey = Math.abs(b.hy) * b.hl + Math.abs(b.hx) * b.hw;
    let x0 = b.x - ex, x1 = b.x + ex, y0 = b.y - ey, y1 = b.y + ey;
    if (this.v.kind === 'forklift') {
      // forks and load stick out in front
      const fx = this.v.x + this.v.hx * 1.9, fy = this.v.y + this.v.hy * 1.9;
      x0 = Math.min(x0, fx - 0.6);
      x1 = Math.max(x1, fx + 0.6);
      y0 = Math.min(y0, fy - 0.6);
      y1 = Math.max(y1, fy + 0.6);
    }
    this.x0 = x0;
    this.x1 = x1;
    this.y0 = y0;
    this.y1 = y1;
    this.z0 = 0;
    this.z1 = this.part === 1 ? 4.1 : this.v.h;
  }

  draw(r: R) {
    const v = this.v;
    const pal = v.pal;
    switch (v.kind) {
      case 'semi':
        if (this.part === 0) drawMesh(r, MESH.tractor, v.x, v.y, 0, v.hx, v.hy, v.mats);
        else drawTrailer(r, v);
        break;
      case 'forklift':
        drawForklift(r, v);
        break;
      default: {
        const mesh = MESH[v.kind];
        drawMesh(r, mesh, v.x, v.y, 0, v.hx, v.hy, v.mats);
        if ((v.kind === 'pod' || v.kind === 'van') && v.door > 0.01) drawDoors(r, v);
        if (r.night) drawLights(r, v);
      }
    }
    if (v.charging) {
      // small pulsing charge-port light at the front corner
      const p = 0.5 + 0.5 * Math.sin(r.t * 3 + v.id);
      const lx = v.x + v.hx * (v.hl - 0.2) - v.hy * (v.hw - 0.05);
      const ly = v.y + v.hy * (v.hl - 0.2) + v.hx * (v.hw - 0.05);
      const ctx = r.ctx;
      ctx.fillStyle = pal.led;
      ctx.globalAlpha = 0.45 + 0.55 * p;
      ctx.beginPath();
      ctx.arc((lx - ly) * C, (lx + ly) * 0.5 - 0.75, 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function drawLights(r: R, v: Vehicle) {
  const ctx = r.ctx;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const fx = v.x + v.hx * (v.hl + 1.6), fy = v.y + v.hy * (v.hl + 1.6);
  const X = (fx - fy) * C, Y = (fx + fy) * 0.5;
  const g = ctx.createRadialGradient(X, Y, 0, X, Y, 2.4);
  g.addColorStop(0, 'rgba(255, 236, 190, 0.22)');
  g.addColorStop(1, 'rgba(255, 236, 190, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(X, Y, 2.6, 1.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDoors(r: R, v: Vehicle) {
  // gull-wing style doors: a panel on each side swinging up from the roof line
  const ctx = r.ctx;
  const k = v.door;
  const isVan = v.kind === 'van';
  for (const side of [1, -1]) {
    // only the camera-facing side reads at this size
    const nx = -v.hy * side, ny = v.hx * side;
    if (nx + ny <= 0) continue;
    const l0 = isVan ? -0.6 : -0.9, l1 = isVan ? 1.0 : 0.6;
    const zb = 0.45, zt = isVan ? 1.85 : 1.25;
    const w = v.hw * 0.98;
    const pts: number[] = [];
    if (isVan) {
      // sliding door: an opening that grows, the panel slides back
      const open = k * (l1 - l0);
      for (const [l, z] of [[l0, zb], [l0 + open, zb], [l0 + open, zt], [l0, zt]]) {
        const x = v.x + v.hx * l + nx * w, y = v.y + v.hy * l + ny * w;
        pts.push((x - y) * C, (x + y) * 0.5 - z);
      }
      fillQuad(r, '#1c1d22', pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
    } else {
      const lift = k * 1.1;
      for (const [l, z, out] of [[l0, zb + lift, 0.1 + k * 0.4], [l1, zb + lift, 0.1 + k * 0.4], [l1, zt + lift * 0.8, 0], [l0, zt + lift * 0.8, 0]]) {
        const x = v.x + v.hx * l + nx * (w + out), y = v.y + v.hy * l + ny * (w + out);
        pts.push((x - y) * C, (x + y) * 0.5 - z);
      }
      // dark opening first, then the raised door
      const op: number[] = [];
      for (const [l, z] of [[l0, zb], [l1, zb], [l1, zt], [l0, zt]]) {
        const x = v.x + v.hx * l + nx * w, y = v.y + v.hy * l + ny * w;
        op.push((x - y) * C, (x + y) * 0.5 - z);
      }
      ctx.globalAlpha = Math.min(1, k * 2);
      fillQuad(r, '#1c1d22', op[0], op[1], op[2], op[3], op[4], op[5], op[6], op[7]);
      ctx.globalAlpha = 1;
      const m = v.mats[0] as Mat;
      fillQuad(r, m.at(0.55 + k * 0.3), pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
    }
  }
}

function drawForklift(r: R, v: Vehicle) {
  const pal = v.pal;
  const fz = v.fork;
  const loadFirst = v.hx + v.hy < 0; // load is on the far side when driving away from the camera
  const drawLoad = () => {
    const ctx = r.ctx;
    // forks
    const pts: number[] = [];
    for (const [l, w] of [[2.0, 0.42], [2.0, -0.42], [0.95, -0.42], [0.95, 0.42]]) {
      const x = v.x + v.hx * l - v.hy * w, y = v.y + v.hy * l + v.hx * w;
      pts.push((x - y) * C, (x + y) * 0.5 - fz);
    }
    ctx.fillStyle = pal.tyre;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < 8; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
    if (v.load) drawMesh(r, MESH.crate, v.x + v.hx * 1.55, v.y + v.hy * 1.55, fz, v.hx, v.hy, [pal.crate, pal.carGlass, pal.concrete.right]);
  };
  if (loadFirst) drawLoad();
  drawMesh(r, MESH.forklift, v.x, v.y, 0, v.hx, v.hy, v.mats);
  if (!loadFirst) drawLoad();
}

/** Cargo slots along the trailer (distance back from the kingpin), filled front first. */
export const CARGO_SLOTS = [-2.6, -5.6, -8.6, -11.6];

function drawTrailer(r: R, v: Vehicle) {
  const ctx = r.ctx;
  const pal = v.pal;
  const kx = v.x - v.hx * 1.6, ky = v.y - v.hy * 1.6;
  const hx = v.thx, hy = v.thy;
  drawMesh(r, MESH.trailer, kx, ky, 0, hx, hy, v.mats);
  const open = v.door; // curtain side: 0 closed … 1 rolled up
  if (open <= 0.01) return;
  // the side that faces the camera rolls up
  const side = -hy + hx > 0 ? 1 : -1;
  const W = 1.272 * side;
  const pts: number[] = [];
  const P = (l: number, w: number, z: number) => {
    const x = kx + hx * l - hy * w, y = ky + hy * l + hx * w;
    pts.push((x - y) * C, (x + y) * 0.5 - z);
  };
  const top = 1.3 + 2.72 * open;
  pts.length = 0;
  P(-12.65, W, 1.3);
  P(0.45, W, 1.3);
  P(0.45, W, top);
  P(-12.65, W, top);
  const op = pts.slice();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(op[0], op[1]);
  for (let i = 2; i < 8; i += 2) ctx.lineTo(op[i], op[i + 1]);
  ctx.closePath();
  ctx.fillStyle = pal.night ? '#0d0e11' : '#61636c';
  ctx.fill();
  ctx.clip();
  // floor
  pts.length = 0;
  P(-12.65, -W, 1.3);
  P(0.45, -W, 1.3);
  P(0.45, W, 1.3);
  P(-12.65, W, 1.3);
  fillQuad(r, pal.night ? '#1b1c21' : '#80828b', pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
  // posts every few metres
  ctx.strokeStyle = pal.night ? '#24262c' : '#8f919a';
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  for (let l = -12.6; l <= 0.5; l += 3.27) {
    pts.length = 0;
    P(l, -W * 0.98, 1.3);
    P(l, -W * 0.98, 4.05);
    ctx.moveTo(pts[0], pts[1]);
    ctx.lineTo(pts[2], pts[3]);
  }
  ctx.stroke();
  const n = Math.round(v.cargo * CARGO_SLOTS.length);
  const cm = [pal.crate, pal.carGlass, pal.concrete.right];
  for (const w of [-0.62 * side, 0.62 * side]) {
    for (let i = 0; i < n; i++) {
      for (const dl of [0.62, -0.62]) {
        const l = CARGO_SLOTS[i] + dl;
        const cx = kx + hx * l - hy * w, cy = ky + hy * l + hx * w;
        drawMesh(r, MESH.crate, cx, cy, 1.3, hx, hy, cm);
        drawMesh(r, MESH.crate, cx, cy, 2.27, hx, hy, cm);
      }
    }
  }
  ctx.restore();
  // the rolled-up curtain along the top
  pts.length = 0;
  P(-12.75, W * 1.01, top);
  P(0.55, W * 1.01, top);
  P(0.55, W * 1.01, Math.min(4.08, top + 0.28));
  P(-12.75, W * 1.01, Math.min(4.08, top + 0.28));
  fillQuad(r, (v.mats[5] as Mat).at(0.45), pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
}

// ---------------------------------------------------------------------------------------------------------------
// Traffic

export class Traffic {
  readonly vehicles: Vehicle[] = [];
  readonly zones: Zone[] = [];
  constructor(readonly pal: Palette) {}

  zone(x0: number, y0: number, x1: number, y1: number, compat: Compat) {
    const z = new Zone(x0, y0, x1, y1, compat);
    if (compat === sameKind) z.yieldKey = 'ped';
    this.zones.push(z);
    return z;
  }

  add(kind: VehicleKind, paint: Mat, legs: Leg[]) {
    const v = new Vehicle(kind, this.pal, paint, legs, this);
    this.vehicles.push(v);
    return v;
  }

  /** True if nothing is within `r` of (x, y). */
  clear(x: number, y: number, r: number) {
    for (const v of this.vehicles) for (const b of v.bodies) if (Math.hypot(b.x - x, b.y - y) < r + b.hl) return false;
    return true;
  }

  update(dt: number) {
    for (const z of this.zones) z.tick(dt);
    for (const v of this.vehicles) v.update(dt);
    for (let i = this.vehicles.length - 1; i >= 0; i--) if (this.vehicles[i].dead) this.vehicles.splice(i, 1);
  }

  items(out: Item[]) {
    for (const v of this.vehicles) for (const it of v.items) {
      (it as VehicleItem).bounds();
      out.push(it);
    }
  }

  shadows(ctx: Ctx) {
    for (const v of this.vehicles) v.shadow(ctx);
  }
}
