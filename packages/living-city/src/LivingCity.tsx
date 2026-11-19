import { useEffect, useRef, type CSSProperties } from 'react';
import { ASPECT, DEFAULTS, Scene, type Fit, type SceneOptions } from './engine/scene';
import { resolveTheme, watchTheme, type ThemeChoice } from './theme';

export interface LivingCityProps {
  /**
   * `auto` (default) matches the page: a `data-theme="dark"` (or `data-bs-theme`, `data-color-scheme`, …) on an
   * ancestor, a `dark` class on <html> or <body>, or else the system setting, and follows it when it changes.
   * `light` and `dark` force one look.
   */
  theme?: ThemeChoice;
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

/** Ground colour of each theme, shown before the first frame so the box never flashes the wrong colour. */
const GROUND = { light: '#ebebef', dark: '#1b1c21' };

const reducedQuery = () =>
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/**
 * A self-running isometric city: cars and robotaxis drive, a semi gets loaded and leaves, a crane swings, and
 * humanoid robots walk and work among the people. Fills its container; give the container a size, or let it
 * keep the scene's own aspect ratio.
 */
export function LivingCity(props: LivingCityProps) {
  const { theme = 'auto', focus, label, className, style } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const reduced = useRef(false);

  /** Scene options from the latest props and the page around us. */
  const options = (): Partial<SceneOptions> => {
    const p = latest.current;
    const choice = p.theme ?? 'auto';
    return {
      theme: choice === 'auto' ? resolveTheme(wrap.current) : choice,
      speed: p.speed ?? DEFAULTS.speed,
      density: p.density ?? DEFAULTS.density,
      seed: p.seed ?? DEFAULTS.seed,
      fit: p.fit ?? DEFAULTS.fit,
      focusX: p.focus?.[0] ?? 0.5,
      focusY: p.focus?.[1] ?? 0.5,
      zoom: p.zoom ?? 1,
      maxDpr: p.maxDpr ?? DEFAULTS.maxDpr,
      paused: !!p.paused || ((p.respectReducedMotion ?? true) && reduced.current),
    };
  };

  const apply = () => {
    const o = options();
    scene.current?.set(o);
    if (wrap.current) wrap.current.style.backgroundColor = GROUND[o.theme ?? 'light'];
  };

  // create once
  useEffect(() => {
    const el = wrap.current, cv = canvas.current;
    if (!el || !cv) return;
    const rm = reducedQuery();
    reduced.current = !!rm?.matches;
    let s: Scene;
    try {
      s = new Scene(cv, options());
    } catch {
      return;
    }
    scene.current = s;
    apply();
    const rect = el.getBoundingClientRect();
    s.resize(rect.width, rect.height);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      s.resize(r.width, r.height);
    });
    ro.observe(el);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => s.setVisible(e[0].isIntersecting)) : null;
    io?.observe(el);
    const unwatch = watchTheme(el, apply);
    const onReduced = () => {
      reduced.current = !!rm?.matches;
      apply();
    };
    rm?.addEventListener?.('change', onReduced);
    return () => {
      ro.disconnect();
      io?.disconnect();
      unwatch();
      rm?.removeEventListener?.('change', onReduced);
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // follow prop changes
  useEffect(apply, [theme, props.speed, props.density, props.seed, props.fit, focus?.[0], focus?.[1], props.zoom, props.paused, props.maxDpr, props.respectReducedMotion]);

  return (
    <div
      ref={wrap}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${ASPECT}`,
        overflow: 'hidden',
        backgroundColor: theme === 'dark' ? GROUND.dark : GROUND.light,
        ...style,
      }}
    >
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
