// People and humanoid robots: drawn as tiny clay figures with a walk cycle, steered along a walkway graph.

import { C, css, mix, pick, rr, type RGB, type Rng } from './core';
import { blobShadow, box, type Ctx, type R } from './draw';
import type { Palette } from './palette';
import type { Item } from './sort';
import type { Zone } from './vehicles';

export type WalkerKind = 'person' | 'robot';

export interface Step {
  x: number;
  y: number;
  z?: number;
  /** Reserve this zone (a crosswalk) for the stretch leading to this step. */
  zone?: Zone;
  /** Seconds to stand still after arriving. */
  wait?: number;
  /** Face this direction after arriving. */
  face?: [number, number];
  /** Called on arrival. */
  then?: (w: Walker) => void;
  speed?: number;
}

export type Stance = 'stand' | 'sit' | 'work' | 'chat';

let WID = 1;

export class Walker implements Item {
  readonly id = WID++;
  x0 = 0;
  x1 = 0;
  y0 = 0;
  y1 = 0;
  z0 = 0;
  z1 = 0;
  x: number;
  y: number;
  z = 0;
  hx = 1;
  hy = 0;
  speed: number;
  phase: number;
  moving = false;
  steps: Step[] = [];
  waitT = 0;
  holding?: Zone;
  carry = false;
  stance: Stance = 'stand';
  size = 1;
  dead = false;
  hidden = false;
  /** walkway-graph state for wanderers */
  node = -1;
  prev = -1;
  hops = 0;
  ox = 0;
  oy = 0;
  onIdle?: (w: Walker) => void;
  readonly body: string;
  readonly bodyShade: string;
  readonly legs: string;
  readonly head: string;
  readonly arm: string;
  private readonly seed: number;

  constructor(readonly kind: WalkerKind, readonly pal: Palette, rng: Rng, x: number, y: number) {
    this.x = x;
    this.y = y;
    this.seed = rng() * 1000;
    this.phase = rng() * 6.28;
    const a = rng() * Math.PI * 2;
    this.hx = Math.cos(a);
    this.hy = Math.sin(a);
    if (kind === 'robot') {
      this.speed = rr(rng, 1.0, 1.25);
      this.body = pal.robot;
      this.bodyShade = pal.robotHead;
      this.legs = pal.robot;
      this.head = pal.robotHead;
      this.arm = pal.robot;
    } else {
      this.speed = rr(rng, 1.05, 1.5);
      let top: RGB = pick(rng, pal.people);
      if (rng() < 0.16) top = pick(rng, pal.accents);
      const bottom: RGB = rng() < 0.5 ? mix(pick(rng, pal.people), [60, 62, 70], pal.night ? 0.1 : 0.35) : pick(rng, pal.people);
      this.body = css(top);
      this.bodyShade = css(mix(top, [40, 42, 56], 0.18));
      this.legs = css(bottom);
      this.head = css(mix(pick(rng, pal.people), [255, 255, 255], pal.night ? 0.05 : 0.4));
      this.arm = css(mix(top, [40, 42, 56], 0.08));
    }
  }

  go(steps: Step[]) {
    this.steps = steps;
    return this;
  }

  face(x: number, y: number) {
    const d = Math.hypot(x, y) || 1;
    this.hx = x / d;
    this.hy = y / d;
  }

  update(dt: number) {
    if (this.dead) return;
    if (this.waitT > 0) {
      this.waitT -= dt;
      this.moving = false;
      return;
    }
    const st = this.steps[0];
    if (!st) {
      this.moving = false;
      this.onIdle?.(this);
      return;
    }
    if (st.zone && this.holding !== st.zone) {
      if (!st.zone.tryEnter(this, 'ped')) {
        this.moving = false;
        return;
      }
      this.holding = st.zone;
    }
    const dx = st.x - this.x, dy = st.y - this.y;
    const d = Math.hypot(dx, dy);
    const sp = (st.speed ?? 1) * this.speed;
    const step = sp * dt;
    if (d <= step || d < 1e-4) {
      this.x = st.x;
      this.y = st.y;
      if (st.z !== undefined) this.z = st.z;
      this.steps.shift();
      if (this.holding && st.zone === this.holding) {
        this.holding.leave(this);
        this.holding = undefined;
      }
      if (st.wait) this.waitT = st.wait;
      if (st.face) this.face(st.face[0], st.face[1]);
      st.then?.(this);
      this.moving = this.steps.length > 0 && !st.wait;
      this.phase += d * 2.6;
    } else {
      this.x += (dx / d) * step;
      this.y += (dy / d) * step;
      if (st.z !== undefined) this.z += ((st.z - this.z) * step) / d;
      // ease the facing towards the direction of travel
      const k = Math.min(1, dt * 9);
      const nx = this.hx + (dx / d - this.hx) * k, ny = this.hy + (dy / d - this.hy) * k;
      const n = Math.hypot(nx, ny) || 1;
      this.hx = nx / n;
      this.hy = ny / n;
      this.moving = true;
      this.phase += step * (this.kind === 'robot' ? 2.3 : 2.6) / this.size;
    }
  }

