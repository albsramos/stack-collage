import { useEffect, useRef } from 'react';
import { BAYER } from './orb';
import { ditherTo } from './dither';
import { computeSlots, mediaRect, type Format, type LayoutOpts } from './layout';
import type { SlotState } from './exporter';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A still of the collage as it looks in the editor, drawn from the preview's own <img>/<video> elements. */
export function snapshot(format: Format, layout: LayoutOpts, slots: SlotState[], w: number): HTMLCanvasElement {
  const k = w / format.w;
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(format.h * k);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  const rects = computeSlots(format, layout);
  slots.forEach((s, i) => {
    const el = document.querySelector(`[data-slot="${i}"]`)?.parentElement?.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
    if (!s.media || !el) return;
    const r = { x: rects[i].x * k, y: rects[i].y * k, w: rects[i].w * k, h: rects[i].h * k };
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, layout.radius * k);
    ctx.clip();
    const d = mediaRect(r, s.media.w, s.media.h, s.t);
    try {
      ctx.drawImage(el, d.x, d.y, d.w, d.h);
    } catch {
      // a video that hasn't decoded a frame yet: leave the slot black
    }
    ctx.restore();
  });
  return c;
}

/**
 * A thumbnail of the collage. `reveal` < 1 assembles it dot by dot, in its own colours, in the orb's ordered
 * pattern (the export screen); at 1 it's the picture itself.
 */
export function LookPreview(p: { source: HTMLCanvasElement; width: number; reveal?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = (p.width * p.source.height) / p.source.width;
  const reveal = p.reveal ?? 1;
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = Math.round(p.width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    if (reveal >= 1) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(p.source, 0, 0, c.width, c.height);
    } else {
      ditherTo(ctx, p.source, c.width, c.height, 'dots', c.width / 44, reveal);
    }
  }, [p.source, p.width, height, reveal]);
  return <canvas ref={ref} className="look-preview" style={{ width: p.width, height }} aria-hidden="true" />;
}

/** The empty-slot texture: a faint field of the orb's dots, drifting slowly like light over a surface. */
export function DitherField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const CELL = 9; // css px between dots
    let cols = 0;
    let rows = 0;
    let dpr = 1;
    let color = '';
    const ro = new ResizeObserver(([e]) => {
      dpr = Math.min(3, window.devicePixelRatio || 1);
      const { width, height } = e.contentRect;
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      cols = Math.ceil(width / CELL);
      rows = Math.ceil(height / CELL);
      color = getComputedStyle(c).color;
      draw(performance.now());
    });
    ro.observe(c);
    const seed = Math.random() * 100;
    const draw = (now: number) => {
      const t = now / 1000 + seed;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = color;
      const s = CELL * dpr;
      const d = Math.max(1, Math.round(1.6 * dpr));
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          // two slow waves crossing: soft bright patches that wander
          const v = 0.5 + 0.5 * Math.sin(i * 0.33 + t * 0.7) * Math.cos(j * 0.27 - t * 0.5);
          const I = 0.1 + v * 0.55;
          if (I > (BAYER[(j % 8) * 8 + (i % 8)] + 0.5) / 64) ctx.fillRect(Math.round(i * s + s / 2 - d / 2), Math.round(j * s + s / 2 - d / 2), d, d);
        }
      }
    };
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (now - last > 66) {
        last = now;
        draw(now);
      }
      raf = requestAnimationFrame(loop);
    };
    if (!reduced()) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return <canvas ref={ref} className="dither-field" aria-hidden="true" />;
}
