// Runs the world on a canvas: camera fit, a cached ground layer (roads, markings, baked shadows), and the frame loop.

import type { R } from './draw';
import { darkPalette, lightPalette, type Palette } from './palette';
import { depthSort, type Item } from './sort';
import { Sprites } from './sprites';
import { BoxItem, type Static } from './statics';
import { buildWorld, type World } from './world';

export type Theme = 'light' | 'dark';
export type Fit = 'cover' | 'contain';

export interface SceneOptions {
  theme: Theme;
  /** simulation speed multiplier (1 = real time) */
  speed: number;
  /** how busy the scene is, 0.3 … 1.5 */
  density: number;
  seed: number;
  fit: Fit;
  /** focal point used when `cover` crops the scene, 0…1 on each axis */
  focusX: number;
  focusY: number;
  maxDpr: number;
  paused: boolean;
  /** extra zoom on top of the fit (1 = fit exactly) */
  zoom: number;
}

export const DEFAULTS: SceneOptions = {
  theme: 'light',
  speed: 1,
  density: 1,
  seed: 7,
  fit: 'cover',
  focusX: 0.5,
  focusY: 0.5,
  maxDpr: 2,
  paused: false,
  zoom: 1,
};

/** The composed view in design units; the scene was laid out to fill it. */
export const FRAME = { cx: 0, cy: 47.5, w: 121.2, h: 65 };
export const ASPECT = FRAME.w / FRAME.h;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