  bounds() {
    const r = 0.32;
    this.x0 = this.x - r;
    this.x1 = this.x + r;
    this.y0 = this.y - r;
    this.y1 = this.y + r;
    this.z0 = this.z;
    this.z1 = this.z + 1.85 * this.size + (this.carry ? 0.2 : 0);
  }

  shadow(ctx: Ctx) {
    if (this.hidden || this.z > 0.05) return;
    blobShadow(ctx, this.x, this.y, 0.26 * this.size, (this.stance === 'sit' ? 1.2 : 1.75) * this.size);
  }

  draw(r: R) {
    if (this.hidden) return;
    const ctx = r.ctx;
    const k = this.size;
    const X = (this.x - this.y) * C, Y = (this.x + this.y) * 0.5 - this.z;
    let dX = (this.hx - this.hy) * C, dY = (this.hx + this.hy) * 0.5;
    const dl = Math.hypot(dX, dY) || 1;
    dX /= dl;
    dY /= dl;
    const robot = this.kind === 'robot';
    const t = r.t + this.seed;
    const sw = this.moving ? Math.sin(this.phase) : 0;
    const bob = this.moving ? Math.abs(Math.cos(this.phase)) * 0.035 * k : 0;
    const sway = this.stance === 'chat' ? Math.sin(t * 0.9) * 0.025 : 0;
    const sit = this.stance === 'sit';
    const hip = sit ? 0.5 * k : 0.9 * k;
    const hipY = Y - hip - bob;
    const pX = -dY * 0.07 * k, pY = dX * 0.035 * k; // a little apart, sideways
    const stride = (robot ? 0.27 : 0.3) * k;
    const carryFront = this.hx + this.hy > 0;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // legs
    ctx.strokeStyle = this.legs;
    ctx.lineWidth = (robot ? 0.17 : 0.15) * k;
    ctx.beginPath();
    if (sit) {
      for (const s of [1, -1]) {
        const kx = X + s * pX + dX * 0.42 * k, ky = hipY + s * pY + dY * 0.42 * k * 0.5;
        ctx.moveTo(X + s * pX, hipY + s * pY);
        ctx.lineTo(kx, ky);
        ctx.lineTo(kx + dX * 0.05 * k, ky + 0.45 * k);
      }
    } else {
      for (const s of [1, -1]) {
        const a = sw * stride * s;
        ctx.moveTo(X + s * pX + sway, hipY + s * pY);
        ctx.lineTo(X + s * pX + dX * a, Y + s * pY + dY * a * 0.6);
      }
    }
    ctx.stroke();

    const shY = Y - (sit ? 0.9 : 1.38) * k - bob;
    const tX = X + sway * 2;
    // the box sits in front of the chest; behind the body when walking away from the camera
    if (this.carry && !carryFront) this.drawCarry(r);
    // arms
    ctx.strokeStyle = this.arm;
    ctx.lineWidth = (robot ? 0.12 : 0.11) * k;
    ctx.beginPath();
    const work = this.stance === 'work';
    for (const s of [1, -1]) {
      const sx0 = tX + s * 0.2 * k * Math.abs(dY) + s * 0.08 * k, sy0 = shY + 0.04 * k;
      let hx: number, hy: number;
      if (this.carry) {
        hx = tX + dX * 0.28 * k + s * 0.12 * k;
        hy = shY + 0.32 * k + dY * 0.1 * k;
      } else if (work) {
        const reach = 0.38 + 0.12 * Math.sin(t * 2.2 + s * 1.7);
        hx = sx0 + dX * reach * k;
        hy = sy0 + 0.22 * k + dY * reach * k * 0.6 - 0.06 * Math.max(0, Math.sin(t * 2.2 + s)) * k;
      } else if (this.stance === 'chat') {
        const g = Math.max(0, Math.sin(t * 0.7 + s * 2)) * 0.25;
        hx = sx0 + dX * g * k;
        hy = sy0 + (0.5 - g) * k;
      } else {
        const a = -sw * 0.2 * k * s;
        hx = sx0 + dX * a;
        hy = sy0 + 0.52 * k + dY * a * 0.5;
      }
      ctx.moveTo(sx0, sy0);
      ctx.lineTo(hx, hy);
    }
    ctx.stroke();

    // torso
    if (robot) {
      const w0 = 0.25 * k, w1 = 0.17 * k;
      const top = shY - 0.04 * k, bot = Y - hip - bob + 0.02 * k;
      ctx.fillStyle = this.body;
      ctx.beginPath();
      ctx.moveTo(tX - w0, top);
      ctx.lineTo(tX + w0, top);
      ctx.lineTo(tX + w1, bot);
      ctx.lineTo(tX - w1, bot);
      ctx.closePath();
      ctx.fill();
      // chest plate highlight
      ctx.strokeStyle = this.pal.robotHi;
      ctx.lineWidth = 0.05 * k;
      ctx.beginPath();
      ctx.moveTo(tX - w0 * 0.6, top + 0.08 * k);
      ctx.lineTo(tX + w0 * 0.2, top + 0.08 * k);
      ctx.stroke();
      // head
      const hy = shY - 0.28 * k;
      ctx.fillStyle = this.head;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tX - 0.12 * k, hy - 0.14 * k, 0.24 * k, 0.28 * k, 0.09 * k);
      else ctx.rect(tX - 0.12 * k, hy - 0.14 * k, 0.24 * k, 0.28 * k);
      ctx.fill();
      ctx.strokeStyle = this.pal.robotHi;
      ctx.lineWidth = 0.035 * k;
      ctx.beginPath();
      ctx.arc(tX - 0.02 * k, hy - 0.02 * k, 0.07 * k, Math.PI * 1.05, Math.PI * 1.6);
      ctx.stroke();
    } else {
      ctx.strokeStyle = this.body;
      ctx.lineWidth = 0.4 * k;
      ctx.beginPath();
      ctx.moveTo(tX, Y - hip - bob - 0.13 * k);
      ctx.lineTo(tX, shY + 0.05 * k);
      ctx.stroke();
      ctx.strokeStyle = this.bodyShade;
      ctx.lineWidth = 0.12 * k;
      ctx.beginPath();
      ctx.moveTo(tX + 0.12 * k, Y - hip - bob - 0.1 * k);
      ctx.lineTo(tX + 0.12 * k, shY + 0.08 * k);
      ctx.stroke();
      ctx.fillStyle = this.head;
      ctx.beginPath();
      ctx.arc(tX, shY - 0.26 * k, 0.14 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.carry && carryFront) this.drawCarry(r);
  }

