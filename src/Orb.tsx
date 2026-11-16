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
  /** Play the intro: the dots fly in and settle (skipped under reduced motion). */
  intro?: boolean;
  /** Where the light should come from, as a screen angle; null = resting sway. Read every frame, so pass a ref. */
  aim?: React.RefObject<number | null>;
  /** Change this number to make the orb react: a short spin. */
  kick?: number;
}

/** The live Stack orb. Colour comes from CSS (`color`, via --orb), so it follows the theme. */
export function Orb({ size, grid = 32, busy = false, progress = null, className, intro, aim, kick }: OrbProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kickUntil = useRef(0);
  const target = useRef({ spin: busy ? 1 : 0, fill: progress ?? 0 });
  target.current = { spin: busy ? 1 : 0, fill: progress ?? 0 };
  const aimRef = useRef(aim);
  aimRef.current = aim;
  useEffect(() => {
    if (kick) kickUntil.current = performance.now() + 450;
  }, [kick]);

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
    const cur: Omit<OrbFrame, 't'> = { ...target.current, assemble: intro && !reduce.matches ? 0 : 1 };
    // The aim is smoothed as a vector, so the light swings the short way round.
    let ax = Math.cos(-Math.PI / 4);
    let ay = Math.sin(-Math.PI / 4);
    let aiming = false;
    const t0 = performance.now();
    let last = t0;
    let raf = 0;
    let visible = true;

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-dt * 4);
      const spinTo = now < kickUntil.current ? 1 : target.current.spin;
      cur.spin += (spinTo - cur.spin) * (spinTo > cur.spin && now < kickUntil.current ? 1 - Math.exp(-dt * 12) : k);
      if (cur.assemble! < 1) cur.assemble = Math.min(1, cur.assemble! + dt / 1.4);
      const want = aimRef.current?.current;
      if (want != null) aiming = true;
      if (aiming) {
        const tx = Math.cos(want ?? -Math.PI / 4);
        const ty = Math.sin(want ?? -Math.PI / 4);
        const ka = 1 - Math.exp(-dt * 6);
        ax += (tx - ax) * ka;
        ay += (ty - ay) * ka;
        cur.aim = Math.atan2(ay, ax);
      }
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
