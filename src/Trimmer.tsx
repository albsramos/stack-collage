import { useEffect, useRef, useState } from 'react';
import { clamp } from './layout';
import type { Media } from './media';
import { importFresh } from './stale';
import { TRIM_MIN, TRIM_STEP, trimOf, type Trim } from './trim';

const FRAMES = 8; // thumbnails across the filmstrip
const PAD = 14; // room each side for a handle sitting outside the kept window

// ---------- filmstrip thumbnails ----------
// Decoded once per clip with mediabunny (already loaded for any video) and kept for as long as the clip is.
const thumbCache = new WeakMap<Media, Promise<HTMLCanvasElement[]>>();

function thumbnails(m: Media): Promise<HTMLCanvasElement[]> {
  let p = thumbCache.get(m);
  if (!p) {
    p = (async () => {
      const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await importFresh(() => import('mediabunny'));
      const input = new Input({ source: new BlobSource(m.file), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) return [];
        const h = 96; // 2× the strip's 48px
        const sink = new CanvasSink(track, { height: h, width: Math.round((h * m.w) / m.h), fit: 'cover', poolSize: 0 });
        const times = Array.from({ length: FRAMES }, (_, i) => m.start + ((i + 0.5) / FRAMES) * m.duration);
        const out: HTMLCanvasElement[] = [];
        for await (const w of sink.canvasesAtTimestamps(times)) {
          if (w) out.push(w.canvas as HTMLCanvasElement);
        }
        return out;
      } finally {
        input.dispose?.();
      }
    })();
    p.catch(() => thumbCache.delete(m)); // let a later open try again
    thumbCache.set(m, p);
  }
  return p;
}

const fmt = (t: number) => `${t.toFixed(1)}s`;
const snap = (t: number) => Math.round(t / TRIM_STEP) * TRIM_STEP;

interface Props {
  media: Media;
  trim?: Trim;
  onChange: (t: Trim | undefined) => void;
  /** Seconds into the clip to show while a handle is dragged; null when the drag ends. */
  onScrub: (t: number | null) => void;
  onDone: () => void;
}

/**
 * Trim a video: a filmstrip with a start and an end handle. Dragging the window between them slides it without
 * changing its length. Fills the panel's two rows: the strip, then the times with Reset and Done.
 */