  private drawCarry(r: R) {
    const s = 0.24 * this.size;
    const cx = this.x + this.hx * 0.34, cy = this.y + this.hy * 0.34, cz = this.z + 0.95 * this.size;
    box(r, cx - s, cy - s, cz, cx + s, cy + s, cz + s * 1.5, this.pal.crate);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Walkway graph and the crowd that wanders it

interface GNode {
  x: number;
  y: number;
  adj: { to: number; zone?: Zone }[];
  portal: boolean;
}

export class WalkGraph {
  readonly nodes: GNode[] = [];
  node(x: number, y: number, portal = false) {
    this.nodes.push({ x, y, adj: [], portal });
    return this.nodes.length - 1;
  }
  link(a: number, b: number, zone?: Zone) {
    this.nodes[a].adj.push({ to: b, zone });
    this.nodes[b].adj.push({ to: a, zone });
  }
  chain(ids: number[], zone?: Zone) {
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i], zone);
  }
  /** Build a chain of new nodes through the given points; returns their ids. */
  line(pts: number[][], portalEnds = false) {
    const ids = pts.map((p, i) => this.node(p[0], p[1], portalEnds && (i === 0 || i === pts.length - 1)));
    this.chain(ids);
    return ids;
  }
  nearest(x: number, y: number) {
    let best = 0, bd = Infinity;
    this.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
}

export class Crowd {
  readonly walkers: Walker[] = [];
  private spawnT = 0;
  targetPeople = 0;
  targetRobots = 0;

