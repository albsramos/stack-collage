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
  const target = useRef({ spin: busy ? 1 : 0, fill: progress ?? 0 });
  target.current = { spin: busy ? 1 : 0, fill: progress ?? 0 };
  const aimRef = useRef(aim);
  aimRef.current = aim;
  useEffect(() => {
    if (!kick) return;
    reaction.current = pickReaction(lastKind.current);
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

    // Spin and fill ease toward their targets, so going busy (or finishing) is a glide, not a jump.
    const cur: Omit<OrbFrame, 't'> = { ...target.current, assemble: intro && !reduce.matches ? 0 : 1 };
    // The aim is smoothed as a vector, so the light swings the short way round.
    let ax = Math.cos(-Math.PI / 4);
    let ay = Math.sin(-Math.PI / 4);
    let aiming = false;
    let phase = 0; // the light's travel while spinning, and the dust's: accumulated, so direction can change
    let orbit = 0;
    let burst = 0;
    const t0 = performance.now();
    let last = t0;
    let raf = 0;
    let visible = true;

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = 1 - Math.exp(-dt * 4);
      // A reaction runs for its own length, then everything eases back to where the props say.
      let re = reaction.current;
      if (re && re.start === 0) {
        re.start = now;
        if (re.kind === 'reform') cur.assemble = Math.min(cur.assemble!, re.amount);
        if (re.kind === 'burst') burst = re.amount;
      }
      if (re && now - re.start > re.ms) re = reaction.current = null;
      const spinning = re?.kind === 'spin';
      const spinTo = spinning ? 1 : target.current.spin;
      cur.spin += (spinTo - cur.spin) * (spinning ? 1 - Math.exp(-dt * 12) : k);
      const dir = spinning ? re!.dir : 1;
      const speed = spinning ? re!.speed : 1;
      phase += dt * 2.2 * dir * speed;
      orbit += dt * 1.6 * dir * speed * cur.spin;
      cur.phase = phase;
      cur.orbit = orbit;
      burst *= Math.exp(-dt * 3.5);
      cur.burst = burst;
      if (cur.assemble! < 1) cur.assemble = Math.min(1, cur.assemble! + dt / (re?.kind === 'reform' ? 0.7 : 1.4));
      const flick = re?.kind === 'flick' ? re.angle : null;
      const want = flick ?? aimRef.current?.current;
      if (want != null) aiming = true;
      if (aiming) {
        const tx = Math.cos(want ?? -Math.PI / 4);
        const ty = Math.sin(want ?? -Math.PI / 4);
        const ka = 1 - Math.exp(-dt * 6);
        ax += (tx - ax) * ka;
        ay += (ty - ay) * ka;
        cur.aim = Math.atan2(ay, ax);
      }
      const fillTo = re?.kind === 'pulse' ? Math.max(target.current.fill, re.amount) : target.current.fill;
      cur.fill += (fillTo - cur.fill) * (1 - Math.exp(-dt * (re?.kind === 'pulse' ? 14 : 8)));
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
function pickReaction(last: Reaction['kind'] | null): Reaction {
  const options = KINDS.filter((k) => k !== last);
  const kind = options[Math.floor(Math.random() * options.length)];
  const base = { kind, start: 0, dir: (Math.random() < 0.5 ? 1 : -1) as 1 | -1, speed: 1, angle: 0, amount: 0 };
  switch (kind) {
    case 'spin':
      return { ...base, ms: rand(350, 650), speed: rand(0.9, 1.9) };
    case 'flick':
      return { ...base, ms: rand(380, 650), angle: rand(-Math.PI, Math.PI) };
    case 'pulse':
      return { ...base, ms: rand(220, 380), amount: rand(0.45, 0.8) };
    case 'burst':
      return { ...base, ms: 600, amount: rand(0.6, 1) };
    case 'reform':
      return { ...base, ms: 700, amount: rand(0.35, 0.6) };
  }
}
