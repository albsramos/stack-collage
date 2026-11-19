// Scripted bits of life: the truck loading bay, the charging lot, the robotaxi stop, the crane, the robot workbench,
// and small scenes in the park.

import { C, clamp, lerp, pick, rr, smooth, type Mat, type Rng } from './core';
import { box, blobShadow, boxShadow, drawMesh, lineW, rectShadow, type Ctx, type R } from './draw';
import type { Palette } from './palette';
import { Path } from './path';
import type { Item } from './sort';
import type { Static } from './statics';
import { FnItem } from './statics';
import { MESH, Traffic, Vehicle, backingTrack, type Leg } from './vehicles';
import { Crowd, Walker } from './walkers';

export interface Activity {
  update(dt: number): void;
  items?(out: Item[]): void;
  shadows?(ctx: Ctx): void;
}

export interface Env {
  pal: Palette;
  rng: Rng;
  traffic: Traffic;
  crowd: Crowd;
  statics: Static[];
}

const P = Path.poly;

/** A one-at-a-time lock. */
class Mutex {
  owner: object | null = null;
  take(who: object) {
    if (this.owner && this.owner !== who) return false;
    this.owner = who;
    return true;
  }
  free(who: object) {
    if (this.owner === who) this.owner = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Truck loading bay (left of the factory road): a semi pulls in, opens up, a forklift and two robots fill it, it
// closes and drives off across the scene; a while later the next one arrives.

export class TruckBay implements Activity {
  private state: 'empty' | 'arriving' | 'opening' | 'loading' | 'closing' | 'leaving' = 'empty';
  private timer = 2;
  private truck: Vehicle | null = null;
  private fork: Vehicle;
  private stack = 2;
  private restock = 0;
  private loaders: Walker[] = [];
  private shuttling = false;
  private slot = 0;
  /** where the truck parks: lane x, tractor y */
  static readonly LANE = 37;
  static readonly STOP = 77;
  /** the forklift lane beside the trailer, and its stack */
  private readonly FX = 41;
  private readonly HUB = 91.6;
  private readonly PICK = 92.85;

  constructor(private env: Env) {
    const { traffic, pal } = env;
    this.fork = traffic.add('forklift', pal.white, [{ path: P([[this.FX, 93], [this.FX, this.HUB]]), vmax: 1, ghost: true }]);
    this.fork.keep = true;
    // two robots carry boxes from a pile by the tail of the trailer into its open side
    for (let i = 0; i < 2; i++) {
      const w = new Walker('robot', pal, env.rng, 39.4 + i * 0.6, 95.2 + i * 0.5);
      w.face(-0.3, -1);
      this.loaders.push(env.crowd.add(w));
    }
    const m = [pal.crate, pal.carGlass, pal.concrete.right];
    env.statics.push(
      // pallet stack the forklift draws from, and the robots' box pile
      new FnItem(40.4, 93.8, 0, 43.8, 97.6, 2.0, (r) => {
        drawMesh(r, MESH.crate, 42.9, 94.4, 0, 0, 1, m);
        drawMesh(r, MESH.crate, 42.9, 94.4, 0.95, 0, 1, m);
        drawMesh(r, MESH.crate, 42.9, 96.6, 0, 0, 1, m);
        for (let i = 0; i < this.stack; i++) drawMesh(r, MESH.crate, this.FX, 94.4, i * 0.95, 0, 1, m);
      }, (ctx) => boxShadow(ctx, 40.4, 93.8, 43.5, 97.2, 1.8)),
      new FnItem(38.2, 96.0, 0, 39.6, 97.2, 0.7, (r) => {
        box(r, 38.3, 96.1, 0, 38.9, 96.7, 0.45, pal.crate);
        box(r, 38.95, 96.2, 0, 39.5, 96.75, 0.4, pal.crate);
        box(r, 38.5, 96.15, 0.45, 39.05, 96.7, 0.85, pal.crate);
      }).still(),
    );
  }

  private spawnTruck() {
    const { traffic, pal, rng } = this.env;
    const L = TruckBay.LANE, Y = TruckBay.STOP;
    const paint = rng() < 0.75 ? pal.white : pal.paints[2];
    this.truck = traffic.add('semi', paint, [
      {
        path: P([[50, 160], [50, 130], [L, 117], [L, Y]], [6, 6]),
        vmax: 5.5,
        arrive: (v) => {
          this.state = 'opening';
          v.doorTarget = 1;
        },
        until: () => this.state === 'leaving',
      },
      { path: P([[L, Y], [L, 71], [50, 58], [50, 48], [135, 48]], [6, 6, 6]), vmax: 5.5 },
    ]);
    this.truck.mats[5] = pal.white;
    this.truck.cargo = 0;
    this.slot = 0;
    this.state = 'arriving';
  }

  /** One trip: pick a pallet, back round to face the trailer, push it in, return. */
  private cycle() {
    const f = this.fork;
    const X = this.FX;
    const ty = TruckBay.STOP + 1.6 - 0; // kingpin y
    const yk = ty - [-2.6, -5.6, -8.6, -11.6][this.slot];
    const side = TruckBay.LANE + 1.27 + 0.08 + 2.05; // forklift centre when its forks touch the trailer
    this.shuttling = true;
    f.setLegs([
      { path: P([[X, this.HUB], [X, this.PICK]]), vmax: 2.2, ghost: true, dwell: 0.5, done: (v) => {
        v.load = true;
        this.stack = Math.max(0, this.stack - 1);
        this.restock = 4;
      } },
      { path: P([[X, this.PICK], [X, yk], [X + 2.0, yk]], [2.0]), rev: true, vmax: 2.6, ghost: true },
      { path: P([[X + 2.0, yk], [side, yk]]), vmax: 2.0, ghost: true, dwell: 0.6, done: (v) => {
        v.load = false;
        if (this.truck) this.truck.cargo = Math.min(1, (this.slot + 1) / 4);
        this.slot++;
      } },
      { path: P([[side, yk], [X + 2.0, yk]]), rev: true, vmax: 2.0, ghost: true },
      { path: P([[X + 2.0, yk], [X, yk], [X, this.HUB]], [2.0]), vmax: 2.8, ghost: true, arrive: () => {
        this.shuttling = false;
      } },
    ]);
  }

  update(dt: number) {
    const f = this.fork;
    // forks rise to the trailer floor on the way in, and sit low otherwise
    const target = f.load ? (f.li === 2 ? 1.35 : 0.45) : 0.12;
    f.fork += clamp(target - f.fork, -dt * 1.1, dt * 1.1);
    if (this.restock > 0) {
      this.restock -= dt;
      if (this.restock <= 0) this.stack = 2;
    }
    const t = this.truck;
    switch (this.state) {
      case 'empty':
        this.timer -= dt;
        if (this.timer <= 0 && this.env.traffic.clear(50, 160, 16)) this.spawnTruck();
        break;
      case 'opening':
        if (t && t.door >= 1) this.state = 'loading';
        break;
      case 'loading':
        if (!t) break;
        if (this.slot >= 4 && !this.shuttling) {
          t.doorTarget = 0;
          this.state = 'closing';
          this.timer = 1.0;
        } else if (!this.shuttling && this.slot < 4) this.cycle();
        break;
      case 'closing':
        if (t && t.door <= 0) {
          this.timer -= dt;
          if (this.timer <= 0) this.state = 'leaving';
        }
        break;
      case 'leaving':
        // the next truck is only sent once this one has left the scene
        if (!t || t.dead) {
          this.truck = null;
          this.state = 'empty';
          this.timer = rr(this.env.rng, 4, 8);
        }
        break;
    }
    // robots: carry boxes into the open side near the tail, otherwise wait by their pile
    const open = this.state === 'loading';
    this.loaders.forEach((w, i) => {
      if (w.steps.length || w.waitT > 0) return;
      const hx = 39.4 + i * 0.6, hy = 95.2 + i * 0.5;
      if (open) {
        const dy = 89.6 - i * 1.4;
        w.go([
          { x: 39.0 + i * 0.4, y: 95.6, wait: 0.6, then: (ww) => (ww.carry = true) },
          { x: 39.0, y: dy, wait: 0.5, face: [-1, 0], then: (ww) => (ww.carry = false) },
          { x: hx, y: hy },
        ]);
      } else if (Math.hypot(w.x - hx, w.y - hy) > 0.05) {
        w.carry = false;
        w.go([{ x: hx, y: hy, face: [-0.3, -1] }]);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Truck yard at the factory docks. A semi turns in off the avenue, waits at the gate until the yard is clear,
// drives down the yard lane past its dock, backs in, loads, then pulls straight out and turns onto the avenue.

export interface Dock {
  y: number;
  /** a truck is backed in and being loaded */
  loading: boolean;
  /** a truck is on its way to, at, or leaving this dock */
  taken: boolean;
}

export class TruckYard implements Activity {
  /** yard lane x, and where a waiting truck stops at the gate */
  static readonly LANE = 60;
  static readonly GATE = -3;
  readonly docks: Dock[];
  private mutex = new Mutex();
  private timer = 4;
  private trucks = 0;

  constructor(private env: Env, dockYs: number[]) {
    this.docks = dockYs.map((y) => ({ y, loading: false, taken: false }));
  }

  /** The tractor's pose when backed in, the pull-out curve, and where it ends on the lane. */
  private geometry(d: Dock) {
    const L = TruckYard.LANE, y = d.y;
    // pull out far enough down the lane for the trailer to straighten, but stop short of the pavement
    const stop = Math.min(y + 25, 35.5);
    return {
      stop,
      out: P([[44.6, y], [L, y], [L, stop]], [9]),
      back: P([[L, stop], [L, y], [44.6, y]], [9]),
    };
  }

  private afterDocked(d: Dock, dwell: number): Leg[] {
    const y = d.y;
    return [
      { path: P([[44.5, d.y], [44.6, d.y]]), vmax: 1, ghost: true, dwell, until: (v) => {
        if (!this.mutex.take(v)) return false;
        d.loading = false;
        return true;
      } },
      // pull straight out across the yard and turn right onto the avenue's near lane, never crossing traffic
      { path: P([[44.6, y], [64, y]]), vmax: 2.4, ghost: true },
      { path: P([[64, y], [70, y], [70, y + 14]], [6]), vmax: 4, done: (v) => {
        this.mutex.free(v);
        d.taken = false;
      } },
      { path: P([[70, y + 14], [70, 112]]), vmax: 5.5, done: () => this.trucks-- },
    ];
  }

  private spawn(d: Dock) {
    const { traffic, pal, rng } = this.env;
    const L = TruckYard.LANE;
    const { stop, out, back } = this.geometry(d);
    d.taken = true;
    this.trucks++;
    const legs: Leg[] = [
      // off the avenue and through the gate, then wait for the yard
      { path: P([[70, -18], [70, -8], [L, -8], [L, TruckYard.GATE]], [3, 5]), vmax: 5, until: (v) => this.mutex.take(v) },
      { path: P([[L, TruckYard.GATE], [L, stop]]), vmax: 3.5 },
      // back in along the pull-out curve, the trailer leading
      {
        path: back,
        rev: true,
        vmax: 1.3,
        ghost: true,
        trailerAngle: backingTrack(out, Math.PI / 2),
        done: (v) => {
          this.mutex.free(v);
          d.loading = true;
        },
      },
      ...this.afterDocked(d, rr(rng, 14, 24)),
    ];
    const v = traffic.add('semi', rng() < 0.8 ? pal.white : pal.paints[2], legs);
    v.mats[5] = pal.white;
  }

  /** A truck already backed in and loading, for the opening frame. */
  seed(i: number, dwell: number) {
    const { traffic, pal } = this.env;
    const d = this.docks[i];
    d.taken = true;
    d.loading = true;
    this.trucks++;
    const v = traffic.add('semi', pal.white, this.afterDocked(d, dwell));
    v.mats[5] = pal.white;
  }

  update(dt: number) {
    // one truck in the yard at a time, with a pause after it leaves
    if (this.trucks > 0) {
      this.timer = Math.max(this.timer, rr(this.env.rng, 10, 20));
      return;
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    const free = this.docks.filter((d) => !d.taken);
    if (free.length && this.env.traffic.clear(70, -18, 18)) this.spawn(pick(this.env.rng, free));
    else this.timer = 2;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Charging lot: three live stalls (cars pull in nose first, charge, back out and leave) and three parked cars.

export class ChargingLot implements Activity {
  readonly stalls = [56.2, 59.2, 62.2];
  private busy = [false, false, false];
  private cars: (Vehicle | null)[] = [null, null, null];
  private lot = new Mutex();
  /** the car driving in and queueing for the lot, if any */
  private incoming: Vehicle | null = null;
  private timer = 1;
  private parked: { x: number; paint: Mat }[] = [];

  constructor(private env: Env) {
    const { pal, rng, statics } = env;
    // the south row stays parked and charging
    for (const x of this.stalls) this.parked.push({ x, paint: pick(rng, pal.paints) });
    for (const p of this.parked) {
      const mats = [p.paint, pal.carGlass, pal.tyre, pal.headlight, pal.taillight];
      statics.push(
        new FnItem(p.x - 1.0, 67.6, 0, p.x + 1.0, 72.4, 1.45, (r) => drawMesh(r, MESH.car, p.x, 70.0, 0, 0, -1, mats), (ctx) =>
          rectShadow(ctx, p.x, 70, 0, -1, 2.3, 0.95, 1.1),
        ).still(),
      );
    }
    // charger posts between the two rows
    this.stalls.forEach((x, i) => {
      const px = x + 1.5, py = 67;
      statics.push(
        new FnItem(px - 0.2, py - 0.15, 0, px + 0.2, py + 0.15, 1.9, (r) => {
          box(r, px - 0.18, py - 0.13, 0, px + 0.18, py + 0.13, 1.75, pal.white, { edge: 'rgba(255,255,255,0.6)' });
          box(r, px - 0.19, py - 0.14, 1.75, px + 0.19, py + 0.14, 1.9, pal.dark);
          const ctx = r.ctx;
          const on = this.cars[i]?.charging;
          const pulse = 0.5 + 0.5 * Math.sin(r.t * 2.4 + i);
          // status light
          ctx.fillStyle = on ? pal.led : pal.night ? '#2a2c33' : '#c9cad2';
          ctx.globalAlpha = on ? 0.55 + 0.45 * pulse : 1;
          const X = (px + 0.18 - (py + 0.05)) * C, Y = (px + 0.18 + py + 0.05) * 0.5 - 1.45;
          ctx.fillRect(X - 0.05, Y - 0.18, 0.1, 0.32);
          ctx.globalAlpha = 1;
          // cables
          ctx.strokeStyle = pal.night ? '#0c0c0e' : '#3b3d44';
          ctx.lineWidth = 0.07;
          ctx.lineCap = 'round';
          ctx.beginPath();
          // to the parked car behind
          const sx = (px - (py + 0.6)) * C, syy = (px + py + 0.6) * 0.5 - 0.8;
          ctx.moveTo(X, Y + 0.2);
          ctx.quadraticCurveTo((X + sx) / 2, Y + 0.6, sx, syy);
          if (on) {
            const ex = (x + 0.75 - (py - 0.9)) * C, ey = (x + 0.75 + py - 0.9) * 0.5 - 0.75;
            ctx.moveTo(X, Y + 0.2);
            ctx.quadraticCurveTo((X + ex) / 2, Y + 0.7, ex, ey);
          }
          ctx.stroke();
        }),
      );
    });
  }

  /** Back straight out of stall i, swing round to face the exit, cross the lot and join the factory road. */
  private leave(i: number, sx: number): Leg[] {
    return [
      { path: P([[sx, 64.2], [sx, 60.3], [sx + 1.8, 60.3]], [1.8]), rev: true, vmax: 1.5, ghost: true },
      { path: P([[sx + 1.8, 60.3], [54.6, 60.3]]), vmax: 2.6 },
      // the lot stays ours until we are out on the road, so the next car can't drive into us while we wait to merge
      { path: P([[54.6, 60.3], [50.5, 60.3]]), vmax: 3, done: (vv) => {
        this.lot.free(vv);
        this.busy[i] = false;
        this.cars[i] = null;
      } },
      { path: P([[50.5, 60.3], [46, 60.3], [46, 135]], [3]), vmax: 7 },
    ];
  }

  private charge(dwell: number) {
    return {
      arrive: (vv: Vehicle) => {
        this.lot.free(vv);
        vv.charging = true;
      },
      dwell,
      until: (vv: Vehicle) => {
        vv.charging = false;
        return this.lot.take(vv);
      },
    };
  }

  private spawn(i: number) {
    const { traffic, pal, rng } = this.env;
    const sx = this.stalls[i];
    this.busy[i] = true;
    const kind = rng() < 0.6 ? 'car' : 'suv';
    const v = traffic.add(kind, pick(rng, pal.paints), [
      // wait for the lot inside its entrance, well clear of the street and of trucks swinging round the bend
      { path: P([[50, 135], [50, 48], [60.4, 48], [60.4, 55.6]], [6, 2.5]), vmax: 7, until: (vv) => this.lot.take(vv), done: () => (this.incoming = null) },
      { path: P([[60.4, 55.6], [60.4, 57.5], [sx, 61.5], [sx, 64.2]], [2, 2]), vmax: 2.4, ghost: true, ...this.charge(rr(rng, 14, 30)) },
      ...this.leave(i, sx),
    ], 'lot');
    this.cars[i] = v;
    this.incoming = v;
  }

  /** Put a car straight into a stall (for the opening frame). */
  seed(i: number) {
    const { traffic, pal, rng } = this.env;
    const sx = this.stalls[i];
    this.busy[i] = true;
    const v = traffic.add(rng() < 0.6 ? 'car' : 'suv', pick(rng, pal.paints), [
      { path: P([[sx, 64.1], [sx, 64.2]]), vmax: 1, ghost: true, ...this.charge(rr(rng, 4, 20)), arrive: (vv: Vehicle) => (vv.charging = true) },
      ...this.leave(i, sx),
    ], 'lot');
    this.cars[i] = v;
  }

  update(dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = rr(this.env.rng, 5, 11);
    // one car on its way in at a time, so nobody queues out into the street
    if (this.incoming && this.incoming.dead) this.incoming = null;
    const free = this.busy.map((b, i) => (b ? -1 : i)).filter((i) => i >= 0);
    if (!this.incoming && free.length && this.env.traffic.clear(50, 135, 8)) this.spawn(pick(this.env.rng, free));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Robotaxi stop: two-seat pods and the occasional van pull into the bay, open up, swap passengers and go.

export class TaxiStop implements Activity {
  private timer = 2;
  private waiting: Walker[] = [];
  private current: Vehicle | null = null;
  private phase: 'none' | 'open' | 'board' | 'close' = 'none';
  private boardT = 0;
  private spots = [[82.9, 61.2], [83.1, 63.0], [82.7, 64.6]];

  constructor(private env: Env, private joinGraph: (w: Walker) => void) {
    for (let i = 0; i < 2; i++) this.addWaiting(true);
  }

  private addWaiting(instant: boolean) {
    const { pal, rng, crowd } = this.env;
    const used = new Set(this.waiting.map((w) => (w as Walker & { spot?: number }).spot));
    const spot = [0, 1, 2].find((i) => !used.has(i));
    if (spot === undefined) return;
    const [x, y] = this.spots[spot];
    const w = new Walker('person', pal, rng, instant ? x : 80.5, instant ? y : 74);
    (w as Walker & { spot?: number }).spot = spot;
    if (instant) w.face(-1, 0.2);
    else w.go([{ x: 80.6, y: 68 }, { x, y, face: [-1, 0.2] }]);
    crowd.add(w);
    this.waiting.push(w);
  }

  private clearToLeave(me: Vehicle) {
    for (const o of this.env.traffic.vehicles) {
      if (o === me || o.dead) continue;
      // queued in the lane beside us, or coming up from behind
      for (const b of o.bodies) if (b.x > 71.5 && b.x < 76.5 && b.y > 50 && b.y < me.y + 28) return false;
    }
    return true;
  }

  update(dt: number) {
    const { traffic, pal, rng } = this.env;
    const v = this.current;
    if (!v) {
      this.timer -= dt;
      if (this.timer <= 0 && traffic.clear(74, 112, 10)) {
        this.timer = rr(rng, 12, 20);
        const van = rng() < 0.3;
        this.current = traffic.add(van ? 'van' : 'pod', pal.gold, [
          {
            path: P([[74, 112], [74, 78], [77.5, 72.5], [77.5, van ? 64.5 : 63.4]], [4, 4]),
            vmax: 6.5,
            arrive: (vv) => {
              vv.doorTarget = 1;
              this.phase = 'open';
            },
            until: () => this.phase === 'none',
          },
          { path: P([[77.5, van ? 64.5 : 63.4], [77.5, 60], [74, 55.5], [74, -18]], [4, 4]), vmax: 6.5 },
        ]);
      }
      if (this.waiting.length < 2 && rng() < dt * 0.15) this.addWaiting(false);
      return;
    }
    if (v.dead || (v.li > 0 && this.phase === 'none')) {
      this.current = null;
      return;
    }
    const door = v.kind === 'van' ? [v.x + 1.6, v.y + 0.3] : [v.x + 1.25, v.y + 0.1];
    switch (this.phase) {
      case 'open':
        if (v.door >= 1) {
          this.phase = 'board';
          this.boardT = 0;
          // someone gets out
          const out = v.kind === 'van' ? 1 + Math.floor(rng() * 2) : rng() < 0.5 ? 1 : 0;
          for (let i = 0; i < out; i++) {
            const w = new Walker('person', pal, rng, door[0], door[1] + i * 0.5);
            w.waitT = i * 0.8;
            w.go([{ x: 80.6, y: 61 + i }, { x: 80.6, y: 70 + i * 0.5 }]);
            w.onIdle = (ww) => this.joinGraph(ww);
            this.env.crowd.add(w);
          }
          // the waiting passengers walk over
          const n = v.kind === 'van' ? this.waiting.length : Math.min(1, this.waiting.length);
          for (let i = 0; i < n; i++) {
            const w = this.waiting.shift()!;
            w.waitT = 0.6 + i * 0.7;
            w.go([{ x: door[0] + 0.2, y: door[1] - 0.3, then: (ww) => (ww.dead = true) }]);
          }
        }
        break;
      case 'board': {
        this.boardT += dt;
        const boarding = this.env.crowd.walkers.some((w) => !w.dead && w.steps.length && Math.hypot(w.x - door[0], w.y - door[1]) < 4.5 && w.steps[0].x === door[0] + 0.2);
        if (this.boardT > 3.2 && !boarding) {
          v.doorTarget = 0;
          this.phase = 'close';
        }
        break;
      }
      case 'close':
        // pull out only when nobody is queued in the lane alongside
        if (v.door <= 0 && this.clearToLeave(v)) this.phase = 'none';
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tower crane on the construction site: swings between the material pile and the slab, hook up and down.

export class Crane implements Activity {
  readonly mx = 64.9;
  readonly my = 85.9;
  readonly h = 12.5;
  ang = 0;
  trolley = 8;
  hook = 10;
  loaded = false;
  private t = 0;
  private dropped: { x: number; y: number; t: number }[] = [];
  private readonly pick = [56.6, 85.5, 0.9];
  private readonly drop = [59.75, 93.4, 3.75];
  private parts: Item[] = [];

  constructor(private env: Env) {
    const pal = env.pal;
    const self = this;
    // mast and cab
    env.statics.push(
      new FnItem(this.mx - 0.45, this.my - 0.45, 0, this.mx + 0.45, this.my + 0.45, this.h, (r) => this.drawMast(r), (ctx) =>
        boxShadow(ctx, this.mx - 0.36, this.my - 0.36, this.mx + 0.36, this.my + 0.36, this.h),
      ).still(),
    );
    // jib: always above everything else
    this.parts.push({
      x0: this.mx - 12, x1: this.mx + 12, y0: this.my - 12, y1: this.my + 12, z0: this.h, z1: this.h + 1.6,
      draw: (r: R) => self.drawJib(r),
    } as Item);
    // hook, cable and load
    const hookItem = {
      x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0,
      draw: (r: R) => self.drawHook(r),
    } as Item;
    this.parts.push(hookItem);
    this.hookItem = hookItem;
    // material pile
    env.statics.push(
      new FnItem(55.3, 84.4, 0, 57.9, 86.6, 0.8, (r) => {
        for (let i = 0; i < 4; i++) box(r, 55.4, 84.5 + i * 0.5, i % 2 ? 0.4 : 0, 57.8, 84.9 + i * 0.5, i % 2 ? 0.8 : 0.4, pal.steel);
      }).still(),
    );
  }
  private hookItem: Item;

  private target(): { ang: number; d: number; hook: number; loaded: boolean } {
    // a 24 s loop
    const T = 24;
    const u = this.t % T;
    const pa = Math.atan2(this.pick[1] - this.my, this.pick[0] - this.mx);
    const pd = Math.hypot(this.pick[1] - this.my, this.pick[0] - this.mx);
    const da = Math.atan2(this.drop[1] - this.my, this.drop[0] - this.mx);
    const dd = Math.hypot(this.drop[1] - this.my, this.drop[0] - this.mx);
    const hi = 9.5;
    const seg = (a: number, b: number) => smooth((u - a) / (b - a));
    if (u < 3) return { ang: pa, d: pd, hook: lerp(hi, this.pick[2] + 1.2, seg(0, 3)), loaded: false };
    if (u < 4) return { ang: pa, d: pd, hook: this.pick[2] + 1.2, loaded: u > 3.6 };
    if (u < 7) return { ang: pa, d: pd, hook: lerp(this.pick[2] + 1.2, hi, seg(4, 7)), loaded: true };
    if (u < 13) {
      const k = seg(7, 13);
      return { ang: lerp(pa, da, k), d: lerp(pd, dd, k), hook: hi, loaded: true };
    }
    if (u < 15.5) return { ang: da, d: dd, hook: lerp(hi, this.drop[2] + 1.2, seg(13, 15.5)), loaded: true };
    if (u < 16.5) return { ang: da, d: dd, hook: this.drop[2] + 1.2, loaded: u < 16 };
    if (u < 18.5) return { ang: da, d: dd, hook: lerp(this.drop[2] + 1.2, hi, seg(16.5, 18.5)), loaded: false };
    const k = seg(18.5, 24);
    return { ang: lerp(da, pa, k), d: lerp(dd, pd, k), hook: hi, loaded: false };
  }

  update(dt: number) {
    this.t += dt;
    const tg = this.target();
    if (this.loaded && !tg.loaded && this.t % 24 > 15) this.dropped.push({ x: this.drop[0], y: this.drop[1], t: 7 });
    this.ang = tg.ang;
    this.trolley = tg.d;
    this.hook = tg.hook;
    this.loaded = tg.loaded;
    for (const d of this.dropped) d.t -= dt;
    this.dropped = this.dropped.filter((d) => d.t > 0);
    const hx = this.mx + Math.cos(this.ang) * this.trolley, hy = this.my + Math.sin(this.ang) * this.trolley;
    const it = this.hookItem;
    it.x0 = hx - 1.3;
    it.x1 = hx + 1.3;
    it.y0 = hy - 0.5;
    it.y1 = hy + 0.5;
    it.z0 = this.hook - 1.2;
    it.z1 = this.h - 0.2;
  }

  items(out: Item[]) {
    for (const it of this.parts) out.push(it);
    for (const d of this.dropped) {
      const a = clamp(d.t, 0, 1);
      out.push({
        x0: d.x - 1.3, x1: d.x + 1.3, y0: d.y - 0.3, y1: d.y + 0.3, z0: this.drop[2], z1: this.drop[2] + 0.5,
        draw: (r: R) => {
          r.ctx.globalAlpha = a;
          this.drawLoad(r, d.x, d.y, this.drop[2], 0);
          r.ctx.globalAlpha = 1;
        },
      } as Item);
    }
  }

  private drawLoad(r: R, x: number, y: number, z: number, ang: number) {
    // a bundle of beams
    const pal = this.env.pal;
    const c = Math.cos(ang), s = Math.sin(ang);
    const l = Math.abs(c) > Math.abs(s);
    for (let i = 0; i < 2; i++) {
      const zz = z + i * 0.24;
      if (l) box(r, x - 1.25, y - 0.3, zz, x + 1.25, y + 0.3, zz + 0.24, pal.steel);
      else box(r, x - 0.3, y - 1.25, zz, x + 0.3, y + 1.25, zz + 0.24, pal.steel);
    }
  }

  private drawMast(r: R) {
    const pal = this.env.pal;
    const { mx, my, h } = this;
    const ctx = r.ctx;
    box(r, mx - 0.36, my - 0.36, 0, mx + 0.36, my + 0.36, h, pal.factory);
    // lattice
    ctx.beginPath();
    for (let z = 0; z < h - 0.9; z += 0.9) {
      lineW(ctx, mx + 0.36, my + 0.36, z, mx + 0.36, my - 0.36, z + 0.9);
      lineW(ctx, mx - 0.36, my + 0.36, z, mx + 0.36, my + 0.36, z + 0.9);
    }
    ctx.strokeStyle = pal.night ? 'rgba(0,0,0,0.35)' : 'rgba(120,122,134,0.45)';
    ctx.lineWidth = 0.05;
    ctx.stroke();
    // cab
    box(r, mx - 0.5, my - 0.5, h - 1.2, mx + 0.6, my + 0.6, h, pal.white, { edge: 'rgba(255,255,255,0.6)' });
  }

  private drawJib(r: R) {
    const pal = this.env.pal;
    const { mx, my, h } = this;
    const ctx = r.ctx;
    const c = Math.cos(this.ang), s = Math.sin(this.ang);
    const P2 = (d: number, w: number, z: number) => {
      const x = mx + c * d - s * w, y = my + s * d + c * w;
      return [(x - y) * C, (x + y) * 0.5 - z];
    };
    // counter weight
    const cw = [P2(-4.0, 0.45, h + 0.2), P2(-2.7, 0.45, h + 0.2), P2(-2.7, -0.45, h + 0.2), P2(-4.0, -0.45, h + 0.2)];
    // jib as two chords and lacing
    ctx.lineCap = 'round';
    ctx.strokeStyle = pal.factoryDark.left;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    for (const w of [0.3, -0.3]) {
      const a = P2(-4.0, w, h + 0.1), b = P2(11.5, w, h + 0.1);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    const top0 = P2(-4.0, 0, h + 0.75), top1 = P2(11.5, 0, h + 0.75);
    ctx.moveTo(top0[0], top0[1]);
    ctx.lineTo(top1[0], top1[1]);
    ctx.stroke();
    ctx.lineWidth = 0.05;
    ctx.strokeStyle = pal.factoryDark.right;
    ctx.beginPath();
    for (let d = -4.0; d < 11.4; d += 1.1) {
      const a = P2(d, 0.3, h + 0.1), b = P2(d + 0.55, 0, h + 0.75), e = P2(d + 1.1, -0.3, h + 0.1);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(e[0], e[1]);
    }
    ctx.stroke();
    // apex and ties
    const apex = P2(0, 0, h + 2.6);
    ctx.lineWidth = 0.06;
    ctx.strokeStyle = pal.factoryDark.left;
    ctx.beginPath();
    const m0 = P2(0, 0, h);
    ctx.moveTo(m0[0], m0[1]);
    ctx.lineTo(apex[0], apex[1]);
    ctx.lineTo(top1[0], top1[1]);
    ctx.moveTo(apex[0], apex[1]);
    ctx.lineTo(top0[0], top0[1]);
    ctx.stroke();
    ctx.fillStyle = pal.concrete.right;
    ctx.beginPath();
    ctx.moveTo(cw[0][0], cw[0][1] - 0.7);
    ctx.lineTo(cw[1][0], cw[1][1] - 0.7);
    ctx.lineTo(cw[2][0], cw[2][1] - 0.7);
    ctx.lineTo(cw[3][0], cw[3][1] - 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pal.concrete.left;
    ctx.fillRect(Math.min(cw[0][0], cw[3][0]), Math.min(cw[0][1], cw[3][1]) - 0.7, Math.abs(cw[0][0] - cw[3][0]) + 0.01, 0.75);
    // trolley
    const tp = P2(this.trolley, 0, h + 0.05);
    ctx.fillStyle = pal.dark.left;
    ctx.fillRect(tp[0] - 0.3, tp[1] - 0.1, 0.6, 0.25);
    // red beacon at the tip at night
    if (r.night) {
      const tip = P2(11.5, 0, h + 0.8);
      ctx.fillStyle = Math.sin(r.t * 3) > 0 ? '#ff5a50' : '#5a1f1c';
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawHook(r: R) {
    const { mx, my, h } = this;
    const ctx = r.ctx;
    const x = mx + Math.cos(this.ang) * this.trolley, y = my + Math.sin(this.ang) * this.trolley;
    ctx.strokeStyle = this.env.pal.night ? '#0c0c0e' : '#5b5d66';
    ctx.lineWidth = 0.04;
    ctx.beginPath();
    lineW(ctx, x, y, h, x, y, this.hook);
    ctx.stroke();
    ctx.fillStyle = this.env.pal.dark.left;
    const X = (x - y) * C, Y = (x + y) * 0.5 - this.hook;
    ctx.fillRect(X - 0.12, Y, 0.24, 0.22);
    if (this.loaded) {
      ctx.beginPath();
      lineW(ctx, x, y, this.hook, x - 1.0, y, this.hook - 1.0);
      lineW(ctx, x, y, this.hook, x + 1.0, y, this.hook - 1.0);
      ctx.stroke();
      this.drawLoad(r, x, y, this.hook - 1.2, 0);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Loops: a walker that repeats a list of steps forever (dock workers, a battery-yard inspector, site workers).

export class Looper implements Activity {
  readonly w: Walker;
  constructor(env: Env, kind: 'person' | 'robot', private steps: () => Parameters<Walker['go']>[0], x: number, y: number, z = 0, accent = false) {
    this.w = new Walker(kind, env.pal, env.rng, x, y);
    this.w.z = z;
    if (accent) {
      (this.w as { body: string }).body = '#e2b04a';
      (this.w as { bodyShade: string }).bodyShade = '#c49436';
    }
    env.crowd.add(this.w);
  }
  update() {
    if (!this.w.steps.length && this.w.waitT <= 0) this.w.go(this.steps());
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Park: two kids passing a ball, a dog on a walk.

export class Park implements Activity {
  private kids: Walker[] = [];
  private t = 0;
  private ball = { x: 0, y: 0, z: 0 };
  private dogT = 0;
  private dog: { x: number; y: number; hx: number; hy: number; ph: number } | null = null;
  private owner: Walker | null = null;
  private parts: Item[] = [];

  constructor(private env: Env, spots: number[][]) {
    const { pal, rng, crowd } = env;
    for (const [x, y] of spots) {
      const w = new Walker('person', pal, rng, x, y);
      w.size = 0.68;
      crowd.add(w);
      this.kids.push(w);
    }
    const self = this;
    this.parts.push({
      x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0,
      draw(r: R) {
        const b = self.ball;
        const ctx = r.ctx;
        const X = (b.x - b.y) * C, Y = (b.x + b.y) * 0.5;
        ctx.fillStyle = pal.night ? 'rgba(0,0,0,0.3)' : 'rgba(84,86,104,0.16)';
        ctx.beginPath();
        ctx.ellipse(X + 0.1, Y, 0.2, 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.white.top;
        ctx.strokeStyle = pal.white.right;
        ctx.lineWidth = 0.04;
        ctx.beginPath();
        ctx.arc(X, Y - b.z - 0.16, 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      },
    } as Item);
    this.parts.push({
      x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0.7,
      draw(r: R) {
        const d = self.dog;
        if (!d) return;
        const ctx = r.ctx;
        const X = (d.x - d.y) * C, Y = (d.x + d.y) * 0.5;
        let dX = (d.hx - d.hy) * C, dY = (d.hx + d.hy) * 0.5;
        const l = Math.hypot(dX, dY) || 1;
        dX /= l;
        dY /= l;
        const sw = Math.sin(d.ph) * 0.12;
        ctx.strokeStyle = pal.night ? '#0e0f12' : '#4a4c55';
        ctx.lineCap = 'round';
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        for (const s of [1, -1]) {
          ctx.moveTo(X + dX * 0.22 * s, Y - 0.32 + dY * 0.22 * s * 0.5);
          ctx.lineTo(X + dX * (0.22 * s + sw * s), Y + dY * 0.2 * s * 0.5);
          ctx.moveTo(X + dX * 0.22 * s, Y - 0.32 + dY * 0.22 * s * 0.5);
          ctx.lineTo(X + dX * (0.22 * s - sw * s), Y + dY * 0.2 * s * 0.5);
        }
        ctx.stroke();
        ctx.lineWidth = 0.24;
        ctx.beginPath();
        ctx.moveTo(X - dX * 0.25, Y - 0.38 - dY * 0.12);
        ctx.lineTo(X + dX * 0.25, Y - 0.38 + dY * 0.12);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X + dX * 0.36, Y - 0.5 + dY * 0.18, 0.13, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
        // tail
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(X - dX * 0.3, Y - 0.42 - dY * 0.15);
        ctx.lineTo(X - dX * 0.42, Y - 0.62 + Math.sin(r.t * 9) * 0.05);
        ctx.stroke();
      },
    } as Item);
  }

  update(dt: number) {
    this.t += dt;
    // ball goes back and forth between the kids every 1.8 s
    const T = 1.8;
    const u = this.t / T;
    const i = Math.floor(u) % 2;
    const f = u - Math.floor(u);
    const a = this.kids[i], b = this.kids[1 - i];
    if (a && b) {
      this.ball.x = lerp(a.x + a.hx * 0.3, b.x + b.hx * 0.3, f);
      this.ball.y = lerp(a.y + a.hy * 0.3, b.y + b.hy * 0.3, f);
      this.ball.z = Math.sin(f * Math.PI) * 1.4;
      a.face(b.x - a.x, b.y - a.y);
      b.face(a.x - b.x, a.y - b.y);
      // a little hop when kicking
      a.z = f < 0.12 ? Math.sin((f / 0.12) * Math.PI) * 0.08 : 0;
      const it = this.parts[0];
      it.x0 = this.ball.x - 0.2;
      it.x1 = this.ball.x + 0.2;
      it.y0 = this.ball.y - 0.2;
      it.y1 = this.ball.y + 0.2;
      it.z0 = this.ball.z;
      it.z1 = this.ball.z + 0.32;
    }
    // dog walker
    if (!this.owner || this.owner.dead) {
      this.dog = null;
      this.dogT -= dt;
      if (this.dogT <= 0) {
        this.dogT = 6;
        const w = this.env.crowd.wanderer('person');
        this.owner = w;
        this.dog = { x: w.x - 1, y: w.y, hx: 1, hy: 0, ph: 0 };
      }
    }
    const d = this.dog, o = this.owner;
    if (d && o) {
      const tx = o.x - o.hx * 1.3 + 0.5 * -o.hy, ty = o.y - o.hy * 1.3 + 0.5 * o.hx;
      const dx = tx - d.x, dy = ty - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.05) {
        const sp = Math.min(dist, dt * Math.max(0.5, dist * 2.2));
        d.x += (dx / dist) * sp;
        d.y += (dy / dist) * sp;
        if (dist > 0.15) {
          d.hx += (dx / dist - d.hx) * Math.min(1, dt * 6);
          d.hy += (dy / dist - d.hy) * Math.min(1, dt * 6);
          const n = Math.hypot(d.hx, d.hy) || 1;
          d.hx /= n;
          d.hy /= n;
          d.ph += sp * 9;
        }
      }
      const it = this.parts[1];
      it.x0 = d.x - 0.4;
      it.x1 = d.x + 0.4;
      it.y0 = d.y - 0.4;
      it.y1 = d.y + 0.4;
    }
  }

  items(out: Item[]) {
    out.push(this.parts[0]);
    if (this.dog) out.push(this.parts[1]);
  }

  shadows(ctx: Ctx) {
    if (this.dog) blobShadow(ctx, this.dog.x, this.dog.y, 0.3, 0.6);
  }
}