  constructor(readonly graph: WalkGraph, readonly pal: Palette, readonly rng: Rng) {}

  add(w: Walker) {
    this.walkers.push(w);
    return w;
  }

  /** A walker that roams the graph, starting at node `n` (or a random spot mid-edge). */
  wanderer(kind: WalkerKind, n?: number) {
    const g = this.graph;
    const rng = this.rng;
    let start = n ?? Math.floor(rng() * g.nodes.length);
    const node = g.nodes[start];
    const w = new Walker(kind, this.pal, rng, node.x, node.y);
    const rad = Math.sqrt(rng()) * 0.75;
    const a = rng() * Math.PI * 2;
    w.ox = Math.cos(a) * rad;
    w.oy = Math.sin(a) * rad;
    w.x += w.ox;
    w.y += w.oy;
    w.node = start;
    w.hops = n === undefined ? Math.floor(rng() * 6) : 0;
    w.onIdle = (ww) => this.next(ww);
    if (n === undefined && node.adj.length) {
      // begin part-way along an edge so the opening frame isn't clumped on nodes
      const e = pick(rng, node.adj);
      const to = g.nodes[e.to];
      const f = rng();
      w.x = node.x + (to.x - node.x) * f + w.ox;
      w.y = node.y + (to.y - node.y) * f + w.oy;
      w.prev = start;
      w.node = e.to;
      start = e.to;
      w.go([{ x: to.x + w.ox, y: to.y + w.oy, zone: e.zone }]);
    }
    return this.add(w);
  }

  /** Hand a scripted walker over to the graph once its script is done. */
  adopt(w: Walker) {
    w.node = this.graph.nearest(w.x, w.y);
    w.prev = -1;
    w.hops = 0;
    w.ox = 0;
    w.oy = 0;
    w.onIdle = (ww) => this.next(ww);
    const n = this.graph.nodes[w.node];
    w.go([{ x: n.x, y: n.y }]);
  }

  private next(w: Walker) {
    const g = this.graph;
    const rng = this.rng;
    const cur = g.nodes[w.node];
    if (cur.portal && w.hops >= 3 && rng() < 0.7) {
      w.dead = true;
      return;
    }
    let opts = cur.adj.filter((e) => e.to !== w.prev);
    if (!opts.length) opts = cur.adj;
    if (!opts.length) {
      w.waitT = 3;
      return;
    }
    // crossing the road is less tempting than staying on this side
    let e = pick(rng, opts);
    if (e.zone && opts.some((o) => !o.zone) && rng() < 0.55) e = pick(rng, opts.filter((o) => !o.zone));
    const to = g.nodes[e.to];
    w.prev = w.node;
    w.node = e.to;
    w.hops++;
    const step: Step = { x: to.x + w.ox, y: to.y + w.oy, zone: e.zone };
    if (rng() < 0.1 && !e.zone) {
      step.wait = rr(rng, 1.5, 5);
      const a = rng() * Math.PI * 2;
      step.face = [Math.cos(a), Math.sin(a)];
    }
    w.go([step]);
  }

  update(dt: number) {
    for (const w of this.walkers) w.update(dt);
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i];
      if (w.dead) {
        if (w.holding) w.holding.leave(w);
        this.walkers.splice(i, 1);
      }
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = rr(this.rng, 0.4, 1.4);
      let people = 0, robots = 0;
      for (const w of this.walkers) if (w.onIdle) w.kind === 'robot' ? robots++ : people++;
      const portals = this.graph.nodes.map((n, i) => (n.portal ? i : -1)).filter((i) => i >= 0);
      if (portals.length) {
        if (people < this.targetPeople) this.wanderer('person', pick(this.rng, portals));
        else if (robots < this.targetRobots) this.wanderer('robot', pick(this.rng, portals));
      }
    }
  }

  items(out: Item[]) {
    for (const w of this.walkers) {
      if (w.hidden) continue;
      w.bounds();
      out.push(w);
    }
  }

  shadows(ctx: Ctx) {
    for (const w of this.walkers) w.shadow(ctx);
  }
}
