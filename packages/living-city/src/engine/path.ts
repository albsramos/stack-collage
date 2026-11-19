// Ground paths made of straight lines joined by circular fillets, sampled by distance.

export interface Pose {
  x: number;
  y: number;
  hx: number;
  hy: number;
}

interface Line {
  k: 0;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  len: number;
}

interface Arc {
  k: 1;
  cx: number;
  cy: number;
  r: number;
  a0: number;
  da: number;
  len: number;
}

type Seg = Line | Arc;

export class Path {
  readonly segs: Seg[] = [];
  readonly cum: number[] = [];
  len = 0;

  private push(s: Seg) {
    if (s.len < 1e-6) return;
    this.segs.push(s);
    this.cum.push(this.len);
    this.len += s.len;
  }

  /**
   * A polyline through `pts` with each interior corner rounded. `radius` is one radius for every corner or one per
   * corner; a radius too large for the neighbouring legs is shrunk to fit.
   */
  static poly(pts: readonly (readonly number[])[], radius: number | readonly number[] = 0): Path {
    const p = new Path();
    let cx = pts[0][0], cy = pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [bx, by] = pts[i];
      if (i === pts.length - 1) {
        p.line(cx, cy, bx, by);
        break;
      }
      const [nx, ny] = pts[i + 1];
      let ix = bx - pts[i - 1][0], iy = by - pts[i - 1][1];
      let ox = nx - bx, oy = ny - by;
      const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
      ix /= li; iy /= li; ox /= lo; oy /= lo;
      const dot = Math.max(-1, Math.min(1, ix * ox + iy * oy));
      const th = Math.acos(dot);
      let r = typeof radius === 'number' ? radius : (radius[i - 1] ?? 0);
      if (th < 1e-3 || r <= 0) {
        p.line(cx, cy, bx, by);
        cx = bx;
        cy = by;
        continue;
      }
      const prevLen = Math.hypot(bx - cx, by - cy);
      let t = r * Math.tan(th / 2);
      const maxT = Math.min(prevLen, lo / 2);
      if (t > maxT) {
        t = maxT;
        r = t / Math.tan(th / 2);
      }
      const t1x = bx - ix * t, t1y = by - iy * t;
      const cr = ix * oy - iy * ox;
      const sgn = cr > 0 ? 1 : -1;
      const nX = sgn > 0 ? -iy : iy, nY = sgn > 0 ? ix : -ix;
      const ccx = t1x + nX * r, ccy = t1y + nY * r;
      p.line(cx, cy, t1x, t1y);
      p.push({ k: 1, cx: ccx, cy: ccy, r, a0: Math.atan2(t1y - ccy, t1x - ccx), da: sgn * th, len: r * th });
      cx = bx + ox * t;
      cy = by + oy * t;
    }
    return p;
  }

  line(x0: number, y0: number, x1: number, y1: number) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) return this;
    this.push({ k: 0, x0, y0, dx: (x1 - x0) / len, dy: (y1 - y0) / len, len });
    return this;
  }

  /** Pose at distance s (clamped to the path). */
  at(s: number, out: Pose): Pose {
    const segs = this.segs;
    if (!segs.length) return out;
    if (s < 0) s = 0;
    if (s > this.len) s = this.len;
    let i = segs.length - 1;
    // paths are short; a linear scan from the end is fine and usually exits early
    while (i > 0 && this.cum[i] > s) i--;
    const g = segs[i];
    const u = s - this.cum[i];
    if (g.k === 0) {
      out.x = g.x0 + g.dx * u;
      out.y = g.y0 + g.dy * u;
      out.hx = g.dx;
      out.hy = g.dy;
    } else {
      const a = g.a0 + g.da * (u / g.len);
      const c = Math.cos(a), sn = Math.sin(a);
      out.x = g.cx + c * g.r;
      out.y = g.cy + sn * g.r;
      if (g.da > 0) {
        out.hx = -sn;
        out.hy = c;
      } else {
        out.hx = sn;
        out.hy = -c;
      }
    }
    return out;
  }

  /** Distances where the path is inside an axis-aligned rectangle, as [enter, exit] pairs. */
  spans(x0: number, y0: number, x1: number, y1: number, step = 0.4): [number, number][] {
    const out: [number, number][] = [];
    const p: Pose = { x: 0, y: 0, hx: 1, hy: 0 };
    let inside = false, start = 0;
    for (let s = 0; s <= this.len + step; s += step) {
      const ss = Math.min(s, this.len);
      this.at(ss, p);
      const isIn = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      if (isIn && !inside) {
        inside = true;
        start = Math.max(0, ss - step);
      } else if (!isIn && inside) {
        inside = false;
        out.push([start, ss]);
      }
      if (ss >= this.len) break;
    }
    if (inside) out.push([start, this.len]);
    return out;
  }
}
