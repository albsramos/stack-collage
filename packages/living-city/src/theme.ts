// Working out whether the page around the scene is light or dark, and noticing when that changes.

export type ThemeChoice = 'light' | 'dark' | 'auto';

/** Attributes theme switchers commonly put on <html>, <body> or a wrapper, with "dark" or "light" as the value. */
const ATTRS = ['data-theme', 'data-color-scheme', 'data-bs-theme', 'data-mode', 'data-mantine-color-scheme'];
const SELECTOR = ATTRS.map((a) => `[${a}]`).join(',');

function fromAttrs(el: Element): 'light' | 'dark' | null {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v === 'dark' || v === 'light') return v;
  }
  return null;
}

function fromClass(el: Element | null): 'light' | 'dark' | null {
  if (!el) return null;
  if (el.classList.contains('dark')) return 'dark';
  if (el.classList.contains('light')) return 'light';
  return null;
}

/**
 * The theme the page shows around `el`: the nearest ancestor with a theme attribute (`data-theme="dark"` and
 * friends), then a `dark` / `light` class on <html> or <body> (Tailwind, next-themes), then the system setting.
 */
export function resolveTheme(el?: Element | null): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'light';
  for (let p: Element | null = el?.closest(SELECTOR) ?? null; p; p = p.parentElement?.closest(SELECTOR) ?? null) {
    const v = fromAttrs(p);
    if (v) return v;
  }
  const root = document.documentElement;
  const v = fromAttrs(root) ?? fromClass(root) ?? fromClass(document.body);
  if (v) return v;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Call `onChange` whenever the theme around `el` might have changed. Returns a function that stops watching. */
export function watchTheme(el: Element, onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', onChange);
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(onChange) : null;
  const targets = new Set<Element>([document.documentElement]);
  if (document.body) targets.add(document.body);
  for (let p = el.parentElement; p; p = p.parentElement) if (ATTRS.some((a) => p.hasAttribute(a))) targets.add(p);
  for (const t of targets) mo?.observe(t, { attributes: true, attributeFilter: [...ATTRS, 'class'] });
  return () => {
    mq?.removeEventListener?.('change', onChange);
    mo?.disconnect();
  };
}
