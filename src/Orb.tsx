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
  /** Change this number to make the orb react. Each reaction is picked at random, so it differs every time. */
  kick?: number;
}

/** The live Stack orb. Colour comes from CSS (`color`, via --orb), so it follows the theme. */
export function Orb({ size, grid = 32, busy = false, progress = null, className, intro, aim, kick }: OrbProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reaction = useRef<Reaction | null>(null);
  const lastKind = useRef<Reaction['kind'] | null>(null);
  const lastKickAt = useRef(0);
  const target = useRef({ spin: busy ? 1 : 0, fill: progress ?? 0 });
  target.current = { spin: busy ? 1 : 0, fill: progress ?? 0 };
  const aimRef = useRef(aim);
  aimRef.current = aim;
  useEffect(() => {
    if (!kick) return;
    // Tapping fast: pick only the reactions that blend well, and make each a little gentler.
    const now = performance.now();
    const rapid = now - lastKickAt.current < 400;
    lastKickAt.current = now;
    reaction.current = pickReaction(lastKind.current, rapid);
    lastKind.current = reaction.current.kind;
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

    // Everything is integrated, never set: the light has one angle and one speed, both eased, so reactions that
    // arrive mid-way (someone tapping fast) blend into each other instead of jumping.
    const BASE = -Math.PI / 4;
    const cur = { spin: target.current.spin, fill: target.current.fill, assemble: intro && !reduce.matches ? 0 : 1 };
    let angle = BASE;
    let vel = 0; // rad/s
    let orbit = 0;
    let twinkle = 0;
    let burst = 0;
    const t0 = performance.now();
    let last = t0;
    let raf = 0;
    let visible = true;
    const ease = (rate: number, dt: number) => 1 - Math.exp(-dt * rate);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      let re = reaction.current;
      if (re && re.start === 0) re.start = now;
      if (re && now - re.start > re.ms) re = reaction.current = null;
      const age = re ? now - re.start : 0;
      const busyNow = target.current.spin > 0;
      const spinning = re?.kind === 'spin';

      // Light: spin by speeding up, otherwise drift back to where it should rest (the finger, a flick, the sway).
      const velTo = busyNow ? 2.2 : spinning ? 2.2 * re!.dir * re!.speed : 0;
      vel += (velTo - vel) * ease(6, dt);
      angle += vel * dt;
      if (velTo === 0) {
        const restAt = (re?.kind === 'flick' ? re.angle : null) ?? aimRef.current?.current ?? BASE + Math.sin(t * 0.6) * 0.18;
        angle += wrap(restAt - angle) * ease(re?.kind === 'flick' ? 9 : 5, dt);
      }
      cur.spin += ((busyNow || spinning ? 1 : 0) - cur.spin) * ease(6, dt);
      orbit += vel * dt * 0.73;
      twinkle += dt * (2 + cur.spin * 4);

      // Burst: the dust swells out over a beat, then settles.
      if (re?.kind === 'burst' && age < 160) burst += (re.amount - burst) * ease(16, dt);
      else burst *= Math.exp(-dt * 3.5);

      // Re-form: scatter part way, softly, then pull back together.
      if (re?.kind === 'reform' && age < 220) cur.assemble += (re.amount - cur.assemble) * ease(9, dt);
      else if (cur.assemble < 1) cur.assemble = Math.min(1, cur.assemble + dt / (intro && t < 1.5 ? 1.4 : 0.55));

      const fillTo = re?.kind === 'pulse' && age < re.ms * 0.5 ? Math.max(target.current.fill, re.amount) : target.current.fill;
      cur.fill += (fillTo - cur.fill) * ease(re?.kind === 'pulse' ? 12 : 8, dt);

      drawOrb(ctx, px, grid, color, { t, spin: cur.spin, fill: cur.fill, assemble: cur.assemble, light: angle, orbit, twinkle, burst });
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

interface Reaction {
  kind: 'spin' | 'flick' | 'pulse' | 'burst' | 'reform';
  /** performance.now() when it began; 0 until the next frame picks it up. */
  start: number;
  ms: number;
  /** spin: which way round, and how fast */
  dir: 1 | -1;
  speed: number;
  /** flick: where the light jumps to */
  angle: number;
  /** pulse: how solid it gets; burst: how far the dust flies; reform: how scattered it gets (lower = more) */
  amount: number;
}

const KINDS: Reaction['kind'][] = ['spin', 'flick', 'pulse', 'burst', 'reform'];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A random reaction, never the same kind twice in a row, with its own strength, direction and length. */
function pickReaction(last: Reaction['kind'] | null, rapid: boolean): Reaction {
  // Scattering the whole sphere over and over reads as noise, so rapid taps skip it.
  const options = KINDS.filter((k) => k !== last && !(rapid && k === 'reform'));
  const kind = options[Math.floor(Math.random() * options.length)];
  const soft = rapid ? 0.65 : 1;
  const base = { kind, start: 0, dir: (Math.random() < 0.5 ? 1 : -1) as 1 | -1, speed: 1, angle: 0, amount: 0 };
  switch (kind) {
    case 'spin':
      return { ...base, ms: rand(350, 650), speed: rand(0.9, 1.9) * soft };
    case 'flick':
      return { ...base, ms: rand(380, 650), angle: rand(-Math.PI, Math.PI) };
    case 'pulse':
      return { ...base, ms: rand(220, 380), amount: rand(0.45, 0.8) * soft };
    case 'burst':
      return { ...base, ms: 600, amount: rand(0.6, 1) * soft };
    case 'reform':
      return { ...base, ms: 700, amount: rand(0.35, 0.6) };
  }
}
