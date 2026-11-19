import { useEffect, useRef, type CSSProperties } from 'react';
import { ASPECT, DEFAULTS, Scene, type Fit } from './engine/scene';

export interface LivingCityProps {
  /** Colour theme. `auto` follows the visitor's light/dark preference. Default `light`. */
  theme?: 'light' | 'dark' | 'auto';
  /** Simulation speed, 1 = real time. Default 1. */
  speed?: number;
  /** How busy the streets are, from 0.3 (calm) to 1.5 (rush hour). Default 1. */
  density?: number;
  /** Seed for the random layout of people and traffic. Default 7. */
  seed?: number;
  /** `cover` fills the box and crops the edges (default); `contain` shows the whole scene. */
  fit?: Fit;
  /** Where to keep the focus when `cover` crops, as [x, y] from 0 to 1. Default [0.5, 0.5]. */
  focus?: [number, number];
  /** Extra zoom on top of the fit. Default 1. */
  zoom?: number;
  /** Freeze the scene on its current frame. */
  paused?: boolean;
  /** Cap on device pixel ratio, to trade sharpness for speed. Default 2. */
  maxDpr?: number;
  /** Hold still when the visitor asks for reduced motion. Default true. */
  respectReducedMotion?: boolean;
  /** Accessible description; the scene is decorative when omitted. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const mq = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);

/**
 * A self-running isometric city: cars and robotaxis drive, a semi gets loaded and leaves, a crane swings, and
 * humanoid robots walk and work among the people. Fills its container; give the container a size, or let it
 * keep the scene's own aspect ratio.
 */
export function LivingCity(props: LivingCityProps) {
  const {
    theme = 'light',
    speed = DEFAULTS.speed,
    density = DEFAULTS.density,
    seed = DEFAULTS.seed,
    fit = DEFAULTS.fit,
    focus,
    zoom = 1,
    paused = false,
    maxDpr = DEFAULTS.maxDpr,
    respectReducedMotion = true,
    label,
    className,
    style,
  } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene | null>(null);
  const env = useRef({ dark: false, reduced: false });

  const resolved = () => {
    const t = theme === 'auto' ? (env.current.dark ? 'dark' : 'light') : theme;
    return {
      theme: t as 'light' | 'dark',
      speed,
      density,
      seed,
      fit,
      focusX: focus?.[0] ?? 0.5,
      focusY: focus?.[1] ?? 0.5,
      zoom,
      maxDpr,
      paused: paused || (respectReducedMotion && env.current.reduced),
    };
  };

  // create once
  useEffect(() => {
    const el = wrap.current, cv = canvas.current;
    if (!el || !cv) return;
    const dark = mq('(prefers-color-scheme: dark)');
    const reduced = mq('(prefers-reduced-motion: reduce)');
    env.current = { dark: !!dark?.matches, reduced: !!reduced?.matches };
    let s: Scene;
    try {
      s = new Scene(cv, resolved());
    } catch {
      return;
    }
    scene.current = s;
    const rect = el.getBoundingClientRect();
    s.resize(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      s.resize(r.width, r.height);
    });
    ro.observe(el);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => s.setVisible(e[0].isIntersecting)) : null;
    io?.observe(el);
    const onDark = () => {
      env.current.dark = !!dark?.matches;
      s.set(resolved());
    };
    const onReduced = () => {
      env.current.reduced = !!reduced?.matches;
      s.set(resolved());
    };
    dark?.addEventListener?.('change', onDark);
    reduced?.addEventListener?.('change', onReduced);
    return () => {
      ro.disconnect();
      io?.disconnect();
      dark?.removeEventListener?.('change', onDark);
      reduced?.removeEventListener?.('change', onReduced);
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // follow prop changes
  useEffect(() => {
    scene.current?.set(resolved());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, speed, density, seed, fit, focus?.[0], focus?.[1], zoom, paused, maxDpr, respectReducedMotion]);

  return (
    <div
      ref={wrap}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ position: 'relative', width: '100%', aspectRatio: `${ASPECT}`, overflow: 'hidden', ...style }}
    >
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