export function Trimmer({ media: m, trim, onChange, onScrub, onDone }: Props) {
  const D = m.duration;
  const r = trimOf(m, trim);
  const strip = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'in' | 'out' | 'win'; offset: number; len: number } | null>(null);
  const [active, setActive] = useState<'in' | 'out' | 'win' | null>(null);
  const rRef = useRef(r);
  rRef.current = r;

  const commit = (t: Trim) => onChange(t.in <= 0.001 && t.out >= D - 0.001 ? undefined : t);

  // Draw the filmstrip once its frames are decoded, and again if the panel changes width.
  useEffect(() => {
    let frames: HTMLCanvasElement[] = [];
    let alive = true;
    const draw = () => {
      const c = canvas.current;
      if (!c || !frames.length) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      c.width = Math.max(1, Math.round(c.clientWidth * dpr));
      c.height = Math.max(1, Math.round(c.clientHeight * dpr));
      const ctx = c.getContext('2d')!;
      const w = c.width / frames.length;
      frames.forEach((f, i) => {
        // cover each cell
        const s = Math.max(w / f.width, c.height / f.height);
        const fw = f.width * s;
        const fh = f.height * s;
        ctx.save();
        ctx.beginPath();
        ctx.rect(i * w, 0, w, c.height);
        ctx.clip();
        ctx.drawImage(f, i * w + (w - fw) / 2, (c.height - fh) / 2, fw, fh);
        ctx.restore();
      });
    };
    thumbnails(m)
      .then((f) => {
        if (!alive) return;
        frames = f;
        draw();
      })
      .catch((e) => console.warn('Could not make the filmstrip', e)); // the trimmer still works on a blank strip
    const ro = new ResizeObserver(draw);
    if (canvas.current) ro.observe(canvas.current);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [m]);

  // Playhead: follow the slot's own <video>, so it shows exactly what's playing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = document.querySelector<HTMLVideoElement>(`.slot video[data-media-id="${m.id}"]`);
      const h = head.current;
      if (v && h) {
        const t = clamp(v.currentTime - m.start, 0, D);
        h.style.left = `calc(${PAD}px + (100% - ${PAD * 2}px) * ${t / D})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [m, D]);

  const timeAt = (clientX: number) => {
    const b = strip.current!.getBoundingClientRect();
    return ((clientX - b.left - PAD) / (b.width - PAD * 2)) * D;
  };

  const onPointerDown = (kind: 'in' | 'out' | 'win') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const cur = rRef.current;
    drag.current = { kind, offset: timeAt(e.clientX) - cur.in, len: cur.out - cur.in };
    setActive(kind);
    onScrub(kind === 'out' ? cur.out : cur.in);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    const cur = rRef.current;
    let next: Trim;
    if (d.kind === 'in') next = { in: clamp(snap(t), 0, cur.out - TRIM_MIN), out: cur.out };
    else if (d.kind === 'out') next = { in: cur.in, out: clamp(snap(t), cur.in + TRIM_MIN, D) };
    else {
      const start = clamp(snap(t - d.offset), 0, D - d.len);
      next = { in: start, out: Math.min(D, start + d.len) };
    }
    rRef.current = next; // successive moves can arrive before React re-renders
    commit(next);
    onScrub(d.kind === 'out' ? next.out : next.in);
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(null);
    onScrub(null);
  };
  const handlers = (kind: 'in' | 'out' | 'win') => ({
    onPointerDown: onPointerDown(kind),
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
  });

  const onKeyDown = (which: 'in' | 'out') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : TRIM_STEP;
    const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    if (which === 'in') commit({ in: clamp(snap(r.in + dir * step), 0, r.out - TRIM_MIN), out: r.out });
    else commit({ in: r.in, out: clamp(snap(r.out + dir * step), r.in + TRIM_MIN, D) });
  };

  const at = (t: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${t / D})`;
  const span = (a: number, b: number) => `calc((100% - ${PAD * 2}px) * ${(b - a) / D})`;

  return (
    <>
      <div className="slot-a">
        <div className="trim-strip" ref={strip}>
          <canvas ref={canvas} className="trim-film" aria-hidden="true" />
          <div className="trim-shade" style={{ left: PAD, width: span(0, r.in) }} />
          <div className="trim-shade" style={{ left: at(r.out), width: span(r.out, D) }} />
          <div className="trim-window" style={{ left: at(r.in), width: span(r.in, r.out) }} {...handlers('win')} />
          <div
            className="trim-handle in"
            style={{ left: at(r.in) }}
            role="slider"
            tabIndex={0}
            aria-label="Clip start"
            aria-valuemin={0}
            aria-valuemax={+D.toFixed(1)}
            aria-valuenow={+r.in.toFixed(1)}
            aria-valuetext={`Starts at ${r.in.toFixed(1)} seconds`}
            onKeyDown={onKeyDown('in')}
            {...handlers('in')}
          />
          <div
            className="trim-handle out"
            style={{ left: at(r.out) }}
            role="slider"
            tabIndex={0}
            aria-label="Clip end"
            aria-valuemin={0}
            aria-valuemax={+D.toFixed(1)}
            aria-valuenow={+r.out.toFixed(1)}
            aria-valuetext={`Ends at ${r.out.toFixed(1)} seconds`}
            onKeyDown={onKeyDown('out')}
            {...handlers('out')}
          />
          <div className="trim-head" ref={head} aria-hidden="true" />
        </div>
      </div>
      <div className="slot-b">
        <span className="trim-readout" aria-live="polite">
          <span className={active === 'in' || active === 'win' ? 'on' : undefined}>{fmt(r.in)}</span> –{' '}
          <span className={active === 'out' || active === 'win' ? 'on' : undefined}>{fmt(r.out)}</span> ·{' '}
          <b>{fmt(r.out - r.in)}</b>
        </span>
        <button className="icon-btn" aria-label="Use the whole clip" disabled={!trim} onClick={() => onChange(undefined)}>
          <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8M3 3v5h5" />
          </svg>
        </button>
        <button className="primary done" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}
