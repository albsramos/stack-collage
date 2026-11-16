import { useEffect, useRef } from 'react';
import { drawOrb, type OrbFrame } from './orb';

interface OrbProps {
  /** CSS pixels. */
  size: number;
  /** Cells across. Fewer reads as chunkier pixels; keep cells ≥ ~2px. */
  grid?: number;
  /** The light circles and the dust orbits while true. */
  busy?: boolean;
  /** 0–1 for work with a known length: the sphere fills in as it rises. */
  progress?: number | null;
  className?: string;
}

/** The live Stack orb. Colour comes from CSS (`color`, via --orb), so it follows the theme. */
export function Orb({ size, grid = 32, busy = false, progress = null, className }: OrbProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef({ spin: busy ? 1 : 0, fill: progress ?? 0 });
  target.current = { spin: busy ? 1 : 0, fill: progress ?? 0 };

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    let color = getComputedStyle(canvas).color;
    const recolor = () => {
      color = getComputedStyle(canvas).color;
    };
    scheme.addEventListener('change', recolor);

    // Spin and fill ease toward their targets, so going busy (or finishing) is a glide, not a jump.
    const cur: Omit<OrbFrame, 't'> = { ...target.current };
    const t0 = performance.now();
    let last = t0;
    let raf = 0;
    let visible = true;

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-dt * 4);
      cur.spin += (target.current.spin - cur.spin) * k;
      cur.fill += (target.current.fill - cur.fill) * (1 - Math.exp(-dt * 8));
      drawOrb(ctx, px, grid, color, { t: (now - t0) / 1000, ...cur });
      if (!reduce.matches && visible) raf = requestAnimationFrame(frame);
    };
    const restart = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    // Don't burn frames for an orb nobody can see.
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) restart();
    });
    io.observe(canvas);
    reduce.addEventListener('change', restart);
    restart();

    // Under reduced motion there's no loop: redraw when the inputs change instead (see the effect below).
    (canvas as HTMLCanvasElement & { __redraw?: () => void }).__redraw = () => {
      if (!reduce.matches) return;
      cur.spin = 0; // the light stays put; progress still shows as fill
      cur.fill = target.current.fill;
      drawOrb(ctx, px, grid, color, { t: 0, ...cur });
    };

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      reduce.removeEventListener('change', restart);
      scheme.removeEventListener('change', recolor);
    };
  }, [size, grid]);

  useEffect(() => {
    (ref.current as (HTMLCanvasElement & { __redraw?: () => void }) | null)?.__redraw?.();
  }, [busy, progress]);

  return (
    <canvas
      ref={ref}
      className={className ? `orb ${className}` : 'orb'}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