interface Baked {
  img: AnyCanvas | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class Scene {
  private opts: SceneOptions;
  private ctx: CanvasRenderingContext2D;
  private pal: Palette;
  private sprites: Sprites;
  private world!: World;
  private ground: AnyCanvas | null = null;
  private groundDirty = true;
  private cssW = 0;
  private cssH = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private view = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private raf = 0;
  private last = 0;
  private visible = true;
  private t = 0;
  private dyn: Item[] = [];
  private all: Item[] = [];
  private order: Item[] = [];
  private destroyed = false;

  constructor(private canvas: HTMLCanvasElement, opts: Partial<SceneOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('living-city: 2D canvas is not available');
    this.ctx = ctx;
    this.pal = this.opts.theme === 'dark' ? darkPalette() : lightPalette();
    this.sprites = new Sprites(this.pal, 1);
    this.rebuild();
  }

  /** Update options; rebuilds the world only when the theme, seed or density change. */
  set(opts: Partial<SceneOptions>) {
    const prev = this.opts;
    this.opts = { ...prev, ...opts };
    const o = this.opts;
    if (o.theme !== prev.theme) {
      this.pal = o.theme === 'dark' ? darkPalette() : lightPalette();
      this.rebuild();
    } else if (o.seed !== prev.seed || o.density !== prev.density) this.rebuild();
    if (o.fit !== prev.fit || o.focusX !== prev.focusX || o.focusY !== prev.focusY || o.maxDpr !== prev.maxDpr || o.zoom !== prev.zoom) this.layout();
    this.sync();
  }

  private rebuild() {
    this.sprites.reset(this.pal, this.scale);
    this.world = buildWorld(this.pal, this.sprites, { seed: this.opts.seed, density: this.opts.density });
    this.t = 0;
    // run the world for a while so the first frame is already busy
    for (let i = 0; i < 40 * 20; i++) this.step(1 / 20);
    this.groundDirty = true;
  }

  /** Tell the scene its size in CSS pixels. */
  resize(w: number, h: number) {
    this.cssW = Math.max(1, Math.round(w));
    this.cssH = Math.max(1, Math.round(h));
    this.layout();
    this.sync();
  }

  /** Pause drawing while the canvas is off screen. */
  setVisible(v: boolean) {
    this.visible = v;
    this.sync();
  }

  private layout() {
    const o = this.opts;
    const dpr = Math.min(o.maxDpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const W = this.cssW, H = this.cssH;
    const pw = Math.max(1, Math.round(W * dpr)), ph = Math.max(1, Math.round(H * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const zoom = (o.fit === 'cover' ? Math.max(W / FRAME.w, H / FRAME.h) : Math.min(W / FRAME.w, H / FRAME.h)) * o.zoom;
    const hw = W / (2 * zoom), hh = H / (2 * zoom);
    // when cropping, slide the view towards the focal point without leaving the frame
    const slackX = Math.max(0, FRAME.w / 2 - hw), slackY = Math.max(0, FRAME.h / 2 - hh);
    const cx = FRAME.cx + (o.focusX - 0.5) * 2 * slackX;
    const cy = FRAME.cy + (o.focusY - 0.5) * 2 * slackY;
    this.scale = zoom * dpr;
    // whole-pixel offsets keep baked bitmaps aligned to the device grid
    this.tx = Math.round(pw / 2 - cx * this.scale);
    this.ty = Math.round(ph / 2 - cy * this.scale);
    this.view = { x0: cx - hw - 2, y0: cy - hh - 2, x1: cx + hw + 2, y1: cy + hh + 2 };
    this.sprites.reset(this.pal, this.scale);
    this.baked = new WeakMap();
    this.groundDirty = true;
  }

  private baked = new WeakMap<Item, Baked>();

  /** Render an unchanging item once into a bitmap aligned to device pixels (cropped to the view), then stamp it. */
  private stamp(it: Static, r: R) {
    let b = this.baked.get(it);
    if (!b) {
      b = this.bake(it);
      this.baked.set(it, b);
    }
    if (b.img) r.ctx.drawImage(b.img as CanvasImageSource, b.x, b.y, b.w, b.h);
  }

  private bake(it: Static): Baked {
    const k = this.scale, v = this.view;
    const C = 0.8660254037844386;
    // screen bounds of the box, with room for anti-aliasing and edge highlights
    const sx0 = Math.max(v.x0, (it.x0 - it.y1) * C - 0.3), sx1 = Math.min(v.x1, (it.x1 - it.y0) * C + 0.3);
    const sy0 = Math.max(v.y0, (it.x0 + it.y0) * 0.5 - it.z1 - 0.3), sy1 = Math.min(v.y1, (it.x1 + it.y1) * 0.5 - it.z0 + 0.3);
    const px0 = Math.floor(sx0 * k + this.tx), px1 = Math.ceil(sx1 * k + this.tx);
    const py0 = Math.floor(sy0 * k + this.ty), py1 = Math.ceil(sy1 * k + this.ty);
    const W = px1 - px0, H = py1 - py0;
    if (W <= 0 || H <= 0) return { img: null, x: 0, y: 0, w: 0, h: 0 };
    const img = makeCanvas(W, H);
    const g = img.getContext('2d') as CanvasRenderingContext2D;
    g.setTransform(k, 0, 0, k, this.tx - px0, this.ty - py0);
    it.draw({ ctx: g, t: 0, hair: 0.7 / k, scale: k, night: this.pal.night });
    return { img, x: (px0 - this.tx) / k, y: (py0 - this.ty) / k, w: W / k, h: H / k };
  }

  private sync() {
    if (this.destroyed || !this.cssW) return;
    const run = !this.opts.paused && this.visible;
    if (run && !this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.loop);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (!run) this.render();
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    let rem = dt * this.opts.speed;
    while (rem > 1e-6) {
      const h = Math.min(rem, 1 / 30);
      this.step(h);
      rem -= h;
    }
    this.render();
  };

  private step(dt: number) {
    this.t += dt;
    this.world.update(dt);
  }

  private renderGround() {
    const c = this.canvas;
    if (!this.ground || this.ground.width !== c.width || this.ground.height !== c.height) this.ground = makeCanvas(c.width, c.height);
    const g = this.ground.getContext('2d') as CanvasRenderingContext2D;
    const pal = this.pal;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = pal.ground;
    g.fillRect(0, 0, c.width, c.height);
    g.setTransform(this.scale, 0, 0, this.scale, this.tx, this.ty);
    const r = this.r(g);
    this.world.ground(g, r);
    // soft contact shadows around building bases, then cast shadows; both blurred via the offset-shadow trick
    // the shapes themselves are drawn this far to the left, off the canvas, and only their blurred shadow is shifted
    // back; it must clear every shape in the world, not just the view
    let minX = Infinity, maxX = -Infinity;
    for (const s of this.world.statics) {
      minX = Math.min(minX, (s.x0 - s.y1) * 0.8660254);
      maxX = Math.max(maxX, (s.x1 - s.y0) * 0.8660254);
    }
    const off = Math.max(maxX, this.view.x1) - Math.min(minX, this.view.x0) + 60;
    const blurred = (color: string, blur: number, build: () => void) => {
      g.save();
      g.translate(-off, 0);
      g.beginPath();
      build();
      g.shadowColor = color;
      g.shadowBlur = blur * this.scale;
      g.shadowOffsetX = off * this.scale;
      g.fillStyle = '#000';
      g.fill();
      g.restore();
    };
    blurred(pal.ao, 1.6, () => {
      for (const s of this.world.statics) {
        if (!(s instanceof BoxItem) || s.z0 > 0.01 || s.z1 < 1.5) continue;
        if ((s.x1 - s.x0) * (s.y1 - s.y0) < 3) continue;
        const X = [s.x0 + 0.1, s.x1 - 0.1], Y = [s.y0 + 0.1, s.y1 - 0.1];
        g.moveTo((X[0] - Y[0]) * 0.8660254, (X[0] + Y[0]) * 0.5);
        g.lineTo((X[1] - Y[0]) * 0.8660254, (X[1] + Y[0]) * 0.5);
        g.lineTo((X[1] - Y[1]) * 0.8660254, (X[1] + Y[1]) * 0.5);
        g.lineTo((X[0] - Y[1]) * 0.8660254, (X[0] + Y[1]) * 0.5);
        g.closePath();
      }
    });
    blurred(pal.shadow, 0.35, () => {
      for (const s of this.world.statics) s.shadow?.(g);
    });
    this.groundDirty = false;
  }

  private r(ctx: CanvasRenderingContext2D): R {
    return { ctx, t: this.t, hair: 0.7 / this.scale, scale: this.scale, night: this.pal.night };
  }

  render() {
    if (!this.cssW) return;
    if (this.groundDirty) this.renderGround();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.ground as CanvasImageSource, 0, 0);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.tx, this.ty);
    const r = this.r(ctx);
    // moving shadows, all in one fill so overlaps don't darken
    ctx.beginPath();
    this.world.shadows(ctx);
    ctx.fillStyle = this.pal.shadow;
    ctx.fill();
    // everything standing up, back to front
    this.dyn.length = 0;
    this.world.items(this.dyn);
    const all = this.all;
    all.length = 0;
    for (const s of this.world.statics) all.push(s);
    for (const d of this.dyn) all.push(d);
    depthSort(all, this.order, this.view.x0, this.view.y0, this.view.x1, this.view.y1);
    for (const it of this.order) {
      const s = it as Static;
      if (s.bake) this.stamp(s, r);
      else it.draw(r);
      s.overlay?.(r);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
